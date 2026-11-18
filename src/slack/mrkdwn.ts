import { redactSecrets } from '../lib/secrets.js';

/** Slack rejects section text over 3000 characters; keep a margin. */
export const SECTION_LIMIT = 2900;

const FENCE = '```';
const FENCE_LINE = /^\s*```/;
/** ```code``` on a single line: code, but it neither opens nor closes a block. */
const ONE_LINE_FENCE = /^\s*```.+```\s*$/;
/** An escaped character such as `&amp;` cut short at the end of a piece. */
const PARTIAL_ENTITY = /&[a-z]{0,5}$/;

function togglesFence(line: string): boolean {
  return FENCE_LINE.test(line) && !ONE_LINE_FENCE.test(line);
}

/**
 * Slack mrkdwn treats &, <, > as control characters. Secret-like strings are masked too: the text
 * shown here comes from the PR or the model, and the channel may be wider than the PR's audience.
 */
export function escapeMrkdwn(text: string): string {
  return redactSecrets(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rewrites the Markdown that is not inside inline code. */
function convertProse(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  const text = heading ? `**${heading[1] ?? ''}**` : line;
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : // A link target is shown as code: as plain text Slack would make it a live link again.
          part.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 (`$2`)'),
    )
    .join('');
}

/**
 * Model-written Markdown as Slack mrkdwn. Escaping comes first, so nothing in the input can turn
 * into a Slack link, mention or broadcast; link targets are shown as code.
 */
export function toMrkdwn(markdown: string): string {
  let inFence = false;
  return escapeMrkdwn(markdown)
    .split('\n')
    .map((line) => {
      if (togglesFence(line)) {
        inFence = !inFence;
        return FENCE;
      }
      return inFence || FENCE_LINE.test(line) ? line : convertProse(line);
    })
    .join('\n');
}

/** Where to cut `text` at or before `max` without splitting an emoji or an escaped character. */
function safeCut(text: string, max: number): number {
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const entity = PARTIAL_ENTITY.exec(text.slice(0, end));
  return entity && entity.index > 0 ? entity.index : end;
}

function splitLong(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const end = safeCut(line, max);
  return [line.slice(0, end), ...splitLong(line.slice(end), max)];
}

/**
 * Splits mrkdwn into pieces of at most `limit` characters, on line boundaries. A code block cut in
 * two is closed at the end of one piece and reopened at the start of the next, so both render.
 */
export function chunkMrkdwn(text: string, limit = SECTION_LIMIT): string[] {
  // Room to close a code block that is still open when a piece ends.
  const max = limit - FENCE.length - 1;
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let added = 0;
  let inFence = false;

  const flush = (): void => {
    chunks.push((inFence ? [...lines, FENCE] : lines).join('\n'));
    lines = inFence ? [FENCE] : [];
    size = inFence ? FENCE.length : 0;
    added = 0;
  };

  for (const line of text.split('\n').flatMap((l) => splitLong(l, max - FENCE.length - 1))) {
    const isFence = togglesFence(line);
    // A closing fence may use the room kept for closing the block.
    const room = isFence && inFence ? limit : max;
    const next = lines.length > 0 ? size + 1 + line.length : line.length;
    if (next > room && added > 0) flush();
    size = lines.length > 0 ? size + 1 + line.length : line.length;
    lines = [...lines, line];
    added += 1;
    if (isFence) inFence = !inFence;
  }
  if (added > 0) chunks.push(lines.join('\n'));
  return chunks;
}
