import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultConfigDir,
  expandHome,
  loadConfig,
  parseConfig,
  parseSecrets,
} from '../../src/config/load.js';
import { ConfigError } from '../../src/lib/errors.js';

const MINIMAL_YAML = `
owner:
  slack_user_id: U0123ABCD
  github_login: octocat
slack:
  watch_channels: [C0123ABCD]
  notify_channel: C0456EFGH
github:
  allowed_repos: ["acme/*"]
`;

const VALID_ENV = 'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n';

describe('parseConfig', () => {
  it('fills every optional section with defaults', () => {
    const config = parseConfig(MINIMAL_YAML, '/home/me');

    expect(config.review.reviewers).toEqual([
      'review-automator:correctness-reviewer',
      'review-automator:security-reviewer',
    ]);
    expect(config.review.concurrency).toBe(1);
    expect(config.post.severity_on_findings).toBe('COMMENT');
    expect(config.post.approve_body_no_findings).toBe('LGTM!! :+1:');
  });

  it('expands ~ in path fields', () => {
    const config = parseConfig(MINIMAL_YAML, '/home/me');

    expect(config.workspace.dir).toBe('/home/me/Library/Application Support/review-automator/workspace');
    expect(config.state_dir).toBe('/home/me/Library/Application Support/review-automator');
  });

  it('reports the path of each missing required field', () => {
    expect(() => parseConfig('owner: {}\n')).toThrow(/owner\.slack_user_id/);
  });

  it('rejects a Slack channel name where an ID is required', () => {
    const yaml = MINIMAL_YAML.replace('[C0123ABCD]', '["#reviews"]');

    expect(() => parseConfig(yaml)).toThrow(ConfigError);
  });

  it('rejects malformed YAML with a ConfigError', () => {
    expect(() => parseConfig('owner: [unclosed')).toThrow(/not valid YAML/);
  });

  it('rejects an ignore_message_patterns entry that is not a valid regular expression', () => {
    const yaml = MINIMAL_YAML.replace(
      '  notify_channel: C0456EFGH',
      "  notify_channel: C0456EFGH\n  ignore_message_patterns: ['(unclosed']",
    );

    expect(() => parseConfig(yaml)).toThrow(/ignore_message_patterns.*not a valid regular expression/s);
  });

  it('rejects ignore_message_patterns with nested quantifiers that could hang the daemon', () => {
    for (const pattern of ['^(a+)+$', '(\\w*)*', '(x+){2,}']) {
      const yaml = MINIMAL_YAML.replace(
        '  notify_channel: C0456EFGH',
        // A function replacement, so the `$'` in a pattern is not read as a replacement token.
        () => `  notify_channel: C0456EFGH\n  ignore_message_patterns: ['${pattern}']`,
      );

      expect(() => parseConfig(yaml)).toThrow(/nested quantifiers/);
    }
  });

  it('accepts ordinary ignore_message_patterns', () => {
    const yaml = MINIMAL_YAML.replace(
      '  notify_channel: C0456EFGH',
      "  notify_channel: C0456EFGH\n  ignore_message_patterns: ['マージします', '\\bmerg(e|ing)\\b', '(foo)+']",
    );

    expect(parseConfig(yaml).slack.ignore_message_patterns).toHaveLength(3);
  });

  it('accepts per-repo extra skills and tool rules', () => {
    const yaml = `${MINIMAL_YAML}
review:
  per_repo:
    "acme/api":
      extra_skills: [api-kb]
      allowed_tools: ["Bash(python3 /x/match.py *)"]
`;
    const config = parseConfig(yaml);

    expect(config.review.per_repo['acme/api']).toEqual({
      extra_skills: ['api-kb'],
      allowed_tools: ['Bash(python3 /x/match.py *)'],
      extra_instructions: '',
    });
  });
});

describe('parseSecrets', () => {
  it('reads tokens from dotenv text', () => {
    expect(parseSecrets(VALID_ENV)).toEqual({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' });
  });

  it('lets process env override the file', () => {
    const secrets = parseSecrets(VALID_ENV, { SLACK_BOT_TOKEN: 'xoxb-from-env' });

    expect(secrets.SLACK_BOT_TOKEN).toBe('xoxb-from-env');
  });

  it('rejects a user token in place of a bot token', () => {
    expect(() => parseSecrets('SLACK_BOT_TOKEN=xoxp-1\nSLACK_APP_TOKEN=xapp-1')).toThrow(/xoxb-/);
  });
});

describe('expandHome / defaultConfigDir', () => {
  it('only expands a leading ~', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/a', '/h')).toBe('/h/a');
    expect(expandHome('/a/~/b', '/h')).toBe('/a/~/b');
  });

  it('honours XDG_CONFIG_HOME', () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/h')).toBe('/xdg/review-automator');
    expect(defaultConfigDir({}, '/h')).toBe('/h/.config/review-automator');
  });
});

describe('loadConfig', () => {
  async function fixture(envMode: number) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ra-config-'));
    const configPath = path.join(dir, 'config.yaml');
    const envPath = path.join(dir, '.env');
    await writeFile(configPath, MINIMAL_YAML);
    await writeFile(envPath, VALID_ENV);
    await chmod(envPath, envMode);
    return { configPath, envPath };
  }

  it('loads config and secrets without warnings when .env is 0600', async () => {
    const paths = await fixture(0o600);

    const loaded = await loadConfig({ ...paths, env: {} });

    expect(loaded.config.owner.github_login).toBe('octocat');
    expect(loaded.secrets.SLACK_APP_TOKEN).toBe('xapp-test');
    expect(loaded.warnings).toEqual([]);
  });

  it('warns when .env is readable by others', async () => {
    const paths = await fixture(0o644);

    const loaded = await loadConfig({ ...paths, env: {} });

    expect(loaded.warnings[0]).toMatch(/chmod 600/);
  });

  it('explains how to fix a missing config file', async () => {
    await expect(loadConfig({ configPath: '/nonexistent/config.yaml', env: {} })).rejects.toThrow(
      /copy config\.example\.yaml/,
    );
  });
});
