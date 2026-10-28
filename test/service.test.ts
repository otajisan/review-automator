import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGh } from '../src/github/gh.js';
import type { PrInfo } from '../src/github/pr.js';
import { ReviewError } from '../src/lib/errors.js';
import { classify } from '../src/review/decision.js';
import type { ReviewOutcome } from '../src/review/run-review.js';
import type { Finding } from '../src/review/schema.js';
import { createService, type ReviewFn } from '../src/service.js';
import { ACTIONS } from '../src/slack/blocks.js';
import { createFileReviewStore } from '../src/store/reviews.js';
import { argsStartWith, fakeExec } from './helpers/fake-exec.js';
import { fakeSlack } from './helpers/fake-slack.js';
import { BASE_SHA, finding, HEAD_SHA, silentLogger, testConfig, testPr } from './helpers/fixtures.js';

const OWNER = 'U0OWNER01';
const URL = 'https://github.com/acme/api/pull/7';
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 a
+b
 c
`;

interface World {
  pr: PrInfo;
  /** Per PR number: delay `gh pr view` (ms), or make it fail. */
  viewDelayMs: Record<number, number>;
  viewFails: number[];
  mergedNumbers: number[];
  findings: Finding[];
  apiFailures: number;
  /** stderr of a failing POST; a non-4xx message means the outcome is unknown. */
  apiFailStderr: string;
  /** Whether a failing POST still created the review on GitHub (lost response). */
  apiFailCreates: boolean;
  diffFails: boolean;
  /** Merge base GitHub reports for the PR now; differs from BASE_SHA if the base was rewritten. */
  mergeBase: string;
  /** Reviews already on GitHub, as returned by the reviews list API (NDJSON lines). */
  existingReviews: string[];
}

async function setup(
  opts: { findings?: Finding[]; pr?: Partial<PrInfo>; review?: ReviewFn; configYaml?: string } = {},
) {
  const world: World = {
    pr: testPr(opts.pr),
    findings: opts.findings ?? [],
    viewDelayMs: {},
    viewFails: [],
    mergedNumbers: [],
    apiFailures: 0,
    apiFailStderr: 'HTTP 422: Unprocessable Entity',
    apiFailCreates: false,
    diffFails: false,
    mergeBase: BASE_SHA,
    existingReviews: [],
  };
  const { exec, calls } = fakeExec([
    [
      argsStartWith('pr', 'view'),
      // Answers for whichever PR number was asked, so one message can link several PRs.
      async (call) => {
        const n = Number(call.args[2]);
        const delay = world.viewDelayMs[n] ?? 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (world.viewFails.includes(n)) return { exitCode: 1, stderr: 'HTTP 404: Not Found' };
        return JSON.stringify({
          number: n,
          url: `https://github.com/acme/api/pull/${n}`,
          title: world.pr.title,
          state: world.mergedNumbers.includes(n) ? 'MERGED' : world.pr.state,
          isDraft: world.pr.isDraft,
          author: { login: world.pr.author },
          headRefOid: world.pr.headSha,
          baseRefName: world.pr.baseRef,
          body: world.pr.body,
        });
      },
    ],
    [
      argsStartWith('pr', 'diff'),
      () => (world.diffFails ? { exitCode: 1, stderr: 'HTTP 406: diff too large' } : DIFF),
    ],
    [(c) => c.args[0] === 'api' && String(c.args[1]).includes('/compare/'), () => `${world.mergeBase}\n`],
    [
      (c) => c.args[0] === 'api' && c.args[1] === '--paginate' && String(c.args[2]).endsWith('/reviews'),
      () => world.existingReviews.join('\n'),
    ],
    [
      (c) => c.args[0] === 'api' && c.args[1] === '--paginate' && String(c.args[2]).endsWith('/files'),
      () => JSON.stringify({ filename: 'src/a.ts', patch: '@@ -1,2 +1,3 @@\n a\n+b\n c' }),
    ],
    [
      argsStartWith('api'),
      (call) => {
        if (world.apiFailures > 0) {
          world.apiFailures -= 1;
          if (world.apiFailCreates) {
            const body = (JSON.parse(call.opts?.input ?? '{}') as { body?: string }).body ?? '';
            world.existingReviews.push(
              JSON.stringify({ user: 'me', html_url: `${URL}#lost`, state: 'APPROVED', body }),
            );
          }
          return { exitCode: 1, stderr: world.apiFailStderr };
        }
        return JSON.stringify({ id: 1, html_url: `${URL}#pullrequestreview-1` });
      },
    ],
  ]);
  const slack = fakeSlack();
  const store = await createFileReviewStore(await mkdtemp(path.join(tmpdir(), 'ra-svc-')));
  const review: ReviewFn =
    opts.review ??
    vi.fn((_ref, _id, o) =>
      Promise.resolve<ReviewOutcome>({
        pr: o.pr,
        headSha: o.pr.headSha,
        baseSha: BASE_SHA,
        result: { complete: true, summary: 'sum', findings: world.findings },
        classified: classify(world.findings),
        costUsd: 0.3,
        numTurns: 3,
        permissionDenials: [],
      }),
    );
  const service = createService({
    config: testConfig(opts.configYaml),
    slack,
    gh: createGh(exec),
    store,
    review,
    logger: silentLogger,
  });
  const apiCalls = () => calls.filter((c) => c.args[0] === 'api' && c.args[1] === '--method');
  return { world, slack, store, service, review, apiCalls };
}

