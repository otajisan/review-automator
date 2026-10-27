import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options, Query, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config, PerRepoConfig } from '../config/schema.js';
import { ReviewError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { reviewResultJsonSchema, ReviewResultSchema, type ReviewResult } from './schema.js';
import { toolGuardHook } from './tool-guard.js';
import { ISOLATED_GIT_ENV } from './workspace.js';

export type QueryFn = (params: { prompt: string; options?: Options }) => Query | AsyncIterable<SDKMessage>;

export const PLUGIN_DIR = fileURLToPath(new URL('../../plugin', import.meta.url));

/**
 * Read-only tools the reviewers and the bundled skill rely on. These only spare the session a
 * permission prompt; what may actually run is decided by the PreToolUse guard (tool-guard.ts).
 */
export const BASE_ALLOWED_TOOLS = [
  'Agent',
  'Skill',
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git merge-base *)',
  'Bash(git status *)',
  'Bash(git rev-parse *)',
  'Bash(git blame *)',
  'Bash(git ls-files *)',
  'Bash(git ls-tree *)',
  'Bash(git cat-file *)',
  'Bash(git grep *)',
] as const;

/** Second line of defence behind the guard; also documents intent. Posting is done by the daemon. */
export const DENIED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent(fork)',
  'Bash(gh *)',
  'Bash(git push *)',
  'Bash(git commit *)',
  'Bash(git checkout *)',
  'Bash(git switch *)',
  'Bash(git reset *)',
  'Bash(git branch *)',
  'Bash(git worktree *)',
  'Bash(git config *)',
  'Bash(curl *)',
  'Bash(wget *)',
] as const;

/** Environment passed to the session. Anything else in the daemon's env (tokens, etc.) stays out. */
const ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|TZ|TERM|XDG_[A-Z_]+|ANTHROPIC_[A-Z_]+|CLAUDE_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS)$/;

/** Where user-level skills, agents and plugins live; the session may read their supporting files. */
function claudeHomeRoots(home: string): string[] {
  return ['skills', 'agents', 'plugins'].map((d) => path.join(home, '.claude', d));
}

export interface EngineRun {
  readonly result: ReviewResult;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly permissionDenials: readonly string[];
}

export interface EngineInput {
  readonly cwd: string;
  /** Extra readable directories outside the checkout (base-branch convention files). */
  readonly additionalDirectories?: readonly string[];
  readonly prompt: string;
  readonly systemAppend: string;
  readonly perRepo: PerRepoConfig;
  readonly review: Config['review'];
  /** Called for every tool call the guard denies. */
  readonly onDeny?: (tool: string, reason: string) => void;
  readonly home?: string;
}

export function buildOptions(input: EngineInput, abortController: AbortController): Options {
  const { review } = input;
  const additional = [...(input.additionalDirectories ?? [])];
  const guard = toolGuardHook(
    {
      cwd: input.cwd,
      readableRoots: [input.cwd, ...additional, PLUGIN_DIR, ...claudeHomeRoots(input.home ?? homedir())],
      extraRules: input.perRepo.allowed_tools,
      allowedAgents: [...review.reviewers, review.verifier],
      allowedSkills: [review.skill, ...input.perRepo.extra_skills],
    },
    input.onDeny,
  );
  return {
    cwd: input.cwd,
    additionalDirectories: additional,
    // 'project' is deliberately absent: the cwd is the PR head, and its .claude/ (hooks, skills,
    // settings) and CLAUDE.md are attacker-controlled.
    settingSources: ['user'],
    plugins: [{ type: 'local', path: PLUGIN_DIR }],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
    permissionMode: 'dontAsk',
    allowedTools: [...BASE_ALLOWED_TOOLS, ...input.perRepo.allowed_tools],
    disallowedTools: [...DENIED_TOOLS],
    hooks: { PreToolUse: [guard] },
    outputFormat: { type: 'json_schema', schema: reviewResultJsonSchema() },
    model: review.model,
    maxTurns: review.max_turns,
    maxBudgetUsd: review.max_budget_usd,
    abortController,
    env: {
      ...allowedEnv(process.env),
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      // Subagents default to the background, and the session could return before reviewers report.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      // git in the session must not pick up the user's diff drivers or hooks for untrusted files.
      ...ISOLATED_GIT_ENV,
      ...review.env,
    },
  };
}

