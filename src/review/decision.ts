import type { Config } from '../config/schema.js';
import { isCommentable, type CommentableLines } from '../github/diff.js';
import type { InlineComment, ReviewEvent } from '../github/post-review.js';
import type { Finding } from './schema.js';

export type PostMode = 'review' | 'comments_only';

export interface Classified {
  /** Findings worth putting on the PR. */
  readonly postable: readonly Finding[];
  /** must_fix findings the verifier could not settle. Shown in Slack only. */
  readonly uncertain: readonly Finding[];
  readonly nits: readonly Finding[];
  readonly refuted: readonly Finding[];
  readonly hasMustFix: boolean;
  /** A must_fix the verifier could neither confirm nor refute. Blocks approval. */
  readonly hasUnresolvedMustFix: boolean;
}

const SEVERITY_ORDER = { must_fix: 0, should_fix: 1, nit: 2 } as const;

function bySeverity(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line
  );
}

/**
 * The model reports findings; this function, not the model, decides what reaches the PR.
 * Refuted findings are dropped and unverified-but-disputed must_fix items stay private.
 */
export function classify(findings: readonly Finding[]): Classified {
  const sorted = [...findings].sort(bySeverity);
  const refuted = sorted.filter((f) => f.verification === 'refuted');
  const live = sorted.filter((f) => f.verification !== 'refuted');
  const uncertain = live.filter((f) => f.verification === 'uncertain');
  const settled = live.filter((f) => f.verification !== 'uncertain');
  const postable = settled.filter((f) => f.severity !== 'nit');
  const nits = settled.filter((f) => f.severity === 'nit');
  return {
    postable,
    uncertain,
    nits,
    refuted,
    hasMustFix: postable.some((f) => f.severity === 'must_fix'),
    hasUnresolvedMustFix: uncertain.some((f) => f.severity === 'must_fix'),
  };
}

export type FindingGroup = 'postable' | 'uncertain' | 'nit';

export interface NumberedFinding {
  /** 1-based number shown in Slack, shared by the notification and its thread. */
  readonly n: number;
  /** Position in the review's original `findings` array; stable across restarts. */
  readonly index: number;
  readonly finding: Finding;
  readonly group: FindingGroup;
}

/** Every finding the owner may want to read or post, in display order. Refuted ones are left out. */
export function numberFindings(findings: readonly Finding[]): NumberedFinding[] {
  const c = classify(findings);
  const groups: readonly (readonly [FindingGroup, readonly Finding[]])[] = [
    ['postable', c.postable],
    ['uncertain', c.uncertain],
    ['nit', c.nits],
  ];
  return groups
    .flatMap(([group, list]) => list.map((f) => ({ group, finding: f, index: findings.indexOf(f) })))
    .map((x, i) => ({ ...x, n: i + 1 }));
}

/** Slack allows ten options per checkbox group; four groups keep a notification well under its 50 blocks. */
export const PICK_GROUP_SIZE = 10;
export const MAX_PICK_GROUPS = 4;

/** Checked finding indices per checkbox group, as read back from Slack. Untrusted. */
export type Picks = ReadonlyMap<number, readonly number[]>;

/** The findings offered as checkboxes, grouped as they appear in the notification. */
export function pickGroups(findings: readonly Finding[]): NumberedFinding[][] {
  const pickable = numberFindings(findings).slice(0, PICK_GROUP_SIZE * MAX_PICK_GROUPS);
  return Array.from({ length: Math.ceil(pickable.length / PICK_GROUP_SIZE) }, (_, g) =>
    pickable.slice(g * PICK_GROUP_SIZE, (g + 1) * PICK_GROUP_SIZE),
  );
}

/**
 * What to post, given the owner's checkboxes. Without picks (an older notification) this is exactly
 * `classify`. A group the owner never touched keeps its default, which is what `classify` would post;
 * an index is honoured only inside the group it was offered in, so nothing else can be smuggled in.
 * A checked uncertain must_fix counts as a must_fix; one left unchecked still blocks approval,
 * because nobody has ruled it out.
 */
