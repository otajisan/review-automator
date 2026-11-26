import bolt, { type webApi } from '@slack/bolt';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { Picks } from '../review/decision.js';
import type { IncomingMessage, Service } from '../service.js';
import type { SlackPort } from './port.js';

const { App, LogLevel } = bolt;

/** Adapts the Bolt Web API client to the narrow port the service depends on. */
export function webClientPort(client: webApi.WebClient): SlackPort {
  return {
    async postMessage({ channel, text, blocks, threadTs }) {
      const res = await client.chat.postMessage({
        channel,
        text,
        unfurl_links: false,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      return { ts: res.ts };
    },
    async updateMessage({ channel, ts, text, blocks }) {
      await client.chat.update({ channel, ts, text, blocks });
    },
    async postEphemeral({ channel, user, text }) {
      await client.chat.postEphemeral({ channel, user, text });
    },
    async addReaction({ channel, ts, name }) {
      await client.reactions.add({ channel, timestamp: ts, name });
    },
    async removeReaction({ channel, ts, name }) {
      await client.reactions.remove({ channel, timestamp: ts, name });
    },
    async permalink({ channel, ts }) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts });
      return res.permalink;
    },
    async threadParentText({ channel, threadTs }) {
      // The first message returned for a thread is its parent.
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 1, inclusive: true });
      return res.messages?.[0]?.text;
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Message events are a wide union in Bolt's types; we only need a few string fields.
 * With `botUserId`, a message that mentions the bot is flagged: the mention handler owns it.
 */
export function toIncomingMessage(raw: unknown, botUserId?: string): IncomingMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const channel = str(m['channel']);
  const ts = str(m['ts']);
  if (!channel || !ts) return undefined;
  const optional = {
    user: str(m['user']),
    text: str(m['text']),
    subtype: str(m['subtype']),
    botId: str(m['bot_id']),
    threadTs: str(m['thread_ts']),
  };
  const mentionsBot = botUserId !== undefined && (optional.text?.includes(`<@${botUserId}>`) ?? false);
  return {
    channel,
    ts,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    ...(mentionsBot ? { mentionsBot } : {}),
  };
}

const PICK_ACTION = /^ra_pick_(\d+)$/;
const INDEX = /^\d+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Checked values of one checkbox element, keeping only well-formed finding indices. */
function checkedIndices(element: unknown): number[] {
  const selected = record(element)?.['selected_options'];
  if (!Array.isArray(selected)) return [];
  return selected
    .map((o) => str(record(o)?.['value']))
    .filter((v): v is string => v !== undefined && INDEX.test(v))
    .map(Number);
}

/**
 * The finding checkboxes as they were when a button was pressed (`body.state` of a block action).
 * Undefined when the message had none, e.g. a notification from before checkboxes existed.
 */
export function picksFromState(state: unknown): Picks | undefined {
  const values = record(record(state)?.['values']) ?? {};
  const entries = Object.values(values).flatMap((block) =>
    Object.entries(record(block) ?? {}).flatMap(([actionId, element]) => {
      const group = PICK_ACTION.exec(actionId)?.[1];
      return group === undefined ? [] : [[Number(group), checkedIndices(element)] as const];
    }),
  );
  return entries.length > 0 ? new Map(entries) : undefined;
}

function withPicks(picks: Picks | undefined): { picks?: Picks } {
  return picks ? { picks } : {};
}

export interface SlackApp {
  readonly port: SlackPort;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackApp(opts: {
  botToken: string;
  appToken: string;
  logger: Logger;
  service: () => Service;
}): SlackApp {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
    // The default retries a failing call for about half an hour; a few quick retries are enough here.
    clientOptions: { retryConfig: { retries: 3 }, timeout: 30_000 },
  });
  const log = opts.logger.child({ component: 'slack' });

  app.message(({ message, context }) => {
    const incoming = toIncomingMessage(message, context.botUserId);
    if (!incoming) return Promise.resolve();
    // Do not hold the Socket Mode ack; a review takes minutes and is queued anyway.
    void opts
      .service()
      .handleMessage(incoming)
      .catch((err: unknown) => log.error({ err: errorMessage(err) }, 'message handler failed'));
    return Promise.resolve();
  });

  // "@review-automator <PR link>": review it even if it would normally be skipped.
  app.event('app_mention', ({ event }) => {
    const incoming = toIncomingMessage(event);
    if (!incoming) return Promise.resolve();
    void opts
      .service()
      .handleMention(incoming)
      .catch((err: unknown) => log.error({ err: errorMessage(err) }, 'mention handler failed'));
    return Promise.resolve();
  });

  app.action({ type: 'block_actions', action_id: /^ra_/ }, async ({ ack, body, action }) => {
    await ack(); // Slack requires an ack within 3 seconds; the work continues after it.
    // Ticking a finding changes nothing yet; its state is read when a button is pressed.
    if (PICK_ACTION.test(action.action_id)) return;
    const value = 'value' in action ? str(action.value) : undefined;
    if (!value) {
      log.warn({ actionId: action.action_id }, 'button without a value ignored');
      return;
    }
    void opts
      .service()
      .handleAction({
        actionId: action.action_id,
        value,
        userId: body.user.id,
        ...(body.channel?.id ? { channel: body.channel.id } : {}),
        ...withPicks(picksFromState(body.state)),
      })
      .catch((err: unknown) => log.error({ err: errorMessage(err) }, 'action handler failed'));
  });

  app.error((err) => {
    log.error({ err: errorMessage(err) }, 'bolt error');
    return Promise.resolve();
  });

  return {
    port: webClientPort(app.client),
    start: async () => {
      await app.start();
    },
    stop: async () => {
      await app.stop();
    },
  };
}