const message = (overrides = {}) => ({
  channel: 'C0WATCH01',
  ts: '100.1',
  user: 'U0REQ0001',
  text: `please review ${URL}`,
  ...overrides,
});

const idOf = (value: string): string => value.split(':')[0] ?? '';

async function reviewed(s: Awaited<ReturnType<typeof setup>>) {
  await s.service.handleMessage(message());
  await s.service.idle();
  const note = s.slack.of('postMessage').find((m) => m['channel'] === 'C0NOTIFY1');
  // The button value is `<reviewId>:<nonce>`; tests pass it back exactly as Slack would.
  const value = JSON.stringify(note).match(/"value":"([a-z0-9-]+:[a-f0-9]*)"/)?.[1];
  if (!value) throw new Error('no notification posted');
  return value;
}

describe('handleMessage', () => {
  it('reviews a PR posted in a watched channel and notifies the owner', async () => {
    const s = await setup();

    await reviewed(s);

    const note = s.slack.of('postMessage').find((m) => m['channel'] === 'C0NOTIFY1');
    expect(String(note?.['text'])).toContain(`<@${OWNER}>`);
    expect(s.slack.of('addReaction').map((r) => r['name'])).toEqual(['eyes', 'white_check_mark']);
  });

  it.each([
    ['an unwatched channel', { channel: 'C0OTHER01' }],
    ['a bot message', { botId: 'B1' }],
    ['an edit', { subtype: 'message_changed' }],
    ['a repo outside allowed_repos', { text: 'https://github.com/evil/repo/pull/1' }],
    ['a message without a PR link', { text: 'hello' }],
  ])('ignores %s', async (_name, overrides) => {
    const s = await setup();

    await s.service.handleMessage(message(overrides));
    await s.service.idle();

    expect(s.review).not.toHaveBeenCalled();
  });

  it('does not review the same head twice', async () => {
    const s = await setup();
    await reviewed(s);

    await s.service.handleMessage(message({ ts: '200.1' }));
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('reviews again after a new push', async () => {
    const s = await setup();
    await reviewed(s);
    s.world.pr = { ...s.world.pr, headSha: '9'.repeat(40) };

    await s.service.handleMessage(message({ ts: '200.1' }));
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(2);
  });

  it('only accepts requests from allowed_requesters when configured', async () => {
    const s = await setup({
      configYaml:
        'slack: { watch_channels: [C0WATCH01], notify_channel: C0NOTIFY1, allowed_requesters: [U0TEAM001] }',
    });

    await s.service.handleMessage(message());
    await s.service.handleMessage(message({ user: 'U0TEAM001', ts: '300.1' }));
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('keeps Slack markup in error text inert', async () => {
    const s = await setup({
      review: () => Promise.reject(new Error('<!channel> see <https://evil.example|here>')),
    });

    await s.service.handleMessage(message());
    await s.service.idle();

    const reply = String(s.slack.of('postMessage').find((m) => m['threadTs'] === '100.1')?.['text']);
    expect(reply).not.toContain('<!channel>');
    expect(reply).toContain('&lt;!channel&gt;');
  });

  it('ignores posts by ignored_requesters, e.g. your own', async () => {
    const s = await setup({ configYaml: 'slack: { ignored_requesters: [U0REQ0001] }' });

    await s.service.handleMessage(message());
    await s.service.handleMessage(message({ user: 'U0OTHER01', ts: '300.1' }));
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('lets ignored_requesters win over allowed_requesters', async () => {
    const s = await setup({
      configYaml: 'slack: { allowed_requesters: [U0REQ0001], ignored_requesters: [U0REQ0001] }',
    });

    await s.service.handleMessage(message());
    await s.service.idle();

    expect(s.review).not.toHaveBeenCalled();
  });

  it('marks the request failed and replies in thread when the review fails', async () => {
    const s = await setup({
      review: () => Promise.reject(new ReviewError('timeout', 'review timed out after 20 minutes')),
    });

    await s.service.handleMessage(message());
    await s.service.idle();

    const reply = s.slack.of('postMessage').find((m) => m['threadTs'] === '100.1');
    expect(reply?.['text']).toMatch(/timed out/);
    expect(s.slack.of('addReaction').map((r) => r['name'])).toContain('x');
    expect(s.slack.of('postMessage').some((m) => m['channel'] === 'C0NOTIFY1')).toBe(false);
  });
});

describe('several PRs in one message', () => {
  const twoLinks = () => message({ text: `please review ${URL} and https://github.com/acme/api/pull/8` });

  it('reviews and notifies each PR separately', async () => {
    const s = await setup();

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(2);
    expect(s.slack.of('postMessage').filter((m) => m['channel'] === 'C0NOTIFY1')).toHaveLength(2);
  });

  it('keeps 👀 until every PR is done, then shows one result', async () => {
    const s = await setup();

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    const onSource = s.slack.calls
      .filter((c) => c.method === 'addReaction' || c.method === 'removeReaction')
      .map((c) => `${c.method === 'addReaction' ? '+' : '-'}${String(c.args['name'])}`);
    expect(onSource).toEqual(['+eyes', '-eyes', '+white_check_mark']);
  });

  it('does not settle early when the first review fails before the next link is read', async () => {
    const s = await setup({ review: () => Promise.reject(new Error('fails at once')) });
    s.world.viewDelayMs = { 8: 50 }; // PR #8 is looked up slowly

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    const onSource = s.slack.calls
      .filter((c) => c.method === 'addReaction' || c.method === 'removeReaction')
      .map((c) => `${c.method === 'addReaction' ? '+' : '-'}${String(c.args['name'])}`);
    expect(onSource).toEqual(['+eyes', '-eyes', '+x']);
  });

  it('adds no reaction when every linked PR is skipped', async () => {
    const s = await setup();
    s.world.mergedNumbers = [7, 8];

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    expect(s.slack.of('addReaction')).toEqual([]);
  });

  it('shows ❌ when one link cannot even be looked up', async () => {
    const s = await setup();
    s.world.viewFails = [8];

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    expect(s.slack.of('addReaction').map((r) => r['name'])).toEqual(['eyes', 'x']);
    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('shows ❌ (not ✅ and ❌) when one of the PRs fails', async () => {
    let n = 0;
    const s = await setup({
      review: (_ref, _id, o) => {
        n += 1;
        if (n === 2) return Promise.reject(new Error('boom'));
        return Promise.resolve({
          pr: o.pr,
          headSha: o.pr.headSha,
          baseSha: BASE_SHA,
          result: { complete: true, summary: 's', findings: [] },
          classified: classify([]),
          costUsd: 0.1,
          numTurns: 1,
          permissionDenials: [],
        });
      },
    });

    await s.service.handleMessage(twoLinks());
    await s.service.idle();

    const added = s.slack.of('addReaction').map((r) => r['name']);
    expect(added).toEqual(['eyes', 'x']);
  });
});

describe('which PRs are reviewed', () => {
  const approval = (state: string, commit: string) =>
    JSON.stringify({ user: 'me', state, commit_id: commit, html_url: 'x', body: '' });

  async function linkPosted(s: Awaited<ReturnType<typeof setup>>) {
    await s.service.handleMessage(message());
    await s.service.idle();
  }

  it('skips draft PRs', async () => {
    const s = await setup({ pr: { isDraft: true } });

    await linkPosted(s);

    expect(s.review).not.toHaveBeenCalled();
  });

  it('reviews drafts when skip_drafts is off', async () => {
    const s = await setup({ pr: { isDraft: true }, configYaml: 'github: { skip_drafts: false }' });

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('skips a PR whose current head the owner already approved', async () => {
    const s = await setup();
    s.world.existingReviews = [approval('APPROVED', HEAD_SHA)];

    await linkPosted(s);

    expect(s.review).not.toHaveBeenCalled();
  });

  it('reviews again when the approval was for an earlier commit', async () => {
    const s = await setup();
    s.world.existingReviews = [approval('APPROVED', '9'.repeat(40))];

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('reviews when the owner later requested changes on the same head', async () => {
    const s = await setup();
    s.world.existingReviews = [approval('APPROVED', HEAD_SHA), approval('CHANGES_REQUESTED', HEAD_SHA)];

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it("ignores other people's approvals and the owner's plain comments", async () => {
    const s = await setup();
    s.world.existingReviews = [
      JSON.stringify({ user: 'alice', state: 'APPROVED', commit_id: HEAD_SHA, html_url: 'x', body: '' }),
      approval('COMMENTED', HEAD_SHA),
    ];

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('reviews approved PRs when skip_approved_by_owner is off', async () => {
    const s = await setup({ configYaml: 'github: { skip_approved_by_owner: false }' });
    s.world.existingReviews = [approval('APPROVED', HEAD_SHA)];

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it('reviews anyway when existing approvals cannot be checked', async () => {
    const s = await setup();
    s.world.existingReviews = ['not json'];

    await linkPosted(s);

    expect(s.review).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency', () => {
  it('reviews a PR once even when it is posted in two channels at the same moment', async () => {
    const s = await setup({ configYaml: 'slack: { watch_channels: [C0WATCH01, C0WATCH02] }' });

    await Promise.all([
      s.service.handleMessage(message()),
      s.service.handleMessage(message({ channel: 'C0WATCH02', ts: '900.1' })),
    ]);
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(1);
  });
});

describe('duplicate results for one commit', () => {
  it('notifies once when two requests end up reviewing the same commit', async () => {
    const s = await setup();
    await reviewed(s);
    // A request for an older head whose checkout picked up the same, newer commit.
    const late = await s.store.create({
      pr: { owner: 'acme', repo: 'api', number: 7, url: URL, title: 't', author: 'alice' },
      requestedBy: 'U0REQ0001',
      source: { channel: 'C0WATCH01', ts: '5.5' },
      requestedHeadSha: '8'.repeat(40),
    });
    await s.service.resumeInterrupted();
    await s.service.idle();

    expect(s.slack.of('postMessage').filter((m) => m['channel'] === 'C0NOTIFY1')).toHaveLength(1);
    expect((await s.store.get(late.id))?.status).toBe('dismissed');
  });
});

describe('handleAction', () => {
  it('rejects anyone but the owner', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: 'U0INTRUDER' });

    expect(s.apiCalls()).toHaveLength(0);
    expect(s.slack.of('postEphemeral')[0]?.['text']).toMatch(/Only <@U0OWNER01>/);
  });

  it('approves with LGTM when there are no findings', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    const payload = JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}');
    expect(payload).toEqual({
      commit_id: HEAD_SHA,
      event: 'APPROVE',
      body: `LGTM!! :+1:\n\n<!-- review-automator:${idOf(reviewId)} -->`,
      comments: [],
    });
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('posted');
    expect(String(s.slack.of('updateMessage')[0]?.['text'])).toMatch(/Posted approval/);
  });

  it('approves with inline comments for should_fix findings', async () => {
    const s = await setup({ findings: [finding({ file: 'src/a.ts', line: 2 })] });
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    const payload = JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}');
    expect(payload.event).toBe('APPROVE');
    expect(payload.body).toMatch(/^LGTM!! :\+1:\n確認したほうが良さそうな箇所のみコメントしました/);
    expect(payload.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2, side: 'RIGHT' })]);
  });

  it('comments without approving when a must_fix exists', async () => {
    const s = await setup({
      findings: [finding({ severity: 'must_fix', verification: 'confirmed', line: 2 })],
    });
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}').event).toBe('COMMENT');
  });

  it('posts once even if the button is pressed twice', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);

    await Promise.all([
      s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER }),
      s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER }),
    ]);

    expect(s.apiCalls()).toHaveLength(1);
  });

  it('refuses to post when the PR moved on, and offers a re-review', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.pr = { ...s.world.pr, headSha: '9'.repeat(40) };

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('stale');
    expect(JSON.stringify(s.slack.of('updateMessage')[0])).toContain(ACTIONS.rereview);

    await s.service.handleAction({ actionId: ACTIONS.rereview, value: reviewId, userId: OWNER });
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(2);
  });

  it('does not post to a closed PR', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.pr = { ...s.world.pr, state: 'MERGED' };

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('dismissed');
  });

  it('refuses to post review text that looks like it contains a secret', async () => {
    const s = await setup({ findings: [finding({ line: 2, body: `leaked xoxb-${'1'.repeat(12)}-abc` })] });
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('notified');
    expect(s.slack.of('postEphemeral')[0]?.['text']).toMatch(/Slack token/);
  });

  it('does not approve when a must_fix could not be settled', async () => {
    const s = await setup({
      findings: [finding({ severity: 'must_fix', verification: 'uncertain', line: 2 })],
    });
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    const payload = JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}');
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toEqual([]);
  });

  it('never posts twice when saving the posted state fails', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    const update = s.store.update.bind(s.store);
    vi.spyOn(s.store, 'update').mockImplementation((id, patch) =>
      patch.status === 'posted' ? Promise.reject(new Error('disk full')) : update(id, patch),
    );

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });
    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(1);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('posting');
  });

  it('falls back to the files API when the PR diff is too large', async () => {
    const s = await setup({ findings: [finding({ line: 2 })] });
    const reviewId = await reviewed(s);
    s.world.diffFails = true;

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    const payload = JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}');
    expect(payload.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2 })]);
  });

  it('uses a neutral body, not LGTM, for a non-approving review with nothing to say', async () => {
    const s = await setup({ pr: { author: 'me' } });
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    const payload = JSON.parse(s.apiCalls()[0]?.opts?.input ?? '{}');
    expect(payload.event).toBe('COMMENT');
    expect(payload.body).not.toMatch(/LGTM/);
  });

  it('keeps the review stale and tells the owner when a re-review cannot start', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.pr = { ...s.world.pr, headSha: '9'.repeat(40) };
    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });
    s.world.pr = { ...s.world.pr, state: 'CLOSED' as const };
    vi.spyOn(s.store, 'create').mockRejectedValueOnce(new Error('disk full'));

    await s.service.handleAction({ actionId: ACTIONS.rereview, value: reviewId, userId: OWNER });

    expect((await s.store.get(idOf(reviewId)))?.status).toBe('stale');
    expect(s.slack.of('postEphemeral').at(-1)?.['text']).toMatch(/Could not start a new review/);
  });

  it('dismisses without posting', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);

    await s.service.handleAction({ actionId: ACTIONS.dismiss, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('dismissed');
  });

  it('lets the owner retry after a GitHub failure', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.apiFailures = 1;

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect((await s.store.get(idOf(reviewId)))?.status).toBe('notified');
    expect(s.slack.of('postEphemeral')[0]?.['text']).toMatch(/Could not post/);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect((await s.store.get(idOf(reviewId)))?.status).toBe('posted');
  });

  it('does not post twice when GitHub created the review but the response was lost', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    Object.assign(s.world, {
      apiFailures: 1,
      apiFailStderr: 'context deadline exceeded',
      apiFailCreates: true,
    });

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });
    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(1);
    expect((await s.store.get(idOf(reviewId)))?.posted?.url).toBe(`${URL}#lost`);
  });

  it('waits out a grace period before allowing a retry after an ambiguous failure', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    Object.assign(s.world, { apiFailures: 1, apiFailStderr: 'connection reset', apiFailCreates: false });
    const press = () =>
      s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    await press();
    await press(); // GitHub might still be creating the first one: no second POST yet
    expect(s.apiCalls()).toHaveLength(1);
    expect(s.slack.of('postEphemeral').at(-1)?.['text']).toMatch(/Still checking/);

    await s.store.update(idOf(reviewId), { postAttemptAt: new Date(Date.now() - 120_000).toISOString() });
    await press(); // grace period over and still absent: buttons are re-enabled
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('notified');

    await press();
    expect(s.apiCalls()).toHaveLength(2);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('posted');
  });

  it('refuses to post when the base branch was rewritten under the same name', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.mergeBase = '3'.repeat(40);

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('stale');
    expect(JSON.stringify(s.slack.of('updateMessage')[0])).toContain('rewritten base branch');
  });

  it('re-reviews after a retarget instead of finding its own stale record', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.pr = { ...s.world.pr, baseRef: 'release' };
    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    await s.service.handleAction({ actionId: ACTIONS.rereview, value: reviewId, userId: OWNER });
    await s.service.idle();

    expect(s.review).toHaveBeenCalledTimes(2);
  });

  it('refuses to post when the PR was retargeted to another base branch', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    s.world.pr = { ...s.world.pr, baseRef: 'release' };

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect((await s.store.get(idOf(reviewId)))?.status).toBe('stale');
    expect(JSON.stringify(s.slack.of('updateMessage')[0])).toContain('a new base branch');
  });

  it('ignores a button from an earlier notification after the review was re-run', async () => {
    const s = await setup();
    const oldValue = await reviewed(s);
    // A crash between sending the notification and saving it re-runs the review on restart.
    await s.store.update(idOf(oldValue), { status: 'running' });
    await s.service.resumeInterrupted();
    await s.service.idle();

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: oldValue, userId: OWNER });

    expect(s.apiCalls()).toHaveLength(0);
    expect(s.slack.of('postEphemeral').at(-1)?.['text']).toMatch(/out of date/);
  });

  it('reports success even if updating the Slack message fails afterwards', async () => {
    const s = await setup();
    const reviewId = await reviewed(s);
    vi.spyOn(s.slack, 'updateMessage').mockRejectedValueOnce(new Error('slack down'));

    await s.service.handleAction({ actionId: ACTIONS.postReview, value: reviewId, userId: OWNER });

    expect((await s.store.get(idOf(reviewId)))?.status).toBe('posted');
    expect(s.slack.of('postEphemeral')).toEqual([]);
  });
});

