import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewEvent } from '../github/post-review.js';
import type { PrRef } from '../github/pr.js';
import { AppError } from '../lib/errors.js';
import type { ReviewResult } from '../review/schema.js';

export type ReviewStatus =
  'queued' | 'running' | 'notified' | 'posting' | 'posted' | 'dismissed' | 'stale' | 'failed';

export interface SlackLocation {
  readonly channel: string;
  readonly ts: string;
}

export interface ReviewRecord {
  readonly id: string;
  readonly pr: PrRef & { readonly url: string; readonly title: string; readonly author: string };
  readonly requestedBy: string;
  readonly source: SlackLocation;
  readonly status: ReviewStatus;
  /** Head commit the review was started for; dedupe key together with the PR. */
  readonly requestedHeadSha: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  /** Base branch the review compared against; a retargeted PR needs a new review. */
  readonly baseRef?: string;
  /**
   * Changes every time a notification is sent. Buttons carry it, so a button from an earlier
   * notification of the same record cannot act on a newer result.
   */
  readonly notificationNonce?: string;
  /** When the GitHub POST was last attempted; reconciliation waits a grace period after it. */
  readonly postAttemptAt?: string;
  readonly result?: ReviewResult;
  readonly costUsd?: number;
  readonly notification?: SlackLocation;
  readonly posted?: { readonly url: string; readonly event: ReviewEvent; readonly at: string };
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewReview = Omit<ReviewRecord, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

export interface ReviewStore {
  create(input: NewReview): Promise<ReviewRecord>;
  get(id: string): Promise<ReviewRecord | undefined>;
  update(id: string, patch: Partial<Omit<ReviewRecord, 'id' | 'createdAt'>>): Promise<ReviewRecord>;
  /**
   * Atomically moves a record from one of `from` to `to`. Returns undefined if the record is in
   * another state, which is how a double-clicked button is turned into a no-op.
   */
  transition(id: string, from: readonly ReviewStatus[], to: ReviewStatus): Promise<ReviewRecord | undefined>;
  /** A live review requested for, or performed on, this exact PR head, if any. */
  findForHead(pr: PrRef, headSha: string): Promise<ReviewRecord | undefined>;
  /** Records left in queued/running by a crash or restart. */
  listInterrupted(): Promise<ReviewRecord[]>;
  /** Records stuck in `posting` because the process stopped mid-post. */
  listPosting(): Promise<ReviewRecord[]>;
  /** Every record for this PR. */
  listForPr(pr: PrRef): Promise<ReviewRecord[]>;
}

const ID_RE = /^[a-z0-9-]{8,64}$/;

export function newReviewId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('hex')}`;
}

function samePr(a: PrRef, b: PrRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

/**
 * One JSON file per review under `<stateDir>/reviews`. Volume is a handful of reviews a day,
 * so a database would add a dependency without buying anything.
 */
export async function createFileReviewStore(
  stateDir: string,
  clock: () => Date = () => new Date(),
): Promise<ReviewStore> {
  const dir = path.join(stateDir, 'reviews');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cache = new Map<string, ReviewRecord>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as ReviewRecord;
      cache.set(rec.id, rec);
    } catch {
      // A corrupt file must not stop the daemon; it is simply ignored.
    }
  }

  const fileFor = (id: string) => {
    if (!ID_RE.test(id)) throw new AppError(`invalid review id: ${id}`);
    return path.join(dir, `${id}.json`);
  };

  // Writes are serialised so a transition() cannot interleave with an update() of the same record.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  async function persist(rec: ReviewRecord): Promise<ReviewRecord> {
    const file = fileFor(rec.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    cache.set(rec.id, rec);
    return rec;
  }

  function mustGet(id: string): ReviewRecord {
    fileFor(id); // validates the id before anything else
    const rec = cache.get(id);
    if (!rec) throw new AppError(`review ${id} not found`);
    return rec;
  }

  return {
    create: (input) =>
      serial(() => {
        const now = clock().toISOString();
        return persist({
          ...input,
          id: newReviewId(clock()),
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        });
      }),

    get: (id) => Promise.resolve(ID_RE.test(id) ? cache.get(id) : undefined),

    update: (id, patch) =>
      serial(() => persist({ ...mustGet(id), ...patch, updatedAt: clock().toISOString() })),

    transition: (id, from, to) =>
      serial(async () => {
        const rec = cache.get(id);
        if (!rec || !from.includes(rec.status)) return undefined;
        return persist({ ...rec, status: to, updatedAt: clock().toISOString() });
      }),

    findForHead: (pr, headSha) =>
      Promise.resolve(
        [...cache.values()].find(
          (r) =>
            samePr(r.pr, pr) &&
            (r.requestedHeadSha === headSha || r.headSha === headSha) &&
            // Failed and superseded (stale) reviews must not block a new one.
            r.status !== 'failed' &&
            r.status !== 'stale',
        ),
      ),

    listForPr: (pr) => Promise.resolve([...cache.values()].filter((r) => samePr(r.pr, pr))),

    listPosting: () => Promise.resolve([...cache.values()].filter((r) => r.status === 'posting')),

    listInterrupted: () =>
      Promise.resolve([...cache.values()].filter((r) => r.status === 'queued' || r.status === 'running')),
  };
}
