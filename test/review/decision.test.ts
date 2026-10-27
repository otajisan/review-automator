import { describe, expect, it } from 'vitest';
import {
  classify,
  decideEvent,
  formatCommentBody,
  planReview,
  sanitizeMarkdown,
} from '../../src/review/decision.js';
import { finding, testConfig } from '../helpers/fixtures.js';

const post = testConfig().post;
const commentable = new Map([['src/a.ts', new Set([3, 4])]]);

describe('classify', () => {
  it('drops refuted findings and keeps uncertain ones out of the PR', () => {
    const c = classify([
      finding({ id: 'C1', severity: 'must_fix', verification: 'refuted' }),
      finding({ id: 'C2', severity: 'must_fix', verification: 'uncertain' }),
      finding({ id: 'C3', severity: 'must_fix', verification: 'confirmed' }),
      finding({ id: 'C4', severity: 'nit' }),
    ]);

    expect(c.refuted.map((f) => f.id)).toEqual(['C1']);
    expect(c.uncertain.map((f) => f.id)).toEqual(['C2']);
    expect(c.postable.map((f) => f.id)).toEqual(['C3']);
    expect(c.nits.map((f) => f.id)).toEqual(['C4']);
    expect(c.hasMustFix).toBe(true);
  });

  it('treats unverified must_fix (verification skipped) as postable', () => {
    expect(classify([finding({ severity: 'must_fix', verification: 'not_verified' })]).hasMustFix).toBe(true);
  });

  it('orders by severity then location', () => {
    const c = classify([
      finding({ id: 'b', severity: 'should_fix', file: 'b.ts' }),
      finding({ id: 'a', severity: 'must_fix', file: 'z.ts', verification: 'confirmed' }),
      finding({ id: 'c', severity: 'should_fix', file: 'a.ts' }),
    ]);

    expect(c.postable.map((f) => f.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [finding({ id: 'b', file: 'b' }), finding({ id: 'a', file: 'a' })];

    classify(input);

    expect(input.map((f) => f.id)).toEqual(['b', 'a']);
  });
});

describe('decideEvent', () => {
  const none = classify([]);
  const mustFix = classify([finding({ severity: 'must_fix', verification: 'confirmed' })]);
  const base = { isOwnPr: false, mode: 'review' as const, severityOnFindings: 'COMMENT' as const };

  it('approves when nothing must be fixed', () => {
    expect(decideEvent(none, base)).toEqual({ event: 'APPROVE', blocker: null });
  });

  it('uses the configured event when a must_fix exists', () => {
    expect(decideEvent(mustFix, { ...base, severityOnFindings: 'REQUEST_CHANGES' })).toEqual({
      event: 'REQUEST_CHANGES',
      blocker: 'must_fix',
    });
  });

  it('never approves or requests changes on your own PR', () => {
    expect(decideEvent(mustFix, { ...base, isOwnPr: true, severityOnFindings: 'REQUEST_CHANGES' })).toEqual({
      event: 'COMMENT',
      blocker: 'own_pr',
    });
  });

  it('does not approve over a must_fix the verifier could not settle', () => {
    const unresolved = classify([finding({ severity: 'must_fix', verification: 'uncertain' })]);

    expect(decideEvent(unresolved, base)).toEqual({ event: 'COMMENT', blocker: 'unresolved' });
  });

  it('comments only when asked', () => {
    expect(decideEvent(none, { ...base, mode: 'comments_only' }).event).toBe('COMMENT');
  });
});

describe('planReview', () => {
  it('approves with the short LGTM body when there is nothing to say', () => {
    const plan = planReview({ classified: classify([]), commentable, isOwnPr: false, mode: 'review', post });

    expect(plan).toEqual({ event: 'APPROVE', body: 'LGTM!! :+1:', comments: [], outOfDiff: [] });
  });

  it('approves with the "commented where worth checking" body when should_fix exists', () => {
    const plan = planReview({
      classified: classify([finding()]),
      commentable,
      isOwnPr: false,
      mode: 'review',
      post,
    });

    expect(plan.event).toBe('APPROVE');
    expect(plan.body).toBe(post.approve_body);
    expect(plan.comments).toEqual([{ path: 'src/a.ts', line: 3, body: formatCommentBody(finding()) }]);
  });

  it('folds findings outside the diff into the body', () => {
    const outside = finding({ file: 'src/a.ts', line: 99, title: 'Out of diff' });

    const plan = planReview({
      classified: classify([outside]),
      commentable,
      isOwnPr: false,
      mode: 'review',
      post,
    });

    expect(plan.comments).toEqual([]);
    expect(plan.outOfDiff).toEqual([outside]);
    expect(plan.body).toContain('`src/a.ts:99`');
    expect(plan.body).toContain('Out of diff');
  });

  it('comments instead of approving when a must_fix exists', () => {
    const plan = planReview({
      classified: classify([finding({ severity: 'must_fix', verification: 'confirmed' })]),
      commentable,
      isOwnPr: false,
      mode: 'review',
      post,
    });

    expect(plan.event).toBe('COMMENT');
    expect(plan.body).toBe(post.comment_body);
  });
});

describe('formatCommentBody', () => {
  it('prefixes the severity label', () => {
    expect(formatCommentBody(finding({ severity: 'must_fix', title: 'T', body: 'B' }))).toBe(
      '**🔴 must fix: T**\n\nB',
    );
  });
});

describe('sanitizeMarkdown', () => {
  it('stops @-mentions of users and teams from notifying', () => {
    expect(sanitizeMarkdown('cc @alice and @org/team')).toBe('cc @\u200balice and @\u200borg/team');
  });

  it('leaves e-mail addresses and code alone', () => {
    expect(sanitizeMarkdown('mail a@b.c, `@decorator`')).toBe('mail a@b.c, `@decorator`');
  });

  it('turns remote images into plain links', () => {
    expect(sanitizeMarkdown('![x](https://t.example/p.gif)')).toBe('[x](https://t.example/p.gif)');
  });

  it('neutralises reference-style images and raw media HTML', () => {
    expect(sanitizeMarkdown('![pixel][p]\n\n[p]: https://t.example/p.gif')).toBe(
      '[pixel][p]\n\n[p]: https://t.example/p.gif',
    );
    expect(sanitizeMarkdown('<img src="https://t.example/p.gif">')).toBe(
      '&lt;img src="https://t.example/p.gif">',
    );
  });

  it('keeps ordinary HTML-looking code readable', () => {
    expect(sanitizeMarkdown('use `<div>` here')).toBe('use `<div>` here');
  });
});
