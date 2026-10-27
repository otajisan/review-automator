import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileReviewStore, newReviewId, type NewReview } from '../../src/store/reviews.js';
import { HEAD_SHA } from '../helpers/fixtures.js';

const input: NewReview = {
  pr: { owner: 'acme', repo: 'api', number: 7, url: 'u', title: 't', author: 'alice' },
  requestedBy: 'U0REQ0001',
  source: { channel: 'C0WATCH01', ts: '1.1' },
  requestedHeadSha: HEAD_SHA,
};

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ra-store-'));
  return { dir, store: await createFileReviewStore(dir, () => new Date('2026-10-26T00:00:00Z')) };
}

describe('createFileReviewStore', () => {
  it('creates queued records with ISO timestamps and persists them', async () => {
    const { dir, store } = await freshStore();

    const rec = await store.create(input);

    expect(rec.status).toBe('queued');
    expect(rec.createdAt).toBe('2026-10-26T00:00:00.000Z');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'reviews', `${rec.id}.json`), 'utf8'));
    expect(onDisk).toEqual(rec);
  });

  it('reloads records written by a previous process', async () => {
    const { dir, store } = await freshStore();
    const rec = await store.create(input);

    const reopened = await createFileReviewStore(dir);

    expect(await reopened.get(rec.id)).toEqual(rec);
  });

  it('returns a new object on update and leaves the old one untouched', async () => {
    const { store } = await freshStore();
    const rec = await store.create(input);

    const updated = await store.update(rec.id, { status: 'running' });

    expect(updated.status).toBe('running');
    expect(rec.status).toBe('queued');
  });

  it('lets only one of two concurrent transitions win', async () => {
    const { store } = await freshStore();
    const rec = await store.create(input);
    await store.update(rec.id, { status: 'notified' });

    const [a, b] = await Promise.all([
      store.transition(rec.id, ['notified'], 'posting'),
      store.transition(rec.id, ['notified'], 'posting'),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('finds an earlier review of the same head, ignoring failed ones and case', async () => {
    const { store } = await freshStore();
    const ok = await store.create(input);
    const failed = await store.create({ ...input, requestedHeadSha: 'f'.repeat(40) });
    await store.update(failed.id, { status: 'failed' });

    expect((await store.findForHead({ owner: 'ACME', repo: 'Api', number: 7 }, HEAD_SHA))?.id).toBe(ok.id);
    expect(await store.findForHead(input.pr, 'f'.repeat(40))).toBeUndefined();
  });

  it('also finds a review by the head it actually reviewed', async () => {
    const { store } = await freshStore();
    const rec = await store.create(input);
    await store.update(rec.id, { headSha: 'b'.repeat(40) });

    expect((await store.findForHead(input.pr, 'b'.repeat(40)))?.id).toBe(rec.id);
  });

  it('lists queued and running records as interrupted', async () => {
    const { store } = await freshStore();
    const a = await store.create(input);
    const b = await store.create(input);
    await store.update(b.id, { status: 'posted' });

    expect((await store.listInterrupted()).map((r) => r.id)).toEqual([a.id]);
  });

  it('rejects ids that could escape the directory', async () => {
    const { store } = await freshStore();

    expect(await store.get('../../etc/passwd')).toBeUndefined();
    await expect(store.update('../x', {})).rejects.toThrow(/invalid review id/);
  });

  it('skips corrupt files instead of crashing on start', async () => {
    const { dir, store } = await freshStore();
    await store.create(input);
    await writeFile(path.join(dir, 'reviews', 'broken.json'), '{');

    const reopened = await createFileReviewStore(dir);

    expect((await reopened.listInterrupted()).length).toBe(1);
    expect((await readdir(path.join(dir, 'reviews'))).length).toBe(2);
  });

  it('generates sortable, path-safe ids', () => {
    expect(newReviewId(new Date('2026-10-26T00:00:00Z'))).toMatch(/^20261026-[0-9a-f]{12}$/);
  });
});
