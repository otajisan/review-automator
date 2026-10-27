import type { Config } from './schema.js';

/**
 * Keys of `config` that still hold a value from `example` (config.example.yaml). The example is
 * read at runtime rather than copied here, so editing its sample values can never make this check
 * silently pass. A placeholder owner ID matters most: every button press then looks like a
 * stranger's and is refused.
 */
export function leftoverPlaceholders(config: Config, example: Config): string[] {
  const overlaps = (a: readonly string[], b: readonly string[]) => a.some((v) => b.includes(v));
  const checks: [string, boolean][] = [
    ['owner.slack_user_id', config.owner.slack_user_id === example.owner.slack_user_id],
    ['owner.github_login', config.owner.github_login === example.owner.github_login],
    ['slack.watch_channels', overlaps(config.slack.watch_channels, example.slack.watch_channels)],
    ['slack.notify_channel', config.slack.notify_channel === example.slack.notify_channel],
    ['github.allowed_repos', overlaps(config.github.allowed_repos, example.github.allowed_repos)],
  ];
  return checks.filter(([, left]) => left).map(([key]) => key);
}
