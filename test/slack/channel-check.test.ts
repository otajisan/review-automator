import { describe, expect, it } from 'vitest';
import { classifyChannels } from '../../src/slack/channel-check.js';

describe('classifyChannels', () => {
  it('passes channels the bot is a member of', () => {
    expect(classifyChannels([{ id: 'C1', isMember: true }])).toEqual({ problems: [], unverified: [] });
  });

  it('fails a channel the bot is not in', () => {
    expect(classifyChannels([{ id: 'C1', isMember: false }]).problems).toEqual([
      'C1: bot is not a member; invite it',
    ]);
  });

  it('only warns when the token lacks the scope to check', () => {
    expect(classifyChannels([{ id: 'C1', error: 'missing_scope' }])).toEqual({
      problems: [],
      unverified: ['C1 (missing_scope)'],
    });
  });

  it('fails channel_not_found, which also hides private channels the bot is not in', () => {
    expect(classifyChannels([{ id: 'C1', error: 'channel_not_found' }]).problems[0]).toMatch(
      /not found; check the ID, or invite the bot/,
    );
  });

  it('fails other API errors with their code', () => {
    expect(classifyChannels([{ id: 'C1', error: 'ratelimited' }]).problems).toEqual(['C1: ratelimited']);
  });

  it('treats a missing is_member as unverified, not as "not a member"', () => {
    expect(classifyChannels([{ id: 'C1', isMember: undefined }])).toEqual({
      problems: [],
      unverified: ['C1 (membership not reported)'],
    });
  });

  it('reports problems and unverified channels together', () => {
    const result = classifyChannels([
      { id: 'C1', isMember: false },
      { id: 'C2', error: 'missing_scope' },
    ]);

    expect(result.problems).toHaveLength(1);
    expect(result.unverified).toEqual(['C2 (missing_scope)']);
  });
});
