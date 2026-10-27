import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { Config } from './config/schema.js';
import { parseCommentableLines } from './github/diff.js';
import type { Gh } from './github/gh.js';
import {
  buildReviewPayload,
  findPostedReview,
  isDefiniteRejection,
  postReview,
  reviewMarker,
  type ReviewEvent,
  type ReviewPayload,
} from './github/post-review.js';
import {
  extractPrRefs,
  fetchPr,
  fetchDiffForComments,
  isRepoAllowed,
  prSlug,
  type PrInfo,
  fetchMergeBase,
  ownerApprovedHead,
  type PrRef,
} from './github/pr.js';
import { errorMessage } from './lib/errors.js';
import { createKeyedLock } from './lib/keyed-lock.js';
import { findSecretLike } from './lib/secrets.js';
import type { Logger } from './lib/logger.js';
import { classify, decideEvent, planReview, type PostMode } from './review/decision.js';
import type { ReviewOutcome } from './review/run-review.js';
import {
  ACTIONS,
  escapeMrkdwn,
  notificationBlocks,
  notificationText,
  postedOutcome,
  resolvedBlocks,
  staleBlocks,
  type Verdict,
} from './slack/blocks.js';
import type { SlackPort } from './slack/port.js';
import type { ReviewRecord, ReviewStore, SlackLocation } from './store/reviews.js';

export type ReviewFn = (
  ref: PrRef,
  reviewId: string,
  opts: { pr: PrInfo; signal: AbortSignal },
) => Promise<ReviewOutcome>;

export interface ServiceDeps {
  readonly config: Config;
  readonly slack: SlackPort;
  readonly gh: Gh;
  readonly store: ReviewStore;
  readonly review: ReviewFn;
  readonly logger: Logger;
}

export interface IncomingMessage {
  readonly channel: string;
  readonly ts: string;
  readonly user?: string;
  readonly text?: string;
  readonly subtype?: string;
  readonly botId?: string;
}

export interface IncomingAction {
  readonly actionId: string;
  /** Button value: `<reviewId>:<notificationNonce>`. */
  readonly value: string;
  readonly userId: string;
  readonly channel?: string;
}

export interface Service {
  handleMessage(msg: IncomingMessage): Promise<void>;
  handleAction(action: IncomingAction): Promise<void>;
  /** Re-queues reviews left unfinished by a crash or restart. */
  resumeInterrupted(): Promise<void>;
  /** Stops running reviews (they resume on next start) and waits for the queue to settle. */
  shutdown(): Promise<void>;
  /** Resolves when no review is queued or running. */
  idle(): Promise<void>;
}

const REACTION = { working: 'eyes', done: 'white_check_mark', failed: 'x' } as const;
/** Statuses of a record whose result is (or was) in front of the owner. */
const LIVE_RESULT = new Set<ReviewRecord['status']>(['notified', 'posting', 'posted']);
const MAX_ERROR_CHARS = 500;
/** How long a POST with an unknown outcome is given to show up on GitHub before a retry is allowed. */
const POST_RECONCILE_GRACE_MS = 60_000;

/** Error text can carry git/gh output; keep it short and inert in Slack. */
function slackError(message: string): string {
  const short = message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
  return `\`\`\`${escapeMrkdwn(short.replace(/`/g, "'"))}\`\`\``;
}
// Ordinary posts, posts with attachments, and thread replies also sent to the channel.
const HANDLED_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);

function isOwnPr(config: Config, pr: { author: string }): boolean {
  return pr.author.toLowerCase() === config.owner.github_login.toLowerCase();
}

function verdictOf(blocker: ReturnType<typeof decideEvent>['blocker']): Verdict {
  if (blocker === 'own_pr') return 'own_pr';
  if (blocker === 'must_fix') return 'must_fix';
  if (blocker === 'unresolved') return 'unresolved';
  return 'approve';
}

