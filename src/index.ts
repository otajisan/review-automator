#!/usr/bin/env node
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config/load.js';
import { createGh } from './github/gh.js';
import { errorMessage } from './lib/errors.js';
import { exec } from './lib/exec.js';
import { createLogger } from './lib/logger.js';
import { runReview } from './review/run-review.js';
import { createWorkspaceManager } from './review/workspace.js';
import { createService, type Service } from './service.js';
import { createSlackApp } from './slack/app.js';
import { createFileReviewStore } from './store/reviews.js';

async function main(): Promise<void> {
  const { config, secrets, configPath, warnings } = await loadConfig();
  const logger = createLogger(process.env['LOG_LEVEL'] ?? config.log_level);
  for (const w of warnings) logger.warn(w);
  logger.info(
    { configPath, watch: config.slack.watch_channels, repos: config.github.allowed_repos },
    'starting',
  );

  // Posting must always happen as the configured owner, whatever `gh auth switch` did since.
  const gh = createGh(undefined, 'gh', { login: config.owner.github_login });
  const store = await createFileReviewStore(config.state_dir);
  const workspace = createWorkspaceManager({ exec, rootDir: config.workspace.dir });

  // The Slack app needs the service for its handlers and the service needs the app's client.
  const holder: { service?: Service } = {};
  const slackApp = createSlackApp({
    botToken: secrets.SLACK_BOT_TOKEN,
    appToken: secrets.SLACK_APP_TOKEN,
    logger,
    service: () => {
      if (!holder.service) throw new Error('service not initialised');
      return holder.service;
    },
  });
  const service = createService({
    config,
    slack: slackApp.port,
    gh,
    store,
    logger,
    review: (ref, reviewId, opts) => runReview({ config, gh, workspace, query, logger }, ref, reviewId, opts),
  });
  holder.service = service;

  await slackApp.start();
  logger.info('connected to Slack (Socket Mode)');
  await service.resumeInterrupted();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    await slackApp.stop().catch(() => undefined);
    await service.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err: unknown) => {
  // launchd captures stderr into the log file configured in the plist.
  process.stderr.write(`review-automator failed to start: ${errorMessage(err)}\n`);
  process.exit(1);
});
