import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Gh } from '../github/gh.js';
import { fetchPr, prSlug, type PrInfo, type PrRef } from '../github/pr.js';
import { ReviewError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { classify, type Classified } from './decision.js';
import { runEngine, type QueryFn } from './engine.js';
import { buildPrompt, buildSystemAppend, perRepoConfig } from './prompt.js';
import type { ReviewResult } from './schema.js';
import type { WorkspaceManager } from './workspace.js';

export interface ReviewOutcome {
  readonly pr: PrInfo;
  readonly headSha: string;
  readonly baseSha: string;
  readonly result: ReviewResult;
  readonly classified: Classified;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly permissionDenials: readonly string[];
}

export interface ReviewDeps {
  readonly config: Config;
  readonly gh: Gh;
  readonly workspace: WorkspaceManager;
  readonly query: QueryFn;
  readonly logger: Logger;
}

export async function runReview(
  deps: ReviewDeps,
  ref: PrRef,
  reviewId: string,
  opts: { signal?: AbortSignal; pr?: PrInfo } = {},
): Promise<ReviewOutcome> {
  const { config, logger } = deps;
  const pr = opts.pr ?? (await fetchPr(deps.gh, ref));
  if (pr.state !== 'OPEN') throw new ReviewError('pr_not_open', `${prSlug(pr)} is ${pr.state.toLowerCase()}`);

  const ws = await deps.workspace.prepare(pr, reviewId);
  // Preparing a large repository can take minutes; the PR may have been merged meanwhile.
  const latest = await fetchPr(deps.gh, pr).catch(() => pr);
  if (latest.state !== 'OPEN') {
    await deps.workspace.cleanup(ws).catch(() => undefined);
    throw new ReviewError(
      'pr_not_open',
      `${prSlug(pr)} was ${latest.state.toLowerCase()} while preparing the review`,
    );
  }
  const log = logger.child({ reviewId, pr: prSlug(pr), head: ws.headSha.slice(0, 7) });
  let failed = true;
  try {
    const perRepo = perRepoConfig(config, pr);
    const descriptionFile = path.join(ws.conventionsDir, 'PR_DESCRIPTION.md');
    await writeFile(descriptionFile, `# ${pr.title}\n\n${pr.body}\n`, { mode: 0o600 });
    log.info('review started');
    const run = await runEngine(
      { query: deps.query, logger: log },
      {
        cwd: ws.worktree,
        additionalDirectories: [ws.conventionsDir],
        prompt: buildPrompt({ config, pr, ws, perRepo, descriptionFile }),
        systemAppend: buildSystemAppend(perRepo),
        perRepo,
        review: config.review,
        onDeny: (tool, reason) => log.info({ tool, reason }, 'tool call denied by guard'),
      },
      { timeoutMs: config.review.timeout_minutes * 60_000, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (run.permissionDenials.length > 0) {
      log.warn(
        { denials: run.permissionDenials },
        'tools were denied during review; widen per_repo.allowed_tools if needed',
      );
    }
    const classified = classify(run.result.findings);
    log.info(
      {
        cost: run.costUsd,
        turns: run.numTurns,
        postable: classified.postable.length,
        mustFix: classified.hasMustFix,
      },
      'review finished',
    );
    failed = false;
    return {
      pr,
      headSha: ws.headSha,
      baseSha: ws.baseSha,
      result: run.result,
      classified,
      costUsd: run.costUsd,
      numTurns: run.numTurns,
      permissionDenials: run.permissionDenials,
    };
  } finally {
    await deps.workspace
      .cleanup(ws, { keep: failed && config.workspace.keep_worktree_on_failure })
      .catch((err: unknown) => log.warn({ err }, 'workspace cleanup failed'));
  }
}
