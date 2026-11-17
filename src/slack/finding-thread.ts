import type { KnownBlock } from '@slack/types';
import { classify, numberFindings, type NumberedFinding } from '../review/decision.js';
import type { Finding } from '../review/schema.js';
import { chunkMrkdwn, escapeMrkdwn, SECTION_LIMIT, toMrkdwn } from './mrkdwn.js';

export const SEVERITY_ICON = { must_fix: '🔴', should_fix: '🟡', nit: '🟢' } as const;

const SEVERITY_NAME = { must_fix: 'must fix', should_fix: 'should fix', nit: 'nit' } as const;

/** Slack allows 50 blocks per message. */
const MAX_BLOCKS = 50;
/** Replies per review, so a runaway body cannot flood the channel or exhaust the rate limit. */
const MAX_MESSAGES = 30;

const GROUP_NOTE = {
  postable: undefined,
  uncertain: 'the verifier could not decide; unchecked by default',
  nit: 'unchecked by default',
} as const;

export interface ThreadMessage {
  readonly text: string;
  readonly blocks: KnownBlock[];
}

/** `🔴 \`file:line\` title`, escaped for mrkdwn. */
export function findingRef(f: Finding): string {
  return `${SEVERITY_ICON[f.severity]} \`${escapeMrkdwn(`${f.file}:${f.line}`)}\` ${escapeMrkdwn(f.title)}`;
}

function section(text: string): KnownBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, SECTION_LIMIT) }] };
}

function messagesFor({ n, finding: f, group }: NumberedFinding): ThreadMessage[] {
  const text = escapeMrkdwn(`#${n} ${SEVERITY_NAME[f.severity]} ${f.file}:${f.line} ${f.title}`);
  const meta = [
    SEVERITY_NAME[f.severity],
    `confidence ${f.confidence}`,
    `verification ${f.verification.replace('_', ' ')}`,
    GROUP_NOTE[group],
  ].filter((x): x is string => x !== undefined);
  const head: KnownBlock[] = [section(`*#${n}* ${findingRef(f)}`), context(meta.join(' · '))];
  const body = chunkMrkdwn(toMrkdwn(f.body))
    .filter((chunk) => chunk.trim().length > 0)
    .map(section);

  const first = body.slice(0, MAX_BLOCKS - head.length);
  const rest = body.slice(first.length);
  const perFollowUp = MAX_BLOCKS - 1;
  const followUps = Array.from({ length: Math.ceil(rest.length / perFollowUp) }, (_, i) => ({
    text: `${text} (continued)`,
    blocks: [context(`*#${n}* continued`), ...rest.slice(i * perFollowUp, (i + 1) * perFollowUp)],
  }));
  return [{ text, blocks: [...head, ...first] }, ...followUps];
}

function refutedMessage(refuted: readonly Finding[]): ThreadMessage {
  const lines = refuted.map((f) => `• ${findingRef(f)}`);
  return {
    text: `${refuted.length} finding(s) refuted by the verifier`,
    blocks: [
      section('🚫 *Refuted by the verifier* — never posted'),
      ...chunkMrkdwn(lines.join('\n'))
        .slice(0, MAX_BLOCKS - 1)
        .map(section),
    ],
  };
}

/**
 * Thread replies under the notification: each finding in full, numbered as in the notification,
 * so the owner can judge it before posting. Refuted findings are listed by title at the end.
 */
export function findingThreadMessages(findings: readonly Finding[]): ThreadMessage[] {
  const numbered = numberFindings(findings).flatMap(messagesFor);
  const { refuted } = classify(findings);
  const all = refuted.length > 0 ? [...numbered, refutedMessage(refuted)] : numbered;
  if (all.length <= MAX_MESSAGES) return all;
  const kept = all.slice(0, MAX_MESSAGES - 1);
  const dropped = all.length - kept.length;
  const note = `✂️ ${dropped} more message(s) not shown: the findings are too long for Slack. Check them on the PR after posting, or run \`pnpm review-once\`.`;
  return [...kept, { text: note, blocks: [section(note)] }];
}
