import { describe, expect, it } from 'vitest';
import { classify } from '../../src/review/decision.js';
import {
  ACTIONS,
  actionValue,
  escapeMrkdwn,
  notificationBlocks,
  notificationText,
  resolvedBlocks,
  staleBlocks,
} from '../../src/slack/blocks.js';
import type { ReviewRecord } from '../../src/store/reviews.js';
import { finding, HEAD_SHA } from '../helpers/fixtures.js';

const rec: ReviewRecord = {
  id: '20261026-abcdefabcdef',
  pr: {
    owner: 'acme',
    repo: 'api',
    number: 7,
    url: 'https://github.com/acme/api/pull/7',
    title: 'Fix <b> & co',
    author: 'alice',
  },
  requestedBy: 'U0REQ0001',
  source: { channel: 'C0WATCH01', ts: '1.1' },
  status: 'notified',
  requestedHeadSha: HEAD_SHA,
  headSha: HEAD_SHA,
  result: { complete: true, summary: 'Adds a thing', findings: [] },
  costUsd: 0.5,
  createdAt: 'x',
  updatedAt: 'x',
};

const view = (overrides = {}) => ({
  ownerUserId: 'U0OWNER01',
  classified: classify([]),
  verdict: 'approve' as const,
  severityOnFindings: 'COMMENT',
  inlineCount: 0,
  ...overrides,
});

function buttons(blocks: unknown[]): { action_id: string; value: string; text: { text: string } }[] {
  const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as
    { elements: never[] } | undefined;
  return actions?.elements ?? [];
}

describe('notificationBlocks', () => {
  it('offers a one-click LGTM approval when there is nothing to fix', () => {
    const btns = buttons(notificationBlocks(rec, view()));

    expect(btns.map((b) => [b.action_id, b.text.text])).toEqual([
      [ACTIONS.postReview, 'Approve (LGTM)'],
      [ACTIONS.dismiss, 'Dismiss'],
    ]);
    expect(btns.every((b) => b.value === actionValue(rec))).toBe(true);
  });

  it('offers approve-with-comments and comments-only when there are should_fix findings', () => {
    const btns = buttons(
      notificationBlocks(rec, view({ classified: classify([finding()]), inlineCount: 1 })),
    );

    expect(btns.map((b) => b.text.text)).toEqual(['Post comments & Approve', 'Comments only', 'Dismiss']);
  });

  it('never offers approval when a must_fix exists', () => {
    const classified = classify([finding({ severity: 'must_fix', verification: 'confirmed' })]);

    const blocks = notificationBlocks(rec, view({ classified, verdict: 'must_fix', inlineCount: 1 }));

    expect(buttons(blocks).map((b) => b.text.text)).toEqual(['Post comments', 'Dismiss']);
    expect(JSON.stringify(blocks)).toContain('Must-fix issues found');
  });

  it('escapes Slack control characters from PR content', () => {
    expect(JSON.stringify(notificationBlocks(rec, view()))).toContain('Fix &lt;b&gt; &amp; co');
  });

  it('lists uncertain findings separately and notes out-of-diff ones', () => {
    const classified = classify([
      finding(),
      finding({ id: 'C2', severity: 'must_fix', verification: 'uncertain', title: 'Maybe' }),
    ]);

    const json = JSON.stringify(notificationBlocks(rec, view({ classified, inlineCount: 0 })));

    expect(json).toContain('Needs your judgement');
    expect(json).toContain('Maybe');
    expect(json).toContain('1 finding(s) are outside the diff');
  });

  it('truncates very long summaries to fit Slack limits', () => {
    const long = { ...rec, result: { complete: true, summary: 'x'.repeat(5000), findings: [] } };

    const sections = notificationBlocks(long, view()).filter((b) => b.type === 'section') as {
      text: { text: string };
    }[];

    expect(Math.max(...sections.map((s) => s.text.text.length))).toBeLessThanOrEqual(2900);
  });
});

describe('other blocks', () => {
  it('mentions the owner in the fallback text', () => {
    expect(notificationText(rec, 'U0OWNER01')).toMatch(/^<@U0OWNER01> Review ready: acme\/api#7/);
  });

  it('resolved blocks have no buttons', () => {
    expect(buttons(resolvedBlocks(rec, 'done'))).toEqual([]);
  });

  it('stale blocks offer a re-review', () => {
    expect(buttons(staleBlocks(rec, 'new commits')).map((b) => b.action_id)).toEqual([ACTIONS.rereview]);
  });

  it('masks secret-like text before it reaches Slack', () => {
    const token = `xoxb-${'1'.repeat(12)}-abcdef`;
    const leaky = { ...rec, result: { complete: true, summary: `found ${token}`, findings: [] } };

    const json = JSON.stringify(notificationBlocks(leaky, view()));

    expect(json).not.toContain(token);
    expect(json).toContain('[redacted]');
  });

  it('escapeMrkdwn escapes &, <, >', () => {
    expect(escapeMrkdwn('<@U1> & >')).toBe('&lt;@U1&gt; &amp; &gt;');
  });
});