export function selectFindings(findings: readonly Finding[], picks: Picks | undefined): Classified {
  const base = classify(findings);
  if (!picks) return base;
  const selected = numberFindings(findings)
    .filter(({ n, index, group }) => {
      const g = Math.floor((n - 1) / PICK_GROUP_SIZE);
      const picked = g < MAX_PICK_GROUPS ? picks.get(g) : undefined;
      return picked ? picked.includes(index) : group === 'postable';
    })
    .map((x) => x.finding);
  const unselected = (list: readonly Finding[]) => list.filter((f) => !selected.includes(f));
  return {
    postable: selected,
    uncertain: unselected(base.uncertain),
    nits: unselected(base.nits),
    refuted: base.refuted,
    hasMustFix: selected.some((f) => f.severity === 'must_fix'),
    hasUnresolvedMustFix: unselected(base.uncertain).some((f) => f.severity === 'must_fix'),
  };
}

export type ApproveBlocker = 'must_fix' | 'unresolved' | 'own_pr' | 'comments_only';

export function decideEvent(
  classified: Classified,
  opts: { isOwnPr: boolean; mode: PostMode; severityOnFindings: Config['post']['severity_on_findings'] },
): { event: ReviewEvent; blocker: ApproveBlocker | null } {
  // GitHub rejects APPROVE and REQUEST_CHANGES on your own PR, so the own-PR check comes first.
  if (opts.isOwnPr) return { event: 'COMMENT', blocker: 'own_pr' };
  if (classified.hasMustFix) return { event: opts.severityOnFindings, blocker: 'must_fix' };
  // Never approve over a possible must-fix issue nobody could rule out.
  if (classified.hasUnresolvedMustFix) return { event: 'COMMENT', blocker: 'unresolved' };
  if (opts.mode === 'comments_only') return { event: 'COMMENT', blocker: 'comments_only' };
  return { event: 'APPROVE', blocker: null };
}

const SEVERITY_LABEL = { must_fix: '🔴 must fix', should_fix: '🟡 should fix', nit: '🟢 nit' } as const;

/**
 * Model-written text is posted under the owner's name. Keep it from pinging people or teams
 * (`@org/team`) and from loading remote images (tracking pixels); links stay clickable.
 */
const REMOTE_MEDIA_TAGS =
  /<(?=\/?\s*(img|picture|source|video|audio|iframe|object|embed|svg|image|link|meta|style)\b)/gi;

export function sanitizeMarkdown(text: string): string {
  return (
    text
      // Every image form, inline `![x](u)` and reference `![x][ref]`, becomes a plain link.
      .replace(/!\[/g, '[')
      // Raw HTML that would fetch a remote resource is shown as text instead.
      .replace(REMOTE_MEDIA_TAGS, '&lt;')
      .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@\u200b')
  );
}

export function formatCommentBody(f: Finding): string {
  return sanitizeMarkdown(`**${SEVERITY_LABEL[f.severity]}: ${f.title}**\n\n${f.body}`);
}

export interface ReviewPlan {
  readonly event: ReviewEvent;
  readonly body: string;
  readonly comments: readonly InlineComment[];
  /** Findings that could not be anchored to a diff line and were folded into the body. */
  readonly outOfDiff: readonly Finding[];
}

function chooseBody(event: ReviewEvent, hasComments: boolean, post: Config['post']): string {
  if (event === 'APPROVE') return hasComments ? post.approve_body : post.approve_body_no_findings;
  // Not an approval, so never use the LGTM wording here.
  return hasComments ? post.comment_body : post.comment_body_no_findings;
}

/** Turns classified findings into exactly what will be sent to the GitHub reviews API. */
export function planReview(input: {
  classified: Classified;
  commentable: CommentableLines;
  isOwnPr: boolean;
  mode: PostMode;
  post: Config['post'];
}): ReviewPlan {
  const { classified, commentable, post } = input;
  const { event } = decideEvent(classified, {
    isOwnPr: input.isOwnPr,
    mode: input.mode,
    severityOnFindings: post.severity_on_findings,
  });

  const inDiff = classified.postable.filter((f) => isCommentable(commentable, f.file, f.line));
  const outOfDiff = classified.postable.filter((f) => !isCommentable(commentable, f.file, f.line));
  const comments = inDiff.map((f) => ({ path: f.file, line: f.line, body: formatCommentBody(f) }));

  const base = chooseBody(event, classified.postable.length > 0, post);
  const extra = outOfDiff.map(
    (f) =>
      `- \`${f.file}:${f.line}\` ${SEVERITY_LABEL[f.severity]}: ${sanitizeMarkdown(f.title)}\n\n  ${sanitizeMarkdown(f.body).replace(/\n/g, '\n  ')}`,
  );
  const body = extra.length > 0 ? `${base}\n\n---\n\n${extra.join('\n\n')}` : base;

  return { event, body, comments, outOfDiff };
}
