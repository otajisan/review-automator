import type { Button, KnownBlock, PlainTextOption } from '@slack/types';
import { redactSecrets } from '../lib/secrets.js';
import {
  numberFindings,
  PICK_GROUP_SIZE,
  pickGroups,
  type Classified,
  type NumberedFinding,
} from '../review/decision.js';
import type { Finding } from '../review/schema.js';
import type { ReviewRecord } from '../store/reviews.js';
import { findingRef, SEVERITY_ICON } from './finding-thread.js';
import { escapeMrkdwn, SECTION_LIMIT } from './mrkdwn.js';

export { escapeMrkdwn } from './mrkdwn.js';

export const ACTIONS = {
  postReview: 'ra_post_review',
  /** "Post selected": the checked findings, never an approval. */
  postCommentsOnly: 'ra_post_comments_only',
  /** "Post selected & Approve": approves with the checked findings, or posts nothing. */
  postSelectedApprove: 'ra_post_selected_approve',
  dismiss: 'ra_dismiss',
  rereview: 'ra_rereview',
} as const;

export type ActionId = (typeof ACTIONS)[keyof typeof ACTIONS];

const MAX_LISTED = 8;
/** Slack's limit for the text and description of a checkbox option. */
const OPTION_TEXT_MAX = 75;

const GROUP_HINT = {
  postable: undefined,
  uncertain: 'The verifier could not decide',
  nit: 'Nit',
} as const;

function truncate(text: string, limit = SECTION_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Packs lines into as few sections as possible without exceeding Slack's per-section limit. */
function packSections(lines: readonly string[]): KnownBlock[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > SECTION_LIMIT && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(section);
}

function section(text: string): KnownBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: truncate(text) } };
}

function context(text: string): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: truncate(text) }] };
}

/** `owner/repo#n title`, linked to the PR. */
export function prMention(rec: ReviewRecord): string {
  return prLink(rec);
}

function prLink(rec: ReviewRecord): string {
  const slug = `${rec.pr.owner}/${rec.pr.repo}#${rec.pr.number}`;
  return `<${rec.pr.url}|${escapeMrkdwn(slug)}> ${escapeMrkdwn(rec.pr.title)}`;
}

/** Findings in the order they are numbered in the notification and its thread. */
function displayOrder(classified: Classified): readonly Finding[] {
  return [...classified.postable, ...classified.uncertain, ...classified.nits];
}

export type Verdict = 'approve' | 'must_fix' | 'unresolved' | 'own_pr';

export function verdictText(verdict: Verdict, severityOnFindings: string): string {
  switch (verdict) {
    case 'approve':
      return '✅ *Approvable* — no must-fix issues';
    case 'must_fix':
      return `🔴 *Must-fix issues found* — posted as ${severityOnFindings}; uncheck the ones you disagree with to approve instead`;
    case 'unresolved':
      return '❔ *Possible must-fix issue the verifier could not settle* — comments only, no approval from here';
    case 'own_pr':
      return '👤 *Your own PR* — comments only (GitHub does not allow self-approval)';
  }
}

export interface NotificationView {
  readonly ownerUserId: string;
  readonly classified: Classified;
  readonly verdict: Verdict;
  readonly severityOnFindings: string;
  readonly inlineCount: number;
  readonly sourceLink?: string;
}

function listed(heading: string, findings: readonly Finding[], order: readonly Finding[]): string[] {
  if (findings.length === 0) return [];
  const shown = findings.slice(0, MAX_LISTED).map((f) => `*#${order.indexOf(f) + 1}* ${findingRef(f)}`);
  const rest = findings.length - shown.length;
  return [heading, ...shown, ...(rest > 0 ? [`…and ${rest} more`] : [])];
}

function findingsList(classified: Classified): string[] {
  const order = displayOrder(classified);
  const uncertain = listed(
    '*Needs your judgement* (verifier could not decide; not posted)',
    classified.uncertain,
    order,
  );
  return [
    ...listed('*Will be posted*', classified.postable, order),
    ...(uncertain.length > 0 && classified.postable.length > 0 ? [''] : []),
    ...uncertain,
  ];
}

const THREAD_NOTE = '🧵 The full text of every finding is in the thread, numbered as above.';

/** Text for the "started reviewing" message: `{pr}` in the template becomes a link to the PR. */
export function startedText(rec: ReviewRecord, template: string): string {
  return template.split('{pr}').join(prLink(rec));
}

export function notificationText(rec: ReviewRecord, ownerUserId: string): string {
  const slug = `${rec.pr.owner}/${rec.pr.repo}#${rec.pr.number}`;
  return `<@${ownerUserId}> Review ready: ${escapeMrkdwn(`${slug} ${rec.pr.title}`)}`;
}

