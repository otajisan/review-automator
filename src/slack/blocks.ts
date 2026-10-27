import type { Button, KnownBlock } from '@slack/types';
import { redactSecrets } from '../lib/secrets.js';
import type { Classified } from '../review/decision.js';
import type { Finding } from '../review/schema.js';
import type { ReviewRecord } from '../store/reviews.js';

export const ACTIONS = {
  postReview: 'ra_post_review',
  postCommentsOnly: 'ra_post_comments_only',
  dismiss: 'ra_dismiss',
  rereview: 'ra_rereview',
} as const;

export type ActionId = (typeof ACTIONS)[keyof typeof ACTIONS];

const SECTION_LIMIT = 2900; // Slack rejects section text over 3000 characters
const MAX_LISTED = 8;
const ICON = { must_fix: '🔴', should_fix: '🟡', nit: '🟢' } as const;

/**
 * Slack mrkdwn treats &, <, > as control characters. Secret-like strings are masked too: the text
 * shown here comes from the PR or the model, and the channel may be wider than the PR's audience.
 */
export function escapeMrkdwn(text: string): string {
  return redactSecrets(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

function prLink(rec: ReviewRecord): string {
  const slug = `${rec.pr.owner}/${rec.pr.repo}#${rec.pr.number}`;
  return `<${rec.pr.url}|${escapeMrkdwn(slug)}> ${escapeMrkdwn(rec.pr.title)}`;
}

const PREVIEW_CHARS = 280;

function findingLine(f: Finding): string {
  return `${ICON[f.severity]} \`${escapeMrkdwn(`${f.file}:${f.line}`)}\` ${escapeMrkdwn(f.title)}`;
}

/** Title plus the start of the comment body, so the owner sees what will be posted. */
function findingPreview(f: Finding): string {
  const body = f.body.replace(/\s+/g, ' ').trim();
  const preview = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS - 1)}…` : body;
  return `${findingLine(f)}\n>${escapeMrkdwn(preview)}`;
}

export type Verdict = 'approve' | 'must_fix' | 'unresolved' | 'own_pr';

export function verdictText(verdict: Verdict, severityOnFindings: string): string {
  switch (verdict) {
    case 'approve':
      return '✅ *Approvable* — no must-fix issues';
    case 'must_fix':
      return `🔴 *Must-fix issues found* — will post as ${severityOnFindings}, without approval`;
    case 'unresolved':
      return '❔ *Possible must-fix issue the verifier could not settle* — comments only, no approval';
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

function findingsList(classified: Classified): string[] {
  const lines: string[] = [];
  const listed = classified.postable.slice(0, MAX_LISTED);
  if (listed.length > 0) {
    lines.push('*Will be posted*', ...listed.map(findingPreview));
    const rest = classified.postable.length - listed.length;
    if (rest > 0) lines.push(`…and ${rest} more`);
  }
  if (classified.uncertain.length > 0) {
    lines.push(
      '',
      '*Needs your judgement* (verifier could not decide; not posted)',
      ...classified.uncertain.slice(0, MAX_LISTED).map(findingPreview),
    );
  }
  return lines;
}

export function notificationText(rec: ReviewRecord, ownerUserId: string): string {
  const slug = `${rec.pr.owner}/${rec.pr.repo}#${rec.pr.number}`;
  return `<@${ownerUserId}> Review ready: ${escapeMrkdwn(`${slug} ${rec.pr.title}`)}`;
}

function primaryLabel(view: NotificationView): string {
  if (view.verdict !== 'approve') return 'Post comments';
  return view.classified.postable.length > 0 ? 'Post comments & Approve' : 'Approve (LGTM)';
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

  blocks.push(...packSections(findingsList(classified)));
  const outside = classified.postable.length - view.inlineCount;
  if (outside > 0) {
    blocks.push(context(`${outside} finding(s) are outside the diff and will go in the review body.`));
  }

  const offerCommentsOnly = view.verdict === 'approve' && classified.postable.length > 0;
  const elements = [
    button(primaryLabel(view), ACTIONS.postReview, actionValue(rec), true),
    ...(offerCommentsOnly ? [button('Comments only', ACTIONS.postCommentsOnly, actionValue(rec))] : []),
    button('Dismiss', ACTIONS.dismiss, actionValue(rec)),
  ];
  blocks.push({ type: 'actions', elements });
  return blocks;
}

/** Replaces the notification once acted upon, so the buttons cannot be pressed twice. */
export function resolvedBlocks(rec: ReviewRecord, outcome: string): KnownBlock[] {
  return [
    section(`${outcome} ${prLink(rec)}`),
    ...(rec.result?.summary ? [context(escapeMrkdwn(rec.result.summary))] : []),
  ];
}

export function postedOutcome(url: string, event: string): string {
  return `✅ <${url}|Posted ${event === 'APPROVE' ? 'approval' : 'review'}> for`;
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
