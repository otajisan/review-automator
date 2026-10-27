import { describe, expect, it, vi } from 'vitest';
import { toIncomingMessage, webClientPort } from '../../src/slack/app.js';

describe('toIncomingMessage', () => {
  it('keeps only the string fields the service needs', () => {
    expect(
      toIncomingMessage({
        channel: 'C1',
        ts: '1.2',
        user: 'U1',
        text: 'hi',
        bot_id: 'B1',
        subtype: 'bot_message',
        blocks: [],
      }),
    ).toEqual({ channel: 'C1', ts: '1.2', user: 'U1', text: 'hi', botId: 'B1', subtype: 'bot_message' });
  });

  it('omits absent optional fields', () => {
    expect(toIncomingMessage({ channel: 'C1', ts: '1.2' })).toEqual({ channel: 'C1', ts: '1.2' });
  });

  it('rejects events without channel or ts', () => {
    expect(toIncomingMessage({ ts: '1' })).toBeUndefined();
    expect(toIncomingMessage(null)).toBeUndefined();
  });
});

describe('webClientPort', () => {
  function client() {
    return {
      chat: {
        postMessage: vi.fn(() => Promise.resolve({ ok: true, ts: '9.9' })),
        update: vi.fn(() => Promise.resolve({ ok: true })),
        postEphemeral: vi.fn(() => Promise.resolve({ ok: true })),
        getPermalink: vi.fn(() => Promise.resolve({ ok: true, permalink: 'https://x' })),
      },
      reactions: {
        add: vi.fn(() => Promise.resolve({ ok: true })),
        remove: vi.fn(() => Promise.resolve({ ok: true })),
      },
    };
  }

  it('maps port calls onto the Web API with link unfurling off', async () => {
    const c = client();
    const port = webClientPort(c as never);

    const res = await port.postMessage({ channel: 'C', text: 't', threadTs: '1.1' });
    await port.addReaction({ channel: 'C', ts: '1.1', name: 'eyes' });

    expect(res).toEqual({ ts: '9.9' });
    expect(c.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C',
      text: 't',
      unfurl_links: false,
      thread_ts: '1.1',
    });
    expect(c.reactions.add).toHaveBeenCalledWith({ channel: 'C', timestamp: '1.1', name: 'eyes' });
    expect(await port.permalink({ channel: 'C', ts: '1.1' })).toBe('https://x');
  });

  it('fails if Slack does not return a ts', async () => {
    const c = client();
    c.chat.postMessage.mockResolvedValueOnce({ ok: true } as never);

    await expect(webClientPort(c as never).postMessage({ channel: 'C', text: 't' })).rejects.toThrow(/no ts/);
  });
});
