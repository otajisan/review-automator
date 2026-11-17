import { describe, expect, it } from 'vitest';
import {
  classify,
  decideEvent,
  formatCommentBody,
  numberFindings,
  pickGroups,
  selectFindings,
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

describe('numberFindings', () => {
  it('numbers postable, then uncertain, then nits, and points back into the original list', () => {
    const findings = [
      finding({ id: 'N1', severity: 'nit' }),
      finding({ id: 'R1', verification: 'refuted' }),
      finding({ id: 'U1', severity: 'must_fix', verification: 'uncertain' }),
      finding({ id: 'S1', severity: 'should_fix' }),
    ];

    const numbered = numberFindings(findings);

    expect(numbered.map((x) => [x.n, x.finding.id, x.index, x.group])).toEqual([
      [1, 'S1', 3, 'postable'],
      [2, 'U1', 2, 'uncertain'],
      [3, 'N1', 0, 'nit'],
    ]);
  });
});

describe('pickGroups', () => {
  it('splits numbered findings into groups of ten, up to forty', () => {
    const findings = Array.from({ length: 45 }, (_, i) => finding({ id: `S${i}`, line: i + 1 }));

    const groups = pickGroups(findings);

    expect(groups.map((g) => g.length)).toEqual([10, 10, 10, 10]);
    expect(groups[1]?.[0]?.n).toBe(11);
  });
});

describe('selectFindings', () => {
  const mustFix = finding({ id: 'M1', severity: 'must_fix', verification: 'confirmed', line: 1 });
  const should = finding({ id: 'S1', line: 2 });
  const nit = finding({ id: 'N1', severity: 'nit', line: 3 });
  const unsure = finding({ id: 'U1', severity: 'must_fix', verification: 'uncertain', line: 4 });
  const refuted = finding({ id: 'R1', verification: 'refuted', line: 5 });
  const all = [mustFix, should, nit, unsure, refuted];

  it('posts what classify would when nothing was picked (older notifications)', () => {
    expect(selectFindings(all, undefined)).toEqual(classify(all));
  });

  it('posts only the picked findings', () => {
    const c = selectFindings(all, new Map([[0, [1, 2]]]));

    expect(c.postable.map((f) => f.id)).toEqual(['S1', 'N1']);
    expect(c.hasMustFix).toBe(false);
  });

  it('allows approval once every must_fix is unchecked', () => {
    const c = selectFindings([mustFix, should], new Map([[0, [1]]]));

    expect(decideEvent(c, { isOwnPr: false, mode: 'review', severityOnFindings: 'COMMENT' }).event).toBe(
      'APPROVE',
    );
  });

  it('treats a picked uncertain must_fix as a must_fix', () => {
    const c = selectFindings(all, new Map([[0, [3]]]));

    expect(c.postable.map((f) => f.id)).toEqual(['U1']);
    expect(c.hasMustFix).toBe(true);
  });

  it('still blocks approval over an uncertain must_fix that was left unchecked', () => {
    const c = selectFindings(all, new Map([[0, []]]));

    expect(c.postable).toEqual([]);
    expect(c.hasUnresolvedMustFix).toBe(true);
  });

  it('ignores indices that are out of range, refuted, or not in the picked group', () => {
    const c = selectFindings(all, new Map([[0, [4, 99, -1]]]));

    expect(c.postable).toEqual([]);
  });

  it('keeps the default for a group the owner never touched', () => {
    const many = Array.from({ length: 12 }, (_, i) => finding({ id: `S${i}`, line: i + 1 }));

    const c = selectFindings(many, new Map([[0, [0]]]));

    expect(c.postable.map((f) => f.id)).toEqual(['S0', 'S10', 'S11']);
  });

  it('posts findings beyond the pickable ones as before', () => {
    const many = Array.from({ length: 42 }, (_, i) => finding({ id: `S${i}`, line: i + 1 }));

    const c = selectFindings(many, new Map([0, 1, 2, 3].map((g) => [g, []])));

    expect(c.postable.map((f) => f.id)).toEqual(['S40', 'S41']);
  });
});
