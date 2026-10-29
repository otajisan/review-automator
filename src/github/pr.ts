import picomatch from 'picomatch';
import { z } from 'zod';
import type { Gh } from './gh.js';

export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PrInfo extends PrRef {
  readonly url: string;
  readonly title: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly author: string;
  readonly headSha: string;
  readonly baseRef: string;
  /** PR description. Untrusted; handed to the review as a file, never as instructions. */
  readonly body: string;
}

// Slack delivers links as `<https://github.com/o/r/pull/1|label>`; matching the bare URL inside works for both forms.
const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/** owner/repo become path segments of the local clone; `.` and `..` must never get that far. */
function isSafeName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.startsWith('.');
}

export function prSlug(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** Every distinct PR referenced in a message, in order of appearance. */
export function extractPrRefs(text: string): PrRef[] {
  const seen = new Set<string>();
  const refs: PrRef[] = [];
  for (const m of text.matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = m;
    if (!owner || !repo || !num || !isSafeName(owner) || !isSafeName(repo)) continue;
    const ref = { owner, repo, number: Number(num) };
    const key = prSlug(ref).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** `allowed_repos` entries are globs over `owner/repo`, compared case-insensitively like GitHub does. */
export function isRepoAllowed(ref: PrRef, patterns: readonly string[]): boolean {
  const isMatch = picomatch(patterns as string[], { nocase: true });
  return isMatch(`${ref.owner}/${ref.repo}`);
}

const PrViewSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: z.object({ login: z.string() }),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  baseRefName: z.string(),
  body: z.string().nullable(),
});

export async function fetchPr(gh: Gh, ref: PrRef): Promise<PrInfo> {
  const view = await gh.json(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      `${ref.owner}/${ref.repo}`,
      '--json',
      'number,url,title,state,isDraft,author,headRefOid,baseRefName,body',
    ],
    PrViewSchema,
  );
  return {
    ...ref,
    url: view.url,
    title: view.title,
    state: view.state,
    isDraft: view.isDraft,
    author: view.author.login,
    headSha: view.headRefOid,
    baseRef: view.baseRefName,
    body: view.body ?? '',
  };
}

export async function fetchPrDiff(gh: Gh, ref: PrRef): Promise<string> {
  return gh.run(['pr', 'diff', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`]);
}

/** One file of `GET /pulls/{n}/files`; `patch` is missing for binary or very large files. */
const PrFileSchema = z.object({ filename: z.string(), patch: z.string().nullish() });

/** Rebuilds a unified diff from the files API, which still works when `gh pr diff` is refused as too large. */
export function diffFromFiles(
  files: readonly { filename: string; patch?: string | null | undefined }[],
): string {
  return files
    .filter((f) => typeof f.patch === 'string')
    .map(
      (f) =>
        `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`,
    )
    .join('');
}

async function fetchDiffFromFiles(gh: Gh, ref: PrRef): Promise<string> {
  const out = await gh.run([
    'api',
    '--paginate',
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`,
    '--jq',
    '.[] | {filename, patch}',
  ]);
  const files = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => PrFileSchema.parse(JSON.parse(line)));
  return diffFromFiles(files);
}

/**
 * The PR diff, degrading gracefully: `gh pr diff`, then the files API, then nothing (every finding
 * then goes into the review body instead of an inline comment). Never throws, so a large PR cannot
 * throw away a finished review.
 */
export async function fetchDiffForComments(
  gh: Gh,
  ref: PrRef,
  onFallback?: (step: 'files_api' | 'none', err: unknown) => void,
): Promise<string> {
  try {
    return await fetchPrDiff(gh, ref);
  } catch (err) {
    onFallback?.('files_api', err);
  }
  try {
    return await fetchDiffFromFiles(gh, ref);
  } catch (err) {
    onFallback?.('none', err);
    return '';
  }
}

