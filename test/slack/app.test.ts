import { describe, expect, it, vi } from 'vitest';
import { picksFromState, toIncomingMessage, webClientPort } from '../../src/slack/app.js';

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

describe('picksFromState', () => {
  const checked = (...values: string[]) => ({
    type: 'checkboxes',
    selected_options: values.map((value) => ({ value, text: { type: 'plain_text', text: value } })),
  });

  it('collects the checked finding indices per checkbox group', () => {
    const state = {
      values: {
        b0: { ra_pick_0: checked('0', '3') },
        b1: { ra_pick_1: checked() },
      },
    };

    expect(picksFromState(state)).toEqual(
      new Map([
        [0, [0, 3]],
        [1, []],
      ]),
    );
  });

  it('is undefined for a message without checkboxes (older notifications)', () => {
    expect(picksFromState(undefined)).toBeUndefined();
    expect(picksFromState({ values: {} })).toBeUndefined();
  });

  it('ignores anything that is not a well-formed finding index', () => {
    const state = {
      values: {
        b0: { ra_pick_0: checked('1', 'x', '-2', '1e3') },
        other: { something_else: checked('5') },
        bad: { ra_pick_x: checked('7') },
      },
    };

    expect(picksFromState(state)).toEqual(new Map([[0, [1]]]));
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
