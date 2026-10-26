import { access, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, ReviewError } from '../lib/errors.js';
import { createKeyedLock } from '../lib/keyed-lock.js';
import { ExecError, type Exec } from '../lib/exec.js';
import type { PrInfo } from '../github/pr.js';

export interface Workspace {
  /** Checked-out PR head. The review session's cwd. */
  readonly worktree: string;
  /** The exact commit reviewed. Used as `commit_id` when posting. */
  readonly headSha: string;
  readonly baseSha: string;
  /** Convention files taken from the base branch, never from the PR head. */
  readonly conventionFiles: readonly string[];
  readonly conventionsDir: string;
  /** The shared clone and the refs fetched for this review, removed again on cleanup. */
  readonly repoDir: string;
  readonly refs: readonly string[];
}

export interface WorkspaceManager {
  prepare(pr: PrInfo, reviewId: string): Promise<Workspace>;
  cleanup(ws: Workspace, opts?: { keep?: boolean }): Promise<void>;
}

const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** Environment for git on untrusted checkouts: no global/system config, no LFS, no prompts. */
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/**
 * Base branches are fetched into a per-PR ref rather than refs/remotes/origin/<branch>: a stale
 * `origin/release` left by an earlier fetch would otherwise block fetching `release/1.0` forever.
 */
