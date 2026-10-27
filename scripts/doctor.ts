/**
 * Checks that everything review-automator needs is in place, without calling the model.
 *
 *   pnpm check-setup
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import bolt from '@slack/bolt';
import { loadConfig, parseConfig, type LoadedConfig } from '../src/config/load.js';
import { leftoverPlaceholders } from '../src/config/placeholders.js';
import { errorMessage } from '../src/lib/errors.js';
import { exec } from '../src/lib/exec.js';
import { buildOptions, missingCapabilities } from '../src/review/engine.js';
import { classifyChannels, type ChannelProbe } from '../src/slack/channel-check.js';

let failures = 0;

/** Something that could not be verified, but is not known to be broken. Does not fail the run. */
class Unverified extends Error {}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    process.stdout.write(`✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    if (err instanceof Unverified) {
      process.stdout.write(`! ${name} — ${err.message}\n`);
      return;
    }
    failures += 1;
    process.stdout.write(`✗ ${name} — ${errorMessage(err)}\n`);
  }
}

/** Slack Web API errors carry the API error code (e.g. `missing_scope`) in `data.error`. */
function slackErrorCode(err: unknown): string {
  const data = (err as { data?: { error?: unknown } }).data;
  return typeof data?.error === 'string' ? data.error : errorMessage(err);
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

  await check('config has no example placeholders left', async () => {
    const exampleText = await readFile(new URL('../config.example.yaml', import.meta.url), 'utf8');
    const left = leftoverPlaceholders(config, parseConfig(exampleText));
    if (left.length > 0) throw new Error(`still the value from config.example.yaml: ${left.join(', ')}`);
    return '';
  });

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
    const ids = [...new Set([...config.slack.watch_channels, config.slack.notify_channel])];
    const probes: ChannelProbe[] = [];
    for (const id of ids) {
      try {
        const info = await slack.conversations.info({ channel: id });
        probes.push({ id, isMember: info.channel?.is_member });
      } catch (err) {
        probes.push({ id, error: slackErrorCode(err) });
      }
    }
    const { problems, unverified } = classifyChannels(probes);
    // The app itself does not need channels:read / groups:read, so the manifest leaves them out.
    const unverifiedNote =
      unverified.length > 0
        ? `could not check ${unverified.join(', ')}; add channels:read (and groups:read for private channels) to the app to enable this check, or confirm the invite in Slack`
        : '';
    if (problems.length > 0) {
      throw new Error([problems.join('; '), unverifiedNote].filter(Boolean).join('. Also: '));
    }
    if (unverifiedNote) throw new Unverified(unverifiedNote);
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
