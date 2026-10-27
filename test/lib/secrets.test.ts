import { describe, expect, it } from 'vitest';
import { findSecretLike } from '../../src/lib/secrets.js';

describe('findSecretLike', () => {
  it.each([
    ['Slack token', `token: xoxb-${'1'.repeat(12)}-abc`],
    ['GitHub token', `ghp_${'a'.repeat(36)}`],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['AWS access key', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['credentials in URL', 'https://user:hunter2@example.com/x'],
  ])('detects a %s', (kind, text) => {
    expect(findSecretLike(text)).toContain(kind);
  });

  it('passes ordinary review text', () => {
    expect(
      findSecretLike('`token` is read from `process.env.SLACK_BOT_TOKEN`; see https://api.slack.com/'),
    ).toEqual([]);
  });
});