function baseRefFor(pr: PrInfo): string {
  return `refs/ra/base/${pr.number}`;
}
const GIT_TIMEOUT_MS = 10 * 60_000;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function createWorkspaceManager(deps: {
  exec: Exec;
  rootDir: string;
  gitBin?: string;
  ghBin?: string;
  /** Base URL of the Git host. Tests point this at a local directory. */
  remoteBase?: string;
}): WorkspaceManager {
  const git = deps.gitBin ?? 'git';
  const gh = deps.ghBin ?? 'gh';
  // Serialises git operations per repository so concurrent reviews never race on one clone.
  const withRepoLock = createKeyedLock();
  // The PR is untrusted and checking it out must not run anything. The user's global/system git
  // config may define hooks (a relative core.hooksPath would pick up hooks committed in the PR) or
  // filter drivers the PR can select via .gitattributes, so neither is read here.
  const env = { ...process.env, ...ISOLATED_GIT_ENV };
  const run = (cmd: string, args: string[], cwd?: string) =>
    deps.exec(cmd, args, { timeoutMs: GIT_TIMEOUT_MS, env, ...(cwd ? { cwd } : {}) });

  const repoDir = (pr: PrInfo) => path.join(deps.rootDir, 'repos', pr.owner, pr.repo);
  // Keyed by clone path so prepare() and cleanup() share one lock per repository.
  const repoKey = (pr: PrInfo) => repoDir(pr);

  /** Best effort, step by step: one failing removal must not leave the others undone. */
  async function removePartial(created: { worktree?: string; conventionsDir?: string; dir?: string }) {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    if (created.conventionsDir) await quietly(rm(created.conventionsDir, { recursive: true, force: true }));
    if (created.worktree) await quietly(rm(created.worktree, { recursive: true, force: true }));
    if (created.dir) await quietly(run(git, ['-C', created.dir, 'worktree', 'prune']));
  }
  const remoteUrl = (pr: PrInfo) => `${deps.remoteBase ?? 'https://github.com'}/${pr.owner}/${pr.repo}.git`;
  // HTTPS with gh as the credential helper works under launchd regardless of the user's git
  // protocol setting or whether an SSH key is loaded in the agent.
  const auth = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=!${gh} auth git-credential`,
  ];

  async function ensureClone(pr: PrInfo): Promise<string> {
    const dir = repoDir(pr);
    if (await exists(path.join(dir, '.git'))) {
      await run(git, ['-C', dir, 'remote', 'set-url', 'origin', remoteUrl(pr)]);
      return dir;
    }
    await mkdir(path.dirname(dir), { recursive: true });
    // --no-checkout: the main clone is only an object store; reviews use worktrees.
    await run(git, [...auth, 'clone', '--quiet', '--no-checkout', remoteUrl(pr), dir]);
    return dir;
  }

  async function exportConventions(dir: string, pr: PrInfo, outDir: string): Promise<string[]> {
    await mkdir(outDir, { recursive: true });
    const written: string[] = [];
    for (const name of CONVENTION_FILES) {
      try {
        const { stdout } = await run(git, ['-C', dir, 'show', `${baseRefFor(pr)}:${name}`]);
        const file = path.join(outDir, name);
        await writeFile(file, stdout);
        written.push(file);
      } catch (err) {
        if (!(err instanceof ExecError)) throw err; // missing file on base branch is normal
      }
    }
    return written;
  }

  return {
    async prepare(pr, reviewId) {
      // Everything created so far, so a failure half-way leaves nothing behind.
      const created: { worktree?: string; conventionsDir?: string; dir?: string } = {};
      try {
        return await withRepoLock(repoKey(pr), async () => {
          const dir = await ensureClone(pr);
          created.dir = dir;
          await run(git, [
            ...auth,
            '-C',
            dir,
            'fetch',
            '--force',
            '--no-tags',
            // Explicit refspecs only: an opportunistic update of refs/remotes/origin/* would trip
            // over stale branches left by the initial clone (`release` vs `release/1.0`).
            '--refmap=',
            'origin',
            `+refs/heads/${pr.baseRef}:${baseRefFor(pr)}`,
            `+refs/pull/${pr.number}/head:refs/pr/${pr.number}`,
          ]);
          const headSha = (
            await run(git, ['-C', dir, 'rev-parse', `refs/pr/${pr.number}^{commit}`])
          ).stdout.trim();
          const baseSha = (await run(git, ['-C', dir, 'merge-base', baseRefFor(pr), headSha])).stdout.trim();

          // realpath: on macOS /tmp is a symlink, and the session's cwd check compares resolved paths.
          await mkdir(deps.rootDir, { recursive: true });
          const root = await realpath(deps.rootDir);
          const worktree = path.join(root, 'worktrees', reviewId);
          created.worktree = worktree;
          await rm(worktree, { recursive: true, force: true });
          await run(git, ['-C', dir, 'worktree', 'prune']);
          await run(git, [
            '-c',
            'core.hooksPath=/dev/null',
            '-C',
            dir,
            'worktree',
            'add',
            '--detach',
            worktree,
            headSha,
          ]);

          const conventionsDir = path.join(root, 'conventions', reviewId);
          created.conventionsDir = conventionsDir;
          const conventionFiles = await exportConventions(dir, pr, conventionsDir);
          const refs = [`refs/pr/${pr.number}`, baseRefFor(pr)];
          return { worktree, headSha, baseSha, conventionFiles, conventionsDir, repoDir: dir, refs };
        });
      } catch (err) {
        await removePartial(created).catch(() => undefined);
        throw new ReviewError(
          'workspace',
          `could not prepare a checkout of ${pr.owner}/${pr.repo}#${pr.number}`,
          {
            cause: err,
          },
        );
      }
    },

    async cleanup(ws, opts = {}) {
      if (opts.keep) return;
      const failures: unknown[] = [];
      const step = (p: Promise<unknown>) => p.catch((err: unknown) => failures.push(err));
      await step(rm(ws.conventionsDir, { recursive: true, force: true }));
      await step(rm(ws.worktree, { recursive: true, force: true }));
      // Drop the refs too: otherwise every PR ever reviewed keeps its objects alive in the clone
      // and it grows without bound. The next review of the same PR simply fetches them again.
      await withRepoLock(ws.repoDir, async () => {
        await run(git, ['-C', ws.repoDir, 'worktree', 'prune']).catch(() => undefined);
        for (const ref of ws.refs) {
          await run(git, ['-C', ws.repoDir, 'update-ref', '-d', ref]).catch(() => undefined);
        }
      });
      if (failures.length > 0) throw new Error(`cleanup incomplete: ${errorMessage(failures[0])}`);
    },
  };
}
