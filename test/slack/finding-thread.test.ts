import { describe, expect, it } from 'vitest';
import { findingThreadMessages } from '../../src/slack/finding-thread.js';
import { finding } from '../helpers/fixtures.js';

const sectionTexts = (blocks: unknown[]): string[] =>
  blocks
    .filter((b) => (b as { type: string }).type === 'section')
    .map((b) => (b as { text: { text: string } }).text.text);

describe('findingThreadMessages', () => {
  it('posts every finding in full, keeping its line breaks', () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'z'.repeat(40)}`).join('\n');

    const [msg] = findingThreadMessages([finding({ body })]);

    const text = sectionTexts(msg?.blocks ?? []).join('\n');
    expect(text).toContain('line 0:');
    expect(text).toContain('line 99:');
    expect(text).toContain('\nline 50:');
    expect(sectionTexts(msg?.blocks ?? []).every((t) => t.length <= 3000)).toBe(true);
  });

  it('numbers findings in the order the notification lists them', () => {
    const msgs = findingThreadMessages([
      finding({ id: 'N1', severity: 'nit', title: 'Nit one' }),
      finding({ id: 'U1', severity: 'must_fix', verification: 'uncertain', title: 'Unsure' }),
      finding({ id: 'S1', severity: 'should_fix', title: 'Should' }),
      finding({ id: 'M1', severity: 'must_fix', verification: 'confirmed', title: 'Must' }),
    ]);

    expect(msgs.map((m) => m.text)).toEqual([
      expect.stringMatching(/^#1 .*Must/),
      expect.stringMatching(/^#2 .*Should/),
      expect.stringMatching(/^#3 .*Unsure/),
      expect.stringMatching(/^#4 .*Nit one/),
    ]);
  });

  it('lists refuted findings together, after the numbered ones', () => {
    const msgs = findingThreadMessages([
      finding({ title: 'Kept' }),
      finding({ id: 'R1', verification: 'refuted', title: 'Wrong one' }),
      finding({ id: 'R2', verification: 'refuted', title: 'Wrong two' }),
    ]);

    expect(msgs).toHaveLength(2);
    const last = JSON.stringify(msgs[1]);
    expect(last).toContain('Wrong one');
    expect(last).toContain('Wrong two');
    expect(last).toMatch(/refuted/i);
  });

  it('splits a huge finding across messages to stay within 50 blocks', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `row ${i} ${'q'.repeat(40)}`).join('\n');

    const msgs = findingThreadMessages([finding({ body })]);

    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.blocks.length <= 50)).toBe(true);
    const all = msgs.flatMap((m) => sectionTexts(m.blocks)).join('\n');
    expect(all).toContain('row 2999 ');
  });

  it('escapes model-written text', () => {
    const [msg] = findingThreadMessages([finding({ title: 'a <b>', body: 'hi <!channel>' })]);

    expect(JSON.stringify(msg)).not.toContain('<!channel>');
    expect(JSON.stringify(msg)).toContain('a &lt;b&gt;');
  });

  it('does not send an empty section for a blank body', () => {
    const [msg] = findingThreadMessages([finding({ body: '\n  \n' })]);

    expect(sectionTexts(msg?.blocks ?? []).every((t) => t.trim().length > 0)).toBe(true);
  });

  it('caps how many replies one review can produce', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `row ${i} ${'q'.repeat(60)}`).join('\n');
    const findings = Array.from({ length: 20 }, (_, i) => finding({ id: `S${i}`, line: i + 1, body }));

    const msgs = findingThreadMessages(findings);

    expect(msgs.length).toBeLessThanOrEqual(30);
    expect(JSON.stringify(msgs.at(-1))).toMatch(/not shown/);
  });

  it('still shows every finding when earlier ones are too long to show in full', () => {
    // Each long body needs two messages: the first 15 findings alone use up the 30 allowed.
    const long = Array.from({ length: 2000 }, (_, i) => `row ${i} ${'q'.repeat(60)}`).join('\n');
    const findings = [
      ...Array.from({ length: 15 }, (_, i) =>
        finding({ id: `M${i}`, severity: 'must_fix', line: i + 1, body: long }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        finding({ id: `S${i}`, line: i + 100, title: `Later ${i}`, body: `body of later ${i}` }),
      ),
    ];

    const msgs = findingThreadMessages(findings);

    expect(msgs.length).toBeLessThanOrEqual(30);
    const all = JSON.stringify(msgs);
    for (let i = 0; i < 5; i += 1) expect(all).toContain(`body of later ${i}`);
    expect(JSON.stringify(msgs.at(-1))).toMatch(/not shown \(#\d+/);
  });

  it('returns nothing when there are no findings', () => {
    expect(findingThreadMessages([])).toEqual([]);
  });
});
