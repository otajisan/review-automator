import bolt, { type webApi } from '@slack/bolt';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
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
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Message events are a wide union in Bolt's types; we only need a few string fields. */
export function toIncomingMessage(raw: unknown): IncomingMessage | undefined {
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
  };
  return {
    channel,
    ts,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
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

  app.message(({ message }) => {
    const incoming = toIncomingMessage(message);
    if (!incoming) return Promise.resolve();
    // Do not hold the Socket Mode ack; a review takes minutes and is queued anyway.
    void opts
      .service()
      .handleMessage(incoming)
      .catch((err: unknown) => log.error({ err: errorMessage(err) }, 'message handler failed'));
    return Promise.resolve();
  });

  app.action({ type: 'block_actions', action_id: /^ra_/ }, async ({ ack, body, action }) => {
    await ack(); // Slack requires an ack within 3 seconds; the work continues after it.
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