/** Current merge base of `headSha` with `baseRef` on GitHub; changes if the base branch is rewritten. */
export async function fetchMergeBase(gh: Gh, ref: PrRef, baseRef: string, headSha: string): Promise<string> {
  const sha = (
    await gh.run([
      'api',
      `repos/${ref.owner}/${ref.repo}/compare/${baseRef}...${headSha}`,
      '--jq',
      '.merge_base_commit.sha',
    ])
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected merge base from GitHub: ${sha.slice(0, 50)}`);
  return sha;
}

const OwnerReviewSchema = z.object({ user: z.string(), state: z.string(), commit_id: z.string().nullable() });

/**
 * Whether `login`'s latest decisive review (approve, request changes, or a dismissal) approves
 * exactly `headSha`. An approval of an earlier commit does not count: new commits after an
 * approval are usually what the author wants looked at next.
 */
export async function ownerApprovedHead(
  gh: Gh,
  ref: PrRef & { readonly baseRef: string },
  login: string,
  headSha: string,
): Promise<boolean> {
  const out = await gh.run([
    'api',
    '--paginate',
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    '--jq',
    '.[] | {user: .user.login, state, commit_id}',
  ]);
  const decisive = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => OwnerReviewSchema.parse(JSON.parse(line)))
    .filter((r) => r.user.toLowerCase() === login.toLowerCase())
    .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED');
  const latest = decisive.at(-1); // the API lists reviews in submission order
  if (latest?.state !== 'APPROVED' || !latest.commit_id) return false;
  if (latest.commit_id === headSha) return true;
  // Commits after the approval that only merge the base branch in ("Update branch") do not change
  // what was approved, so the approval still stands — but a merge can also carry real changes
  // (a conflict resolution, an edit made while committing it). So the PR's own changes against
  // the base must be identical at the approved commit and at head.
  if (!(await onlyMergeCommitsBetween(gh, ref, latest.commit_id, headSha))) return false;
  const [approved, current] = await Promise.all([
    prChanges(gh, ref, ref.baseRef, latest.commit_id),
    prChanges(gh, ref, ref.baseRef, headSha),
  ]);
  return approved !== null && approved === current;
}

const CompareFilesSchema = z.object({
  n: z.number(),
  files: z.array(z.object({ filename: z.string(), status: z.string(), patch: z.string().nullish() })),
});

/** The compare API lists at most this many files; with more, the list is incomplete. */
const COMPARE_MAX_FILES = 300;

/**
 * The PR's changes at `sha` relative to its merge base with `baseRef`: per file, the added and
 * removed lines (hunk headers and context dropped, so a base branch moving underneath does not
 * count as a change). Null when that cannot be established: binary or oversized files have no
 * patch, and very large diffs are truncated.
 */
async function prChanges(gh: Gh, ref: PrRef, baseRef: string, sha: string): Promise<string | null> {
  const out = await gh.run([
    'api',
    `repos/${ref.owner}/${ref.repo}/compare/${baseRef}...${sha}`,
    '--jq',
    '{n: (.files | length), files: [.files[] | {filename, status, patch}]}',
  ]);
  const c = CompareFilesSchema.parse(JSON.parse(out));
  if (c.n >= COMPARE_MAX_FILES) return null;
  const parts: string[] = [];
  for (const f of [...c.files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    if (typeof f.patch !== 'string') return null;
    const changed = f.patch.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
    parts.push([f.filename, f.status, ...changed].join('\n'));
  }
  return parts.join('\n\0\n');
}

const PrCommitSchema = z.object({ sha: z.string(), parents: z.number() });

/**
 * True when every commit of the PR after `from` is a merge commit (the base branch merged in) and
 * the last one is `head`. Uses the PR's own commit list, which contains those merge commits but not
 * the base-branch commits they bring in; a plain compare would list those too.
 */
async function onlyMergeCommitsBetween(gh: Gh, ref: PrRef, from: string, head: string): Promise<boolean> {
  const out = await gh.run([
    'api',
    '--paginate',
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits`,
    '--jq',
    '.[] | {sha, parents: (.parents | length)}',
  ]);
  const commits = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => PrCommitSchema.parse(JSON.parse(line)));
  const at = commits.findIndex((c) => c.sha === from);
  // Not found: history was rewritten (force-push), or the list is truncated (GitHub caps it at 250).
  if (at === -1) return false;
  const after = commits.slice(at + 1);
  return after.length > 0 && after.at(-1)?.sha === head && after.every((c) => c.parents >= 2);
}
