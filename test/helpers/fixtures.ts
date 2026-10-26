import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import type { PrInfo } from '../../src/github/pr.js';
import type { Finding } from '../../src/review/schema.js';
import pino from 'pino';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const HEAD_SHA = '1'.repeat(40);
export const BASE_SHA = '2'.repeat(40);

const BASE_CONFIG = {
  owner: { slack_user_id: 'U0OWNER01', github_login: 'me' },
  slack: { watch_channels: ['C0WATCH01'], notify_channel: 'C0NOTIFY1' },
  github: { allowed_repos: ['acme/*'] },
};

function deepMerge(base: unknown, extra: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return extra ?? base;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return extra ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(out[k], v);
  return out;
}

/** A valid config; `extraYaml` is merged on top so tests can override single keys. */
export function testConfig(extraYaml = ''): Config {
  const merged = deepMerge(BASE_CONFIG, parseYaml(extraYaml) ?? {});
  return parseConfig(stringifyYaml(merged), '/home/test');
}

export function testPr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    owner: 'acme',
    repo: 'api',
    number: 7,
    url: 'https://github.com/acme/api/pull/7',
    title: 'Add feature',
    state: 'OPEN',
    isDraft: false,
    author: 'alice',
    headSha: HEAD_SHA,
    baseRef: 'main',
    body: 'Adds the feature.',
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'C1',
    file: 'src/a.ts',
    line: 3,
    severity: 'should_fix',
    confidence: 'high',
    verification: 'not_verified',
    title: 'Something',
    body: 'Details',
    ...overrides,
  };
}

export const silentLogger = pino({ level: 'silent' });
