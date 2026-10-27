/**
 * Runs one review without Slack and prints the result. Nothing is posted to GitHub.
 *
 *   pnpm review-once https://github.com/<owner>/<repo>/pull/<n> [--config path]
 *
 * Without a config file, defaults are used and any repository is allowed.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { defaultConfigDir, parseConfig } from '../src/config/load.js';
import { parseCommentableLines } from '../src/github/diff.js';
import { createGh } from '../src/github/gh.js';
import { extractPrRefs, fetchPr, fetchPrDiff } from '../src/github/pr.js';
import { errorMessage } from '../src/lib/errors.js';
import { exec } from '../src/lib/exec.js';
import { createLogger } from '../src/lib/logger.js';
import { planReview } from '../src/review/decision.js';
import { runReview } from '../src/review/run-review.js';
import { createWorkspaceManager } from '../src/review/workspace.js';

const FALLBACK_CONFIG = `
owner: { slack_user_id: U0000000, github_login: "-" }
slack: { watch_channels: [C0000000], notify_channel: C0000000 }
github: { allowed_repos: ["*/*"] }
`;

async function loadConfigText(argv: string[]): Promise<string> {
  const i = argv.indexOf('--config');
  const file =
    i >= 0
      ? argv[i + 1]
      : (process.env['REVIEW_AUTOMATOR_CONFIG'] ?? path.join(defaultConfigDir(), 'config.yaml'));
  try {
    return await readFile(file!, 'utf8');
  } catch {
    process.stderr.write(`(no config at ${file}; using defaults)\n`);
    return FALLBACK_CONFIG;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ref = extractPrRefs(argv.join(' '))[0];
  if (!ref) {
    process.stderr.write('usage: pnpm review-once <PR URL> [--config path]\n');
    process.exit(2);
  }
  const config = parseConfig(await loadConfigText(argv));
  const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info', 2);
  const gh = createGh();
  const workspace = createWorkspaceManager({ exec, rootDir: config.workspace.dir });

  const pr = await fetchPr(gh, ref);
  const reviewId = `once-${Date.now().toString(36)}`;
  const outcome = await runReview({ config, gh, workspace, query, logger }, ref, reviewId, { pr });
  const commentable = parseCommentableLines(await fetchPrDiff(gh, ref));
  const plan = planReview({
    classified: outcome.classified,
    commentable,
    isOwnPr: pr.author.toLowerCase() === config.owner.github_login.toLowerCase(),
    mode: 'review',
    post: config.post,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        pr: pr.url,
        head: outcome.headSha,
        cost_usd: outcome.costUsd,
        turns: outcome.numTurns,
        permission_denials: outcome.permissionDenials,
        summary: outcome.result.summary,
        findings: outcome.result.findings,
        would_post: plan,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`review failed: ${errorMessage(err)}\n`);
  if (err instanceof Error && err.cause) process.stderr.write(`  cause: ${errorMessage(err.cause)}\n`);
  process.exit(1);
});
