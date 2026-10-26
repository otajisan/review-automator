import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Shape of the process runner. Injected so callers can be unit-tested without spawning. */
export type Exec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export class ExecError extends AppError {
  constructor(
    readonly cmd: string,
    readonly args: readonly string[],
    readonly result: ExecResult,
  ) {
    super(`${cmd} ${args.join(' ')} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
}

export class ExecTimeoutError extends AppError {
  constructor(cmd: string, args: readonly string[], timeoutMs: number) {
    super(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs a command with an argument array. Never goes through a shell, so values taken from
 * Slack messages or PR content cannot be interpreted as shell syntax.
 */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new ExecTimeoutError(cmd, args, timeoutMs));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(new AppError(`failed to start ${cmd}: ${err.message}`, { cause: err }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const result: ExecResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? -1,
      };
      if (result.exitCode === 0) resolve(result);
      else reject(new ExecError(cmd, args, result));
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
