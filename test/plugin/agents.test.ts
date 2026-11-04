import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfig } from '../../src/config/load.js';
import { PLUGIN_DIR } from '../../src/review/engine.js';

const PLUGIN_PREFIX = 'review-automator:';

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

interface AgentFrontmatter {
  readonly name: string;
  readonly model: string;
}

async function readAgent(name: string): Promise<AgentFrontmatter> {
  const text = await readFile(path.join(PLUGIN_DIR, 'agents', `${name}.md`), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match?.[1]) throw new Error(`agent ${name} has no frontmatter`);
  return parse(match[1]) as AgentFrontmatter;
}

function bundledName(qualified: string): string {
  expect(qualified.startsWith(PLUGIN_PREFIX)).toBe(true);
  return qualified.slice(PLUGIN_PREFIX.length);
}

describe('bundled review agents', () => {
  const review = parseConfig(MINIMAL_YAML, '/home/me').review;

  it.each(review.reviewers.map(bundledName))('reviewer %s finds issues with Opus', async (name) => {
    const agent = await readAgent(name);

    expect(agent.name).toBe(name);
    expect(agent.model).toBe('opus');
  });

  it('the verifier checks findings with Opus', async () => {
    const name = bundledName(review.verifier);
    const agent = await readAgent(name);

    expect(agent.name).toBe(name);
    expect(agent.model).toBe('opus');
  });
});
