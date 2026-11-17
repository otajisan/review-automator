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

  it('offers posting the selection with or without approval when there are should_fix findings', () => {
    const btns = buttons(
      notificationBlocks(rec, view({ classified: classify([finding()]), inlineCount: 1 })),
    );

    expect(btns.map((b) => [b.action_id, b.text.text])).toEqual([
      [ACTIONS.postSelectedApprove, 'Post selected & Approve'],
      [ACTIONS.postCommentsOnly, 'Post selected'],
      [ACTIONS.dismiss, 'Dismiss'],
    ]);
  });

  it('puts commenting first when a must_fix exists, but still lets the owner approve after unchecking it', () => {
    const classified = classify([finding({ severity: 'must_fix', verification: 'confirmed' })]);

    const blocks = notificationBlocks(rec, view({ classified, verdict: 'must_fix', inlineCount: 1 }));

    expect(buttons(blocks).map((b) => b.text.text)).toEqual([
      'Post selected',
      'Post selected & Approve',
      'Dismiss',
    ]);
    expect(JSON.stringify(blocks)).toContain('Must-fix issues found');
    const approve = buttons(blocks).find((b) => b.action_id === ACTIONS.postSelectedApprove) as
      { confirm?: unknown } | undefined;
    expect(approve?.confirm).toBeDefined();
  });

  it('never offers approval over a must_fix the verifier could not settle, or on your own PR', () => {
    const classified = classify([finding({ severity: 'must_fix', verification: 'uncertain' })]);

    for (const verdict of ['unresolved', 'own_pr'] as const) {
      const labels = buttons(notificationBlocks(rec, view({ classified, verdict }))).map((b) => b.text.text);
      expect(labels).toEqual(['Post selected', 'Dismiss']);
    }
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

  it('never drops findings silently: every list says how many more there are', () => {
    const uncertain = Array.from({ length: 11 }, (_, i) =>
      finding({ id: `U${i}`, severity: 'must_fix', verification: 'uncertain', title: `Unsure ${i}` }),
    );

    const json = JSON.stringify(
      notificationBlocks(rec, view({ classified: classify(uncertain), verdict: 'unresolved' })),
    );

    expect(json).toContain('…and 3 more');
  });

  it('numbers findings and points to the thread for their full text', () => {
    const classified = classify([
      finding({ id: 'S1', title: 'Should' }),
      finding({ id: 'U1', severity: 'must_fix', verification: 'uncertain', title: 'Unsure' }),
    ]);

    const json = JSON.stringify(notificationBlocks(rec, view({ classified, inlineCount: 1 })));

    expect(json).toContain('*#1* 🟡');
    expect(json).toContain('*#2* 🔴');
    expect(json).toContain('full text of every finding is in the thread');
  });

  it('does not show a long finding body in the notification itself', () => {
    const classified = classify([finding({ body: 'B'.repeat(1000) })]);

    expect(JSON.stringify(notificationBlocks(rec, view({ classified, inlineCount: 1 })))).not.toContain(
      'BBBB',
    );
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

describe('finding checkboxes', () => {
  interface Checkbox {
    action_id: string;
    options: { value: string; text: { text: string }; description?: { text: string } }[];
    initial_options?: { value: string }[];
  }

  function checkboxes(blocks: unknown[]): Checkbox[] {
    return blocks
      .filter((b) => (b as { type: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Checkbox[] }).elements)
      .filter((e) => (e as unknown as { type: string }).type === 'checkboxes');
  }

  function blocksFor(findings: ReturnType<typeof finding>[]) {
    const withFindings = { ...rec, result: { complete: true, summary: 's', findings } };
    return notificationBlocks(withFindings, view({ classified: classify(findings), inlineCount: 1 }));
  }

  it('checks what would be posted today and leaves nits and uncertain findings unchecked', () => {
    const findings = [
      finding({ id: 'N1', severity: 'nit', title: 'A nit' }),
      finding({ id: 'S1', title: 'Should' }),
      finding({ id: 'U1', severity: 'must_fix', verification: 'uncertain', title: 'Unsure' }),
    ];

    const [group, ...rest] = checkboxes(blocksFor(findings));

    expect(rest).toEqual([]);
    expect(group?.action_id).toBe('ra_pick_0');
    expect(group?.options.map((o) => [o.value, o.text.text])).toEqual([
      ['1', '#1 🟡 src/a.ts:3 Should'],
      ['2', '#2 🔴 src/a.ts:3 Unsure'],
      ['0', '#3 🟢 src/a.ts:3 A nit'],
    ]);
    expect(group?.initial_options?.map((o) => o.value)).toEqual(['1']);
    expect(group?.options[1]?.description?.text).toMatch(/could not decide/);
  });

  it('splits more than ten findings into several checkbox groups and keeps labels short', () => {
    const findings = Array.from({ length: 23 }, (_, i) =>
      finding({ id: `S${i}`, line: i + 1, title: `T${i} ${'w'.repeat(150)}` }),
    );

    const blocks = blocksFor(findings);
    const groups = checkboxes(blocks);

    expect(groups.map((g) => [g.action_id, g.options.length])).toEqual([
      ['ra_pick_0', 10],
      ['ra_pick_1', 10],
      ['ra_pick_2', 3],
    ]);
    expect(groups.flatMap((g) => g.options).every((o) => o.text.text.length <= 75)).toBe(true);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it('says that findings past the fortieth cannot be unchecked', () => {
    const findings = Array.from({ length: 45 }, (_, i) => finding({ id: `S${i}`, line: i + 1 }));

    const blocks = blocksFor(findings);

    expect(checkboxes(blocks)).toHaveLength(4);
    expect(JSON.stringify(blocks)).toContain('#41');
  });

  it('masks secret-like text in labels', () => {
    const [group] = checkboxes(blocksFor([finding({ title: `key ghp_${'a'.repeat(36)}` })]));

    expect(group?.options[0]?.text.text).toContain('[redacted]');
  });
});