export function createService(deps: ServiceDeps): Service {
  const { config, slack, gh, store, logger } = deps;
  const queue = new PQueue({ concurrency: config.review.concurrency });
  const shutdownController = new AbortController();
  const withPrLock = createKeyedLock();
  /** Posts in progress, so shutdown can let them finish instead of leaving them half-recorded. */
  const inflightPosts = new Set<Promise<void>>();
  const inflightIds = new Set<string>();
  const track = (id: string, work: Promise<void>): Promise<void> => {
    inflightPosts.add(work);
    inflightIds.add(id);
    return work.finally(() => {
      inflightPosts.delete(work);
      inflightIds.delete(id);
    });
  };

  const diffFor = (ref: PrRef): Promise<string> =>
    fetchDiffForComments(gh, ref, (step, err) =>
      logger.warn({ pr: prSlug(ref), step, err: errorMessage(err) }, 'PR diff unavailable; falling back'),
    );

  /** Why a linked PR should not be reviewed, or null if it should. */
  async function skipReason(pr: PrInfo): Promise<string | null> {
    if (pr.state !== 'OPEN') return `PR is ${pr.state.toLowerCase()}`;
    if (config.github.skip_drafts && pr.isDraft) return 'PR is a draft';
    if (config.github.skip_approved_by_owner) {
      try {
        if (await ownerApprovedHead(gh, pr, config.owner.github_login, pr.headSha)) {
          return 'owner already approved the current head';
        }
      } catch (err) {
        // Reviewing needlessly only costs money; skipping wrongly would miss a review.
        logger.warn(
          { pr: prSlug(pr), err: errorMessage(err) },
          'could not check existing approvals; reviewing anyway',
        );
      }
    }
    return null;
  }

  /** Slack hiccups must never fail a review, so reactions are best effort. */
  const react = async (loc: SlackLocation, add: string, remove?: string): Promise<void> => {
    try {
      if (remove) await slack.removeReaction({ ...loc, name: remove }).catch(() => undefined);
      await slack.addReaction({ ...loc, name: add });
    } catch (err) {
      logger.debug({ err: errorMessage(err) }, 'reaction failed');
    }
  };

  type StartResult =
    { readonly started: true } | { readonly started: false; readonly existing: ReviewRecord };

  async function startReview(pr: PrInfo, requestedBy: string, source: SlackLocation): Promise<StartResult> {
    // Bolt handles events concurrently; without the lock the same PR posted twice at once is reviewed twice.
    return withPrLock(prSlug(pr).toLowerCase(), () => startReviewLocked(pr, requestedBy, source));
  }

  async function startReviewLocked(
    pr: PrInfo,
    requestedBy: string,
    source: SlackLocation,
  ): Promise<StartResult> {
    const existing = await store.findForHead(pr, pr.headSha);
    if (existing) {
      logger.info({ pr: prSlug(pr), reviewId: existing.id }, 'this head was already reviewed; skipping');
      return { started: false, existing };
    }
    const rec = await store.create({
      pr: {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        author: pr.author,
      },
      requestedBy,
      source,
      requestedHeadSha: pr.headSha,
    });
    await react(source, REACTION.working);
    void queue.add(() => processReview(rec.id, pr));
    return { started: true };
  }

  async function notify(reviewed: ReviewRecord, outcome: ReviewOutcome): Promise<SlackLocation> {
    // Persist the nonce before the message exists, so its buttons can never outlive this result.
    const rec = await store.update(reviewed.id, { notificationNonce: randomBytes(6).toString('hex') });
    const commentable = parseCommentableLines(await diffFor(rec.pr));
    const own = isOwnPr(config, outcome.pr);
    const plan = planReview({
      classified: outcome.classified,
      commentable,
      isOwnPr: own,
      mode: 'review',
      post: config.post,
    });
    const { blocker } = decideEvent(outcome.classified, {
      isOwnPr: own,
      mode: 'review',
      severityOnFindings: config.post.severity_on_findings,
    });
    const sourceLink = await slack.permalink(rec.source).catch(() => undefined);
    const posted = await slack.postMessage({
      channel: config.slack.notify_channel,
      text: notificationText(rec, config.owner.slack_user_id),
      blocks: notificationBlocks(rec, {
        ownerUserId: config.owner.slack_user_id,
        classified: outcome.classified,
        verdict: verdictOf(blocker),
        severityOnFindings: config.post.severity_on_findings,
        inlineCount: plan.comments.length,
        ...(sourceLink ? { sourceLink } : {}),
      }),
    });
    return { channel: config.slack.notify_channel, ts: posted.ts };
  }

  async function processReview(reviewId: string, knownPr?: PrInfo): Promise<void> {
    const rec = await store.transition(reviewId, ['queued'], 'running');
    if (!rec) return;
    const log = logger.child({ reviewId, pr: prSlug(rec.pr) });
    try {
      const pr = knownPr ?? (await fetchPr(gh, rec.pr));
      const outcome = await deps.review(rec.pr, reviewId, { pr, signal: shutdownController.signal });
      const reviewed = await store.update(reviewId, {
        headSha: outcome.headSha,
        baseSha: outcome.baseSha,
        baseRef: outcome.pr.baseRef,
        result: outcome.result,
        costUsd: outcome.costUsd,
      });
      // The PR may have moved on between request and checkout, so two requests can end up reviewing
      // the same commit. Under the PR lock, only the first to finish notifies.
      const superseded = await withPrLock(prSlug(rec.pr).toLowerCase(), async () => {
        const others = await store.listForPr(rec.pr);
        const earlier = others.find(
          (r) => r.id !== reviewId && r.headSha === outcome.headSha && LIVE_RESULT.has(r.status),
        );
        if (earlier) {
          await store.update(reviewId, {
            status: 'dismissed',
            error: `same commit already reviewed in ${earlier.id}`,
          });
          return earlier;
        }
        const notification = await notify(reviewed, outcome);
        await store.update(reviewId, { status: 'notified', notification });
        return undefined;
      });
      if (superseded)
        log.info({ earlier: superseded.id }, 'same commit was already reviewed; not notifying twice');
      await react(rec.source, REACTION.done, REACTION.working);
    } catch (err) {
      if (shutdownController.signal.aborted) {
        await store.update(reviewId, { status: 'queued' });
        log.info('review interrupted by shutdown; will resume on next start');
        return;
      }
      const message = errorMessage(err);
      const cause = err instanceof Error && err.cause ? errorMessage(err.cause) : undefined;
      log.error({ err: message, cause }, 'review failed');
      await store.update(reviewId, { status: 'failed', error: message });
      await react(rec.source, REACTION.failed, REACTION.working);
      await slack
        .postMessage({
          channel: rec.source.channel,
          threadTs: rec.source.ts,
          text: `:x: Automated review failed:\n${slackError(message)}`,
        })
        .catch(() => undefined);
    }
  }

  async function resolveMessage(rec: ReviewRecord, outcome: string): Promise<void> {
    if (!rec.notification) return;
    await slack.updateMessage({ ...rec.notification, text: outcome, blocks: resolvedBlocks(rec, outcome) });
  }

  async function markStale(rec: ReviewRecord, change: string): Promise<void> {
    const stale = await store.update(rec.id, { status: 'stale' });
    if (!stale.notification) return;
    await slack.updateMessage({
      ...stale.notification,
      text: 'PR changed after the review',
      blocks: staleBlocks(stale, change),
    });
  }

  /** Tells the owner how an earlier, interrupted post ended. */
  async function reportReconciled(rec: ReviewRecord, userId: string): Promise<void> {
    const outcome = await recoverPosting(rec);
    const text = {
      posted: 'This review had already been posted to GitHub.',
      not_posted: 'The earlier attempt did not reach GitHub. Press the button again to post.',
      unknown: 'Still checking whether an earlier attempt reached GitHub. Try again in a minute.',
    }[outcome];
    await slack.postEphemeral({ channel: config.slack.notify_channel, user: userId, text });
  }

  const ephemeral = (userId: string, text: string): Promise<void> =>
    slack.postEphemeral({ channel: config.slack.notify_channel, user: userId, text });

  /** Re-checks the PR right before posting. Returns what to post, or null when it must not be posted. */
  async function preparePost(
    rec: ReviewRecord,
    mode: PostMode,
    userId: string,
  ): Promise<ReviewPayload | null> {
    const pr = await fetchPr(gh, rec.pr);
    if (pr.state !== 'OPEN') {
      const done = await store.update(rec.id, { status: 'dismissed' });
      await resolveMessage(done, `🚪 PR is ${pr.state.toLowerCase()}; nothing was posted for`);
      return null;
    }
    // Never attach a review to a different change than the one reviewed: new commits, a new base
    // branch, or a rewritten base branch (same name, different merge base) all change it.
    if (pr.headSha !== rec.headSha) {
      await markStale(
        rec,
        `new commits (\`${(rec.headSha ?? '').slice(0, 7)}\` → \`${pr.headSha.slice(0, 7)}\`)`,
      );
      return null;
    }
    if (rec.baseRef !== undefined && pr.baseRef !== rec.baseRef) {
      await markStale(rec, `a new base branch (\`${rec.baseRef}\` → \`${pr.baseRef}\`)`);
      return null;
    }
    if (rec.baseSha !== undefined) {
      const mergeBase = await fetchMergeBase(gh, rec.pr, pr.baseRef, pr.headSha);
      if (mergeBase !== rec.baseSha) {
        await markStale(
          rec,
          `a rewritten base branch (merge base \`${rec.baseSha.slice(0, 7)}\` → \`${mergeBase.slice(0, 7)}\`)`,
        );
        return null;
      }
    }
    const commentable = parseCommentableLines(await diffFor(rec.pr));
    const plan = planReview({
      classified: classify(rec.result?.findings ?? []),
      commentable,
      isOwnPr: isOwnPr(config, pr),
      mode,
      post: config.post,
    });
    const leaked = findSecretLike([plan.body, ...plan.comments.map((c) => c.body)].join('\n'));
    if (leaked.length > 0) {
      await store.transition(rec.id, ['posting'], 'notified');
      logger.error(
        { reviewId: rec.id, kinds: leaked },
        'refusing to post: review text looks like it contains secrets',
      );
      await ephemeral(
        userId,
        `:no_entry: Not posted: the review text looks like it contains a secret (${leaked.join(', ')}). Check the review before posting it by hand.`,
      );
      return null;
    }
    return buildReviewPayload({
      headSha: pr.headSha,
      event: plan.event,
      body: `${plan.body}\n\n${reviewMarker(rec.id)}`,
      comments: plan.comments,
    });
  }

  async function post(rec: ReviewRecord, mode: PostMode, userId: string): Promise<void> {
    const claimed = await store.transition(rec.id, ['notified'], 'posting');
    if (!claimed) {
      // Stuck in `posting` from an earlier attempt whose outcome is unknown: check GitHub first.
      if (rec.status === 'posting') await reportReconciled(rec, userId);
      else await ephemeral(userId, 'This review was already handled.');
      return;
    }

    let payload: ReviewPayload | null;
    try {
      payload = await preparePost(claimed, mode, userId);
    } catch (err) {
      // Nothing was sent to GitHub yet, so the buttons can safely be offered again.
      await store.transition(rec.id, ['posting'], 'notified');
      logger.error({ reviewId: rec.id, err: errorMessage(err) }, 'could not check the PR before posting');
      await ephemeral(
        userId,
        `:x: Could not check the PR before posting; nothing was posted. Try again.\n${slackError(errorMessage(err))}`,
      );
      return;
    }
    if (!payload) return;

    await store.update(rec.id, { postAttemptAt: new Date().toISOString() });
    try {
      const posted = await postReview(gh, rec.pr, payload);
      logger.info(
        { reviewId: rec.id, event: payload.event, comments: payload.comments.length },
        'review posted',
      );
      await recordPosted(rec, posted.url, payload.event);
    } catch (err) {
      logger.error({ reviewId: rec.id, err: errorMessage(err) }, 'posting failed');
      // A timeout or lost response may still have created the review; only a 4xx proves it did not.
      let outcome: 'posted' | 'not_posted' | 'unknown';
      if (isDefiniteRejection(err)) {
        await store.transition(rec.id, ['posting'], 'notified');
        outcome = 'not_posted';
      } else {
        outcome = await recoverPosting(rec);
      }
      if (outcome === 'posted') return;
      await ephemeral(
        userId,
        outcome === 'not_posted'
          ? `:x: Could not post the review. The buttons still work if you want to retry.\n${slackError(errorMessage(err))}`
          : `:warning: Not sure whether the review reached GitHub. Press the button again in a minute; it will check first.\n${slackError(errorMessage(err))}`,
      );
    }
  }

  /**
   * The review is on GitHub from here on. Nothing below may move the record back to `notified`,
   * or the next click would post it a second time.
   */
  async function recordPosted(rec: ReviewRecord, url: string, event: ReviewEvent): Promise<void> {
    let current = rec;
    try {
      current = await store.update(rec.id, {
        status: 'posted',
        posted: { url, event, at: new Date().toISOString() },
      });
    } catch (err) {
      logger.error(
        { reviewId: rec.id, err: errorMessage(err), url },
        'review posted but its state could not be saved',
      );
    }
    await resolveMessage(current, postedOutcome(url, event)).catch((err: unknown) =>
      logger.warn({ reviewId: rec.id, err: errorMessage(err) }, 'could not update the Slack message'),
    );
  }

  /** Checked before registering, so a retry of a stuck post is not mistaken for itself. */
  function startPost(rec: ReviewRecord, mode: PostMode, userId: string): Promise<void> {
    if (inflightIds.has(rec.id)) return ephemeral(userId, 'This review is being posted right now.');
    return track(rec.id, post(rec, mode, userId));
  }

  async function rereview(rec: ReviewRecord, userId: string): Promise<void> {
    if (rec.status !== 'stale') return;
    try {
      // Start the new review first; the old one is closed only once that has worked.
      const pr = await fetchPr(gh, rec.pr);
      const result = await startReview(pr, userId, rec.source);
      const closed = await store.transition(rec.id, ['stale'], 'dismissed');
      if (!closed) return;
      const outcome = result.started
        ? '🔁 Reviewing the latest commit of'
        : `ℹ️ The latest commit was already reviewed (status: ${result.existing.status}) for`;
      await resolveMessage(closed, outcome);
    } catch (err) {
      logger.error({ reviewId: rec.id, err: errorMessage(err) }, 're-review failed');
      await slack.postEphemeral({
        channel: config.slack.notify_channel,
        user: userId,
        text: `:x: Could not start a new review. You can press the button again.\n${slackError(errorMessage(err))}`,
      });
    }
  }

  /** After a crash mid-post, ask GitHub whether the review landed before allowing another click. */
  async function recoverPosting(rec: ReviewRecord): Promise<'posted' | 'not_posted' | 'unknown'> {
    const current = (await store.get(rec.id)) ?? rec;
    try {
      const found = await findPostedReview(gh, rec.pr, config.owner.github_login, reviewMarker(rec.id));
      if (found) {
        logger.info({ reviewId: rec.id, url: found.url }, 'interrupted post had reached GitHub');
        await recordPosted(current, found.url, found.event);
        return 'posted';
      }
      // GitHub may still be processing a request whose response was lost. Only once the attempt is
      // old enough does "not found" mean "never arrived".
      const startedAt = current.postAttemptAt ? Date.parse(current.postAttemptAt) : 0;
      if (Date.now() - startedAt < POST_RECONCILE_GRACE_MS) return 'unknown';
      await store.transition(rec.id, ['posting'], 'notified');
      logger.info({ reviewId: rec.id }, 'interrupted post had not reached GitHub; buttons are active again');
      return 'not_posted';
    } catch (err) {
      logger.warn(
        { reviewId: rec.id, err: errorMessage(err) },
        'could not check an interrupted post; left as posting',
      );
      return 'unknown';
    }
  }

  return {
    async handleMessage(msg) {
      if (!config.slack.watch_channels.includes(msg.channel)) return;
      if (!HANDLED_SUBTYPES.has(msg.subtype) || msg.botId || !msg.user || !msg.text) return;
      const requesters = config.slack.allowed_requesters;
      if (requesters.length > 0 && !requesters.includes(msg.user)) return;
      const source = { channel: msg.channel, ts: msg.ts };
      for (const ref of extractPrRefs(msg.text)) {
        if (!isRepoAllowed(ref, config.github.allowed_repos)) {
          logger.debug({ pr: prSlug(ref) }, 'repository not in allowed_repos; ignoring');
          continue;
        }
        try {
          const pr = await fetchPr(gh, ref);
          const skip = await skipReason(pr);
          if (skip) {
            logger.info({ pr: prSlug(ref), reason: skip }, 'not reviewing this PR');
            continue;
          }
          await startReview(pr, msg.user, source);
        } catch (err) {
          logger.warn({ pr: prSlug(ref), err: errorMessage(err) }, 'could not start review');
          await react(source, REACTION.failed);
        }
      }
    },

    async handleAction(action) {
      const [reviewId = '', nonce] = action.value.split(':');
      const log = logger.child({ actionId: action.actionId, reviewId, user: action.userId });
      log.info('button pressed');
      // The buttons post under the owner's GitHub account, so nobody else may press them.
      if (action.userId !== config.owner.slack_user_id) {
        log.warn({ owner: config.owner.slack_user_id }, 'button refused: not the configured owner');
        await slack.postEphemeral({
          channel: action.channel ?? config.slack.notify_channel,
          user: action.userId,
          text: `Only <@${config.owner.slack_user_id}> can use these buttons.`,
        });
        return;
      }
      const rec = await store.get(reviewId);
      if (!rec) {
        log.warn('button refused: review not found');
        await slack.postEphemeral({
          channel: config.slack.notify_channel,
          user: action.userId,
          text: 'Review not found.',
        });
        return;
      }
      // A button from an earlier notification of this record must not act on a newer result.
      if (rec.notificationNonce !== undefined && nonce !== rec.notificationNonce) {
        log.warn('button refused: from an older notification');
        await slack.postEphemeral({
          channel: config.slack.notify_channel,
          user: action.userId,
          text: 'This message is out of date; use the latest notification for this PR.',
        });
        return;
      }
      switch (action.actionId) {
        case ACTIONS.postReview:
          return startPost(rec, 'review', action.userId);
        case ACTIONS.postCommentsOnly:
          return startPost(rec, 'comments_only', action.userId);
        case ACTIONS.dismiss: {
          const done = await store.transition(rec.id, ['notified'], 'dismissed');
          if (done) await resolveMessage(done, '🙈 Dismissed review of');
          return;
        }
        case ACTIONS.rereview:
          return rereview(rec, action.userId);
        default:
          logger.warn({ actionId: action.actionId }, 'unknown action');
      }
    },

    async resumeInterrupted() {
      for (const rec of await store.listPosting()) await recoverPosting(rec);
      for (const rec of await store.listInterrupted()) {
        const queued = rec.status === 'running' ? await store.update(rec.id, { status: 'queued' }) : rec;
        logger.info({ reviewId: queued.id, pr: prSlug(queued.pr) }, 'resuming interrupted review');
        void queue.add(() => processReview(queued.id));
      }
    },

    async shutdown() {
      queue.pause();
      queue.clear();
      shutdownController.abort();
      await Promise.allSettled([...inflightPosts]);
      await queue.onIdle();
    },

    idle: () => queue.onIdle(),
  };
}
