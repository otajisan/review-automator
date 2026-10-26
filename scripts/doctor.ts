/**
 * Checks that everything review-automator needs is in place, without calling the model.
 *
 *   pnpm check-setup
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import bolt from '@slack/bolt';
import { loadConfig, type LoadedConfig } from '../src/config/load.js';
import { errorMessage } from '../src/lib/errors.js';
import { exec } from '../src/lib/exec.js';
import { buildOptions, missingCapabilities } from '../src/review/engine.js';

let failures = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    process.stdout.write(`✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`✗ ${name} — ${errorMessage(err)}\n`);
  }
}

const MIN_NODE_MAJOR = 22;

async function ghLogin(): Promise<string> {
  return (await exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
}

async function main(): Promise<void> {
  await check('node', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) throw new Error(`node ${process.versions.node}; need >= ${MIN_NODE_MAJOR}`);
    return Promise.resolve(process.versions.node);
  });
  await check('git', async () => (await exec('git', ['--version'])).stdout.trim());
  await check('gh auth', async () => `logged in as ${await ghLogin()}`);

  let loaded: LoadedConfig | undefined;
  await check('config', async () => {
    loaded = await loadConfig();
    for (const w of loaded.warnings) process.stdout.write(`  ! ${w}\n`);
    return loaded.configPath;
  });
  if (!loaded) return;
  const { config, secrets } = loaded;

  await check('github login matches config', async () => {
    const login = await ghLogin();
    if (login.toLowerCase() !== config.owner.github_login.toLowerCase()) {
      throw new Error(`gh is logged in as ${login} but owner.github_login is ${config.owner.github_login}`);
    }
    return login;
  });

  const slack = new bolt.webApi.WebClient(secrets.SLACK_BOT_TOKEN);
  await check('slack bot token', async () => {
    const auth = await slack.auth.test();
    return `${auth.team ?? '?'} as ${auth.user ?? '?'}`;
  });
  await check('bot is in the configured channels', async () => {
    const ids = [...config.slack.watch_channels, config.slack.notify_channel];
    const missing: string[] = [];
    for (const id of ids) {
      const info = await slack.conversations.info({ channel: id }).catch(() => undefined);
      if (!info?.channel?.is_member) missing.push(id);
    }
    if (missing.length > 0) throw new Error(`invite the bot to: ${missing.join(', ')}`);
    return `${ids.length} channel(s)`;
  });

  await check('review session loads the configured skills and agents', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ra-doctor-'));
    const abort = new AbortController();
    // Check the union of every repository's extra skills and tool rules in one session.
    const perRepo = {
      extra_skills: [...new Set(Object.values(config.review.per_repo).flatMap((r) => r.extra_skills))],
      allowed_tools: [...new Set(Object.values(config.review.per_repo).flatMap((r) => r.allowed_tools))],
      extra_instructions: '',
    };
    const options = buildOptions(
      { cwd, prompt: '', systemAppend: '', perRepo, review: config.review },
      abort,
    );
    // The init message arrives before any model request, so aborting right after it costs nothing.
    try {
      for await (const msg of query({ prompt: 'ping', options })) {
        if (msg.type !== 'system' || msg.subtype !== 'init') continue;
        if (msg.plugin_errors?.length) throw new Error(`plugin errors: ${JSON.stringify(msg.plugin_errors)}`);
        const missing = missingCapabilities(msg, config.review, perRepo);
        if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`);
        return `${msg.model}, ${msg.skills.length} skills, ${msg.agents?.length ?? '?'} agents`;
      }
    } finally {
      abort.abort();
    }
    throw new Error('session ended before init');
  });
}

main()
  .catch((err: unknown) => {
    failures += 1;
    process.stdout.write(`✗ doctor crashed — ${errorMessage(err)}\n`);
  })
  .finally(() => {
    process.stdout.write(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
