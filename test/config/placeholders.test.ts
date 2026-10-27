import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { leftoverPlaceholders } from '../../src/config/placeholders.js';

// The real example file, so this test breaks if it stops parsing or drops a guarded key.
const example = parseConfig(await readFile(new URL('../../config.example.yaml', import.meta.url), 'utf8'));

describe('leftoverPlaceholders', () => {
  it('flags every guarded key when the example is copied unchanged', () => {
    expect(leftoverPlaceholders(example, example)).toEqual([
      'owner.slack_user_id',
      'owner.github_login',
      'slack.watch_channels',
      'slack.notify_channel',
      'github.allowed_repos',
    ]);
  });

  it('passes a fully edited config', () => {
    const edited = {
      ...example,
      owner: { slack_user_id: 'U0REAL0001', github_login: 'someone' },
      slack: { ...example.slack, watch_channels: ['C0REAL0001'], notify_channel: 'C0REAL0002' },
      github: { allowed_repos: ['acme/*'] },
    };

    expect(leftoverPlaceholders(edited, example)).toEqual([]);
  });

  it('flags a single forgotten key, including one example channel among real ones', () => {
    const partly = {
      ...example,
      owner: { ...example.owner, github_login: 'someone' },
      slack: {
        ...example.slack,
        watch_channels: ['C0REAL0001', ...example.slack.watch_channels],
        notify_channel: 'C0REAL0002',
      },
      github: { allowed_repos: ['acme/*'] },
    };

    expect(leftoverPlaceholders(partly, example)).toEqual(['owner.slack_user_id', 'slack.watch_channels']);
  });
});
