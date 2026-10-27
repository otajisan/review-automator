import { describe, expect, it } from 'vitest';
import { createGh } from '../../src/github/gh.js';
import { buildReviewPayload, postReview } from '../../src/github/post-review.js';
import { PostError } from '../../src/lib/errors.js';
import { argsStartWith, fakeExec } from '../helpers/fake-exec.js';

const SHA = 'b'.repeat(40);
const REF = { owner: 'acme', repo: 'api', number: 9 };

describe('buildReviewPayload', () => {
  it('pins the commit and marks every comment RIGHT side', () => {
    const payload = buildReviewPayload({
      headSha: SHA,
      event: 'APPROVE',
      body: 'LGTM',
      comments: [{ path: 'a.ts', line: 3, body: 'nit' }],
    });

    expect(payload).toEqual({
      commit_id: SHA,
      event: 'APPROVE',
      body: 'LGTM',
      comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'nit' }],
    });
  });
});

describe('postReview', () => {
  it('sends the payload on stdin to the reviews endpoint', async () => {
    const { exec, calls } = fakeExec([
      [
        argsStartWith('api'),
        () => JSON.stringify({ id: 1, html_url: 'https://github.com/acme/api/pull/9#r1' }),
      ],
    ]);
    const payload = buildReviewPayload({ headSha: SHA, event: 'COMMENT', body: 'b', comments: [] });

    const posted = await postReview(createGh(exec), REF, payload);

    expect(posted).toEqual({ id: 1, url: 'https://github.com/acme/api/pull/9#r1' });
    expect(calls[0]?.args).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/api/pulls/9/reviews',
      '--input',
      '-',
    ]);
    expect(JSON.parse(calls[0]?.opts?.input ?? '{}')).toEqual(payload);
  });

  it('wraps API failures in PostError', async () => {
    const { exec } = fakeExec([[argsStartWith('api'), () => ({ exitCode: 1, stderr: 'HTTP 422' })]]);
    const payload = buildReviewPayload({ headSha: SHA, event: 'COMMENT', body: 'b', comments: [] });

    await expect(postReview(createGh(exec), REF, payload)).rejects.toBeInstanceOf(PostError);
  });
});