function limitText(text: string, max = OPTION_TEXT_MAX): string {
  const clean = redactSecrets(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function pickOption({ n, index, finding: f, group }: NumberedFinding): PlainTextOption {
  const hint = GROUP_HINT[group];
  return {
    text: {
      type: 'plain_text',
      text: limitText(`#${n} ${SEVERITY_ICON[f.severity]} ${f.file}:${f.line} ${f.title}`),
    },
    value: String(index),
    ...(hint ? { description: { type: 'plain_text', text: hint } } : {}),
  };
}

/**
 * One checkbox group per ten findings. What `classify` would post starts checked, so pressing a
 * button without touching anything posts what it always did; the value is the finding's index.
 */
function pickBlocks(rec: ReviewRecord): KnownBlock[] {
  return pickGroups(rec.result?.findings ?? []).map((group, g) => {
    const options = group.map(pickOption);
    const initial = options.filter((_, i) => group[i]?.group === 'postable');
    return {
      type: 'actions',
      block_id: `ra_pick_block_${g}`,
      elements: [
        {
          type: 'checkboxes',
          action_id: `ra_pick_${g}`,
          options,
          ...(initial.length > 0 ? { initial_options: initial } : {}),
        },
      ],
    };
  });
}

function findingBlocks(rec: ReviewRecord, classified: Classified): KnownBlock[] {
  const picks = pickBlocks(rec);
  if (picks.length === 0) return packSections(findingsList(classified));
  const offered = picks.length * PICK_GROUP_SIZE;
  const total = numberFindings(rec.result?.findings ?? []).length;
  return [
    section('*Check the findings to post*'),
    ...picks,
    ...(total > offered
      ? [context(`#${offered + 1} and later cannot be unchecked here; those normally posted will be.`)]
      : []),
  ];
}

const APPROVE_OVER_MUST_FIX = {
  title: { type: 'plain_text', text: 'Approve this PR?' },
  text: {
    type: 'plain_text',
    text: 'The review found must-fix issues. This approves only if you unchecked every one of them; otherwise nothing is posted.',
  },
  confirm: { type: 'plain_text', text: 'Approve' },
  deny: { type: 'plain_text', text: 'Back' },
} as const;

function postButtons(rec: ReviewRecord, view: NotificationView): Button[] {
  const value = actionValue(rec);
  if (displayOrder(view.classified).length === 0) {
    const label = view.verdict === 'approve' ? 'Approve (LGTM)' : 'Post comments';
    return [button(label, ACTIONS.postReview, value, true)];
  }
  const approvable = view.verdict === 'approve';
  const comment = button('Post selected', ACTIONS.postCommentsOnly, value, !approvable);
  // A must_fix can be unchecked; an unsettled one or your own PR can never be approved from here.
  if (view.verdict === 'unresolved' || view.verdict === 'own_pr') return [comment];
  const approve: Button = {
    ...button('Post selected & Approve', ACTIONS.postSelectedApprove, value, approvable),
    // Approving after a must-fix was found deserves a second look before it reaches the PR.
    ...(view.verdict === 'must_fix' ? { confirm: APPROVE_OVER_MUST_FIX } : {}),
  };
  return approvable ? [approve, comment] : [comment, approve];
}

function countsLine(classified: Classified): string {
  const mustFix = classified.postable.filter((f) => f.severity === 'must_fix').length;
  const shouldFix = classified.postable.length - mustFix;
  return [
    `🔴 ${mustFix}`,
    `🟡 ${shouldFix}`,
    `🟢 ${classified.nits.length}`,
    `❔ ${classified.uncertain.length}`,
    `🚫 ${classified.refuted.length} refuted`,
  ].join('  ');
}

function button(text: string, actionId: ActionId, value: string, primary = false): Button {
  return {
    type: 'button',
    text: { type: 'plain_text', text },
    action_id: actionId,
    value,
    ...(primary ? { style: 'primary' as const } : {}),
  };
}

export function notificationBlocks(rec: ReviewRecord, view: NotificationView): KnownBlock[] {
  const { classified } = view;
  const meta = [
    `requested by <@${rec.requestedBy}>`,
    view.sourceLink ? `<${view.sourceLink}|original message>` : undefined,
    rec.headSha ? `head \`${rec.headSha.slice(0, 7)}\`` : undefined,
    rec.costUsd !== undefined ? `$${rec.costUsd.toFixed(2)}` : undefined,
  ].filter((x): x is string => x !== undefined);

  const blocks: KnownBlock[] = [
    section(`<@${view.ownerUserId}> *Review ready* ${prLink(rec)}`),
    context(meta.join(' · ')),
  ];
  if (rec.result?.summary) blocks.push(section(escapeMrkdwn(rec.result.summary)));
  blocks.push(section(`${verdictText(view.verdict, view.severityOnFindings)}\n${countsLine(classified)}`));

  blocks.push(...findingBlocks(rec, classified));
  const outside = classified.postable.length - view.inlineCount;
  const notes = [
    ...(displayOrder(classified).length + classified.refuted.length > 0 ? [THREAD_NOTE] : []),
    ...(outside > 0 ? [`${outside} finding(s) are outside the diff and will go in the review body.`] : []),
  ];
  if (notes.length > 0) blocks.push(context(notes.join('\n')));

  const elements = [...postButtons(rec, view), button('Dismiss', ACTIONS.dismiss, actionValue(rec))];
  blocks.push({ type: 'actions', elements });
  return blocks;
}

/** Replaces the notification once acted upon, so the buttons cannot be pressed twice. */
export function resolvedBlocks(rec: ReviewRecord, outcome: string): KnownBlock[] {
  return [
    section(`${outcome} ${prLink(rec)}`),
    ...(rec.result?.summary ? [context(escapeMrkdwn(rec.result.summary))] : []),
    ...((rec.result?.findings.length ?? 0) > 0 ? [context('🧵 The findings stay in the thread.')] : []),
  ];
}

export function postedOutcome(
  url: string,
  event: string,
  findings?: { readonly posted: number; readonly total: number },
): string {
  const counts = findings ? ` (${findings.posted} of ${findings.total} findings)` : '';
  return `✅ <${url}|Posted ${event === 'APPROVE' ? 'approval' : 'review'}>${counts} for`;
}

/** Button value: the record plus the nonce of the notification it belongs to. */
export function actionValue(rec: ReviewRecord): string {
  return `${rec.id}:${rec.notificationNonce ?? ''}`;
}

export function staleBlocks(rec: ReviewRecord, change: string): KnownBlock[] {
  return [
    section(`⚠️ ${prLink(rec)} changed after the review: ${escapeMrkdwn(change)}. Nothing was posted.`),
    { type: 'actions', elements: [button('Review again', ACTIONS.rereview, actionValue(rec), true)] },
  ];
}