export function allowedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && ENV_ALLOWLIST.test(e[0]),
    ),
  );
}

/** Names the session must have loaded; a silent fallback would review with the wrong agents. */
export function missingCapabilities(
  init: { skills?: readonly string[]; agents?: readonly string[] | undefined },
  review: Config['review'],
  perRepo: PerRepoConfig,
): string[] {
  const missing: string[] = [];
  const skills = new Set(init.skills ?? []);
  for (const s of [review.skill, ...perRepo.extra_skills]) if (!skills.has(s)) missing.push(`skill ${s}`);
  if (init.agents) {
    const agents = new Set(init.agents);
    for (const a of [...review.reviewers, review.verifier]) if (!agents.has(a)) missing.push(`agent ${a}`);
  }
  return missing;
}

function resultToRun(msg: SDKResultMessage): EngineRun {
  const denials = msg.permission_denials.map(
    (d) => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 200)}`,
  );
  if (msg.subtype === 'error_max_budget_usd') {
    throw new ReviewError('budget', `review stopped at the budget limit ($${msg.total_cost_usd.toFixed(2)})`);
  }
  if (msg.subtype !== 'success') {
    throw new ReviewError('engine_failed', `review ended with ${msg.subtype} after ${msg.num_turns} turns`);
  }
  const parsed = ReviewResultSchema.safeParse(msg.structured_output);
  if (!parsed.success) {
    throw new ReviewError('engine_failed', 'review finished without a valid structured result');
  }
  // An empty findings list from an unfinished review must never be read as "looks good".
  if (!parsed.data.complete) {
    throw new ReviewError(
      'engine_failed',
      `review did not complete: ${parsed.data.incomplete_reason ?? 'no reason given'}`,
    );
  }
  return {
    result: parsed.data,
    costUsd: msg.total_cost_usd,
    numTurns: msg.num_turns,
    permissionDenials: denials,
  };
}

export async function runEngine(
  deps: { query: QueryFn; logger: Logger },
  input: EngineInput,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<EngineRun> {
  // A signal aborted before we got here (e.g. shutdown during clone) never fires 'abort' again.
  if (opts.signal?.aborted) throw new ReviewError('engine_failed', 'review was cancelled');
  const abort = new AbortController();
  const state: { abortReason: 'timeout' | 'init' | 'external' | null } = { abortReason: null };
  const timer = setTimeout(() => {
    state.abortReason = 'timeout';
    abort.abort();
  }, opts.timeoutMs);
  const onExternalAbort = () => {
    state.abortReason = 'external';
    abort.abort();
  };
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let initError: string[] = [];
  try {
    for await (const msg of deps.query({ prompt: input.prompt, options: buildOptions(input, abort) })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.plugin_errors?.length) {
          deps.logger.warn({ plugin_errors: msg.plugin_errors }, 'plugin load errors');
        }
        initError = missingCapabilities(msg, input.review, input.perRepo);
        if (initError.length > 0) {
          state.abortReason = 'init';
          abort.abort();
          break;
        }
        deps.logger.debug({ model: msg.model, skills: msg.skills.length }, 'review session started');
      }
      if (msg.type === 'result') return resultToRun(msg);
    }
  } catch (err) {
    if (err instanceof ReviewError) throw err;
    if (state.abortReason === null)
      throw new ReviewError('engine_failed', 'review session crashed', { cause: err });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }

  switch (state.abortReason) {
    case 'init':
      throw new ReviewError('engine_init', `review session is missing ${initError.join(', ')}`);
    case 'timeout':
      throw new ReviewError(
        'timeout',
        `review timed out after ${Math.round(opts.timeoutMs / 60_000)} minutes`,
      );
    case 'external':
      throw new ReviewError('engine_failed', 'review was cancelled');
    default:
      throw new ReviewError('engine_failed', 'review session ended without a result');
  }
}
