import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ReviewError } from '../../src/lib/errors.js';
import {
  allowedEnv,
  buildOptions,
  DENIED_TOOLS,
  missingCapabilities,
  runEngine,
  sessionDataDir,
  type QueryFn,
} from '../../src/review/engine.js';
import { finding, silentLogger, testConfig } from '../helpers/fixtures.js';

const review = testConfig().review;
const perRepo = { extra_skills: [], allowed_tools: [], extra_instructions: '' };
const input = { cwd: '/w', prompt: '/p', systemAppend: 's', perRepo, review };

const INIT = {
  type: 'system',
  subtype: 'init',
  skills: ['review-automator:pr-review'],
  agents: [
    'review-automator:correctness-reviewer',
    'review-automator:security-reviewer',
    'review-automator:finding-verifier',
  ],
  plugins: [],
  model: 'sonnet',
} as unknown as SDKMessage;

function success(structured: unknown): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    num_turns: 4,
    total_cost_usd: 0.42,
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'npm test' } }],
    structured_output: structured,
  } as unknown as SDKMessage;
}

function fakeQuery(messages: SDKMessage[], seen: { options?: Options } = {}): QueryFn {
  return ({ options }) => {
    if (options) seen.options = options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

describe('buildOptions', () => {
  it('never loads project settings from the PR checkout', () => {
    expect(buildOptions(input, new AbortController()).settingSources).toEqual(['user']);
  });

  it('denies gh api and file edits, and runs without prompting', () => {
    const opts = buildOptions(input, new AbortController());

    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Bash(gh *)', 'Edit', 'Write', 'WebFetch']));
    expect(opts.allowedTools?.some((t) => t.startsWith('Bash(gh'))).toBe(false);
  });

  it('adds per-repo tool rules and operator env on top of the defaults', () => {
    const opts = buildOptions(
      {
        ...input,
        perRepo: { ...perRepo, allowed_tools: ['Bash(make lint)'] },
        review: { ...review, env: { ECC_GATEGUARD: 'off' } },
      },
      new AbortController(),
    );

    expect(opts.allowedTools).toContain('Bash(make lint)');
    expect(opts.env?.['ECC_GATEGUARD']).toBe('off');
    expect(opts.env?.['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBe('1');
    expect(opts.env?.['PATH']).toBe(process.env['PATH']);
  });

  it('keeps DENIED_TOOLS free of anything in the allow list', () => {
    const opts = buildOptions(input, new AbortController());

    expect(opts.allowedTools?.filter((t) => (DENIED_TOOLS as readonly string[]).includes(t))).toEqual([]);
  });
});

describe('user hooks', () => {
  it('turns off hooks from user settings by default, keeping the guard', () => {
    const opts = buildOptions(input, new AbortController());

    expect(opts.settings).toEqual({ disableAllHooks: true });
    expect(opts.hooks?.PreToolUse).toHaveLength(1);
  });

  it('leaves user hooks alone when disable_user_hooks is off', () => {
    const opts = buildOptions(
      { ...input, review: { ...review, disable_user_hooks: false } },
      new AbortController(),
    );

    expect(opts.settings).toBeUndefined();
  });
});

describe('sessionDataDir', () => {
  it('matches how Claude Code names the per-cwd project directory', () => {
    expect(
      sessionDataDir(
        '/Users/me',
        '/Users/me/Library/Application Support/ra/workspace/worktrees/20261027-2f1f7f4b1142',
        undefined,
      ),
    ).toBe(
      '/Users/me/.claude/projects/-Users-me-Library-Application-Support-ra-workspace-worktrees-20261027-2f1f7f4b1142',
    );
  });

  it("lets the session read its own offloaded tool output, but not another session's", async () => {
    const opts = buildOptions({ ...input, home: '/home/x' }, new AbortController());
    const hook = opts.hooks?.PreToolUse?.[0]?.hooks[0];
    const read = (file_path: string) =>
      hook?.(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path },
          tool_use_id: 't',
        } as never,
        't',
        {
          signal: new AbortController().signal,
        },
      );
    const own = `${sessionDataDir('/home/x', '/w')}/0f9a/tool-results/b0sm30mzt.txt`;

    expect(await read(own)).toEqual({});
    expect(await read('/home/x/.claude/projects/-other-session/0f9a/tool-results/x.txt')).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});

describe('allowedEnv', () => {
  it('passes only an allowlist of variables to the session', () => {
    const env = allowedEnv({
      PATH: '/bin',
      HOME: '/h',
      LANG: 'ja_JP.UTF-8',
      SLACK_BOT_TOKEN: 'xoxb-1',
      GH_TOKEN: 'ghp_x',
    });

    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'ja_JP.UTF-8' });
  });
});

describe('guard wiring', () => {
  it('installs the PreToolUse guard and confines reads to the checkout', async () => {
    const opts = buildOptions({ ...input, home: '/home/x' }, new AbortController());
    const hook = opts.hooks?.PreToolUse?.[0]?.hooks[0];
    const call = (file_path: string) =>
      hook?.(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path },
          tool_use_id: 't',
        } as never,
        't',
        {
          signal: new AbortController().signal,
        },
      );

    expect(await call('/w/src/a.ts')).toEqual({});
    expect(await call('/home/x/.config/review-automator/.env')).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});

describe('missingCapabilities', () => {
  it('reports missing skills and agents', () => {
    expect(
      missingCapabilities({ skills: [], agents: [] }, review, { ...perRepo, extra_skills: ['kb'] }),
    ).toEqual([
      'skill review-automator:pr-review',
      'skill kb',
      'agent review-automator:correctness-reviewer',
      'agent review-automator:security-reviewer',
      'agent review-automator:finding-verifier',
    ]);
  });

  it('skips the agent check on CLIs that do not report agents', () => {
    expect(missingCapabilities({ skills: ['review-automator:pr-review'] }, review, perRepo)).toEqual([]);
  });
});

describe('runEngine', () => {
  it('returns the validated structured result with cost and denials', async () => {
    const structured = { complete: true, summary: 'ok', findings: [finding()] };

    const run = await runEngine(
      { query: fakeQuery([INIT, success(structured)]), logger: silentLogger },
      input,
      {
        timeoutMs: 1000,
      },
    );

    expect(run.result).toEqual(structured);
    expect(run.costUsd).toBe(0.42);
    expect(run.permissionDenials[0]).toMatch(/^Bash .*npm test/);
  });

  it('fails fast when the configured skill is not loaded', async () => {
    const init = { ...INIT, skills: [] } as unknown as SDKMessage;

    await expect(
      runEngine(
        {
          query: fakeQuery([init, success({ complete: true, summary: '', findings: [] })]),
          logger: silentLogger,
        },
        input,
        {
          timeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({ kind: 'engine_init' });
  });

  it('rejects success without a schema-valid structured output', async () => {
    await expect(
      runEngine({ query: fakeQuery([INIT, success({ nope: true })]), logger: silentLogger }, input, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'engine_failed' });
  });

  it('treats an incomplete review as a failure, never as an empty LGTM', async () => {
    const incomplete = {
      complete: false,
      incomplete_reason: 'reviewers still running',
      summary: '',
      findings: [],
    };

    await expect(
      runEngine({ query: fakeQuery([INIT, success(incomplete)]), logger: silentLogger }, input, {
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/did not complete: reviewers still running/);
  });

  it('waits for subagents instead of letting them run in the background', () => {
    expect(buildOptions(input, new AbortController()).env?.['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe(
      '1',
    );
  });

  it('maps the budget error subtype', async () => {
    const budget = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      num_turns: 9,
      total_cost_usd: 3.1,
      permission_denials: [],
    };

    await expect(
      runEngine({ query: fakeQuery([INIT, budget as unknown as SDKMessage]), logger: silentLogger }, input, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'budget' });
  });

  it('times out a session that never finishes', async () => {
    const hanging: QueryFn = ({ options }) =>
      (async function* () {
        yield INIT;
        await new Promise((_, reject) =>
          options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      })();

    const err = await runEngine({ query: hanging, logger: silentLogger }, input, { timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ReviewError);
    expect(err).toMatchObject({ kind: 'timeout' });
  });

  it('stops at once when the signal was aborted before the session started', async () => {
    const hanging: QueryFn = ({ options }) =>
      (async function* () {
        yield INIT;
        await new Promise((_, reject) =>
          options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      })();
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      runEngine({ query: hanging, logger: silentLogger }, input, {
        timeoutMs: 60_000,
        signal: aborted.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it('wraps a crash of the session', async () => {
    const crashing: QueryFn = () =>
      (async function* () {
        yield INIT;
        throw new Error('process exited');
      })();

    await expect(
      runEngine({ query: crashing, logger: silentLogger }, input, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      kind: 'engine_failed',
    });
  });

  it('fails when the stream ends without a result', async () => {
    await expect(
      runEngine({ query: fakeQuery([INIT]), logger: silentLogger }, input, { timeoutMs: 1000 }),
    ).rejects.toThrow(/without a result/);
  });
});