describe('resumeInterrupted', () => {
  async function stuckInPosting(s: Awaited<ReturnType<typeof setup>>) {
    const reviewId = await reviewed(s);
    await s.store.update(idOf(reviewId), { status: 'posting' });
    return reviewId;
  }

  it('marks a post interrupted after reaching GitHub as posted, so it cannot be posted again', async () => {
    const s = await setup();
    const reviewId = await stuckInPosting(s);
    s.world.existingReviews = [
      // A manual review by the owner on the same commit must not be mistaken for ours.
      JSON.stringify({ user: 'me', html_url: `${URL}#manual`, state: 'COMMENTED', body: 'looked at it' }),
      JSON.stringify({
        user: 'me',
        html_url: `${URL}#r9`,
        state: 'APPROVED',
        body: `LGTM\n\n<!-- review-automator:${idOf(reviewId)} -->`,
      }),
    ];

    await s.service.resumeInterrupted();

    const rec = await s.store.get(idOf(reviewId));
    expect(rec?.status).toBe('posted');
    expect(rec?.posted).toMatchObject({ url: `${URL}#r9`, event: 'APPROVE' });
  });

  it('re-enables the buttons for a post that never reached GitHub', async () => {
    const s = await setup();
    const reviewId = await stuckInPosting(s);
    s.world.existingReviews = [
      JSON.stringify({
        user: 'me',
        html_url: `${URL}#manual`,
        state: 'COMMENTED',
        body: 'my own manual review',
      }),
    ];

    await s.service.resumeInterrupted();

    expect((await s.store.get(idOf(reviewId)))?.status).toBe('notified');
  });

  it('re-runs reviews left running by a crash', async () => {
    const s = await setup();
    const rec = await s.store.create({
      pr: { owner: 'acme', repo: 'api', number: 7, url: URL, title: 't', author: 'alice' },
      requestedBy: 'U0REQ0001',
      source: { channel: 'C0WATCH01', ts: '1.1' },
      requestedHeadSha: HEAD_SHA,
    });
    await s.store.update(rec.id, { status: 'running' });

    await s.service.resumeInterrupted();
    await s.service.idle();

    expect((await s.store.get(rec.id))?.status).toBe('notified');
  });
});
