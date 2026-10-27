import type { KnownBlock } from '@slack/types';

/** The few Slack Web API calls the app makes. Kept narrow so handlers are testable without Bolt. */
export interface SlackPort {
  postMessage(args: {
    channel: string;
    text: string;
    blocks?: KnownBlock[];
    threadTs?: string;
  }): Promise<{ ts: string }>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<void>;
  postEphemeral(args: { channel: string; user: string; text: string }): Promise<void>;
  addReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  removeReaction(args: { channel: string; ts: string; name: string }): Promise<void>;
  permalink(args: { channel: string; ts: string }): Promise<string | undefined>;
}
