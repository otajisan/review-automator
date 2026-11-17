import { describe, expect, it } from 'vitest';
import { chunkMrkdwn, escapeMrkdwn, toMrkdwn } from '../../src/slack/mrkdwn.js';

describe('escapeMrkdwn', () => {
  it('escapes Slack control characters', () => {
    expect(escapeMrkdwn('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });
});

describe('toMrkdwn', () => {
  it('turns Markdown bold and headings into Slack bold', () => {
    expect(toMrkdwn('## Why\nThis is **important**.')).toBe('*Why*\nThis is *important*.');
  });

  it('keeps line breaks', () => {
    expect(toMrkdwn('one\ntwo\n\nthree')).toBe('one\ntwo\n\nthree');
  });

  it('drops the language tag of a code fence and leaves code untouched', () => {
    const md = '```ts\nconst a = **b**;\n# not a heading\n```';

    expect(toMrkdwn(md)).toBe('```\nconst a = **b**;\n# not a heading\n```');
  });

  it('leaves inline code untouched', () => {
    expect(toMrkdwn('use `**x**` and [t](u) here')).toBe('use `**x**` and t (`u`) here');
  });

  it('shows Markdown link targets as code, so Slack does not turn them into links', () => {
    expect(toMrkdwn('see [docs](https://example.com/a?b=1&c=2)')).toBe(
      'see docs (`https://example.com/a?b=1&amp;c=2`)',
    );
  });

  it('keeps a code fence opened and closed on one line, and stays out of code afterwards', () => {
    expect(toMrkdwn('```const a = 1```\n**after**')).toBe('```const a = 1```\n*after*');
  });

  it('cannot be tricked into producing Slack mentions or links', () => {
    const out = toMrkdwn('ping <!channel> and <@U123> or <https://evil.example|click>');

    expect(out).not.toMatch(/<[!@h]/);
    expect(out).toContain('&lt;!channel&gt;');
  });

  it('masks secret-like text', () => {
    expect(toMrkdwn(`token ghp_${'a'.repeat(36)}`)).toContain('[redacted]');
  });
});

describe('chunkMrkdwn', () => {
  it('returns short text as one chunk', () => {
    expect(chunkMrkdwn('hello\nworld', 100)).toEqual(['hello\nworld']);
  });

  it('splits on line boundaries without losing text', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);

    const chunks = chunkMrkdwn(lines.join('\n'), 100);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  it('closes and reopens a code fence that spans two chunks', () => {
    const code = Array.from({ length: 20 }, (_, i) => `code line ${i}`);
    const text = ['before', '```', ...code, '```', 'after'].join('\n');

    const chunks = chunkMrkdwn(text, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
    for (const c of chunks) expect((c.match(/^```$/gm) ?? []).length % 2).toBe(0);
    expect(chunks.join('\n').replace(/\n```\n```/g, '')).toBe(text);
  });

  it('never cuts a long line inside an emoji or an escaped character', () => {
    // Pieces are 90 code units here: the emoji straddles the first cut, the entity the second.
    const line = `${'a'.repeat(89)}😀${'b'.repeat(85)}&amp;${'c'.repeat(100)}`;

    const chunks = chunkMrkdwn(line, 100);

    expect(chunks.join('')).toBe(line);
    for (const c of chunks) {
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(c).not.toMatch(/&[a-z]*$/);
    }
  });

  it('cuts a single line longer than the limit', () => {
    const chunks = chunkMrkdwn('y'.repeat(250), 100);

    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe('y'.repeat(250));
  });
});
