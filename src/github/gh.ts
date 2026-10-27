import type { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { exec as defaultExec, type Exec } from '../lib/exec.js';

export interface Gh {
  /** Runs `gh <args>` and returns raw stdout. */
  run(args: readonly string[], opts?: { input?: string; cwd?: string }): Promise<string>;
  /** Runs `gh <args>` and validates stdout as JSON against `schema`. */
  json<T>(args: readonly string[], schema: z.ZodType<T>, opts?: { input?: string }): Promise<T>;
}

const GH_TIMEOUT_MS = 60_000;
const TOKEN_TTL_MS = 5 * 60_000;

export interface GhOptions {
  /**
   * Pin every call to this account's stored credentials. Without it, gh uses whichever account is
   * active, and `gh auth switch` in a terminal would silently change who posts reviews.
   */
  readonly login?: string;
  readonly hostname?: string;
  readonly now?: () => number;
}

/**
 * Thin wrapper over the `gh` CLI. Using `gh` means every write to GitHub happens with credentials
 * the user already has, and no GitHub token lives in our config.
 */
export function createGh(exec: Exec = defaultExec, bin = 'gh', options: GhOptions = {}): Gh {
  const now = options.now ?? Date.now;
  let cached: { token: string; at: number } | undefined;

  async function tokenFor(login: string): Promise<string> {
    if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.token;
    try {
      const { stdout } = await exec(
        bin,
        ['auth', 'token', '--hostname', options.hostname ?? 'github.com', '--user', login],
        { timeoutMs: GH_TIMEOUT_MS },
      );
      const token = stdout.trim();
      if (!token) throw new Error('empty token');
      cached = { token, at: now() };
      return token;
    } catch (err) {
      throw new AppError(`gh has no credentials for ${login}; run: gh auth login`, { cause: err });
    }
  }

  const run: Gh['run'] = async (args, opts = {}) => {
    const env = options.login ? { ...process.env, GH_TOKEN: await tokenFor(options.login) } : undefined;
    const result = await exec(bin, args, {
      timeoutMs: GH_TIMEOUT_MS,
      ...(env ? { env } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    return result.stdout;
  };

  return {
    run,
    async json(args, schema, opts) {
      const stdout = await run(args, opts);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        throw new AppError(`gh ${args[0] ?? ''} returned non-JSON output`, { cause: err });
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new AppError(`gh ${args[0] ?? ''} returned unexpected JSON: ${result.error.message}`);
      }
      return result.data;
    },
  };
}
