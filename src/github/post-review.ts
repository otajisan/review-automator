import { z } from 'zod';
import { PostError } from '../lib/errors.js';
import { ExecError } from '../lib/exec.js';
import type { Gh } from './gh.js';
import type { PrRef } from './pr.js';

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewPayload {
  readonly commit_id: string;
  readonly event: ReviewEvent;
  readonly body: string;
  readonly comments: readonly (InlineComment & { readonly side: 'RIGHT' })[];
}

export function buildReviewPayload(input: {
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: readonly InlineComment[];
}): ReviewPayload {
  return {
    commit_id: input.headSha,
    event: input.event,
    body: input.body,
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT' as const,
      body: c.body,
    })),
  };
}

const ReviewResponseSchema = z.object({ id: z.number(), html_url: z.string() });

export interface PostedReview {
  readonly id: number;
  readonly url: string;
}

/**
 * Creates the review in one API call so comments and the approval land atomically:
 * either the whole review appears on the PR, or nothing does.
 */
export async function postReview(gh: Gh, ref: PrRef, payload: ReviewPayload): Promise<PostedReview> {
  try {
    const res = await gh.json(
      [
        'api',
        '--method',
        'POST',
        `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
        '--input',
        '-',
      ],
      ReviewResponseSchema,
      { input: JSON.stringify(payload) },
    );
    return { id: res.id, url: res.html_url };
  } catch (err) {
    throw new PostError(`failed to post review to ${ref.owner}/${ref.repo}#${ref.number}`, { cause: err });
  }
}

const ExistingReviewSchema = z.object({
  user: z.string(),
  html_url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
});

const STATE_TO_EVENT: Record<string, ReviewEvent> = {
  APPROVED: 'APPROVE',
  CHANGES_REQUESTED: 'REQUEST_CHANGES',
  COMMENTED: 'COMMENT',
};

/**
 * Invisible marker appended to every posted review body. It identifies this exact submission, so
 * reconciliation after a lost response or a crash never confuses it with another review.
 */
export function reviewMarker(reviewId: string): string {
  return `<!-- review-automator:${reviewId} -->`;
}

/** The submitted review carrying `marker`, if GitHub has it. */
export async function findPostedReview(
  gh: Gh,
  ref: PrRef,
  login: string,
  marker: string,
): Promise<{ url: string; event: ReviewEvent } | undefined> {
  const out = await gh.run([
    'api',
    '--paginate',
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    '--jq',
    '.[] | {user: .user.login, html_url, state, body}',
  ]);
  const match = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ExistingReviewSchema.parse(JSON.parse(line)))
    .find(
      (r) =>
        r.user.toLowerCase() === login.toLowerCase() &&
        r.state !== 'PENDING' &&
        (r.body ?? '').includes(marker),
    );
  if (!match) return undefined;
  return { url: match.html_url, event: STATE_TO_EVENT[match.state] ?? 'COMMENT' };
}

/** True when GitHub answered with a 4xx: the review was definitely not created. */
export function isDefiniteRejection(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof ExecError) return /HTTP 4\d\d/.test(e.result.stderr);
  }
  return false;
}
