import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Gh } from '../../src/github/gh.js';
import type { QueryFn } from '../../src/review/engine.js';
import { runReview } from '../../src/review/run-review.js';
import type { WorkspaceManager } from '../../src/review/workspace.js';
import { BASE_SHA, finding, HEAD_SHA, silentLogger, testConfig, testPr } from '../helpers/fixtures.js';

const ws = {
  worktree: '/w',
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  conventionFiles: [],
  conventionsDir: mkdtempSync(path.join(tmpdir(), 'ra-conv-')),
  repoDir: '/r',
  refs: [],
};

function deps(query: QueryFn) {
  const workspace: WorkspaceManager = {
    prepare: vi.fn(() => Promise.resolve(ws)),
    cleanup: vi.fn(() => Promise.resolve()),
  };
  const gh = {} as Gh;
  return { config: testConfig(), gh, workspace, query, logger: silentLogger };
}

const init = {
  type: 'system',
  subtype: 'init',
  skills: ['review-automator:pr-review'],
  plugins: [],
  model: 'm',
};

function queryReturning(structured: unknown): QueryFn {
  return () =>
    (async function* () {
      yield init as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        total_cost_usd: 0.1,
        permission_denials: [],
        structured_output: structured,
      } as unknown as SDKMessage;
    })();
}

describe('runReview', () => {
  it('reviews an open PR, classifies findings and cleans up', async () => {
    const d = deps(
      queryReturning({
        complete: true,
        summary: 's',
        findings: [finding({ severity: 'must_fix', verification: 'confirmed' })],
      }),
    );

    const outcome = await runReview(d, testPr(), 'r1', { pr: testPr() });

    expect(outcome.headSha).toBe(HEAD_SHA);
    expect(outcome.classified.hasMustFix).toBe(true);
    expect(d.workspace.cleanup).toHaveBeenCalledWith(ws, { keep: false });
    expect(readFileSync(path.join(ws.conventionsDir, 'PR_DESCRIPTION.md'), 'utf8')).toBe(
      '# Add feature\n\nAdds the feature.\n',
    );
  });

  it('keeps the worktree when the review fails and the config says so', async () => {
    const d = deps(() =>
      (async function* () {
        yield init as unknown as SDKMessage;
      })(),
    );

    await expect(runReview(d, testPr(), 'r1', { pr: testPr() })).rejects.toMatchObject({
      kind: 'engine_failed',
    });
    expect(d.workspace.cleanup).toHaveBeenCalledWith(ws, { keep: true });
  });

  it('refuses closed PRs before touching the workspace', async () => {
    const d = deps(queryReturning({ complete: true, summary: '', findings: [] }));

    await expect(runReview(d, testPr(), 'r1', { pr: testPr({ state: 'MERGED' }) })).rejects.toMatchObject({
      kind: 'pr_not_open',
    });
    expect(d.workspace.prepare).not.toHaveBeenCalled();
  });
});
