import type { Exec, ExecOptions, ExecResult } from '../../src/lib/exec.js';
import { ExecError } from '../../src/lib/exec.js';

export interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: ExecOptions | undefined;
}

type Responder = (call: Call) => Partial<ExecResult> | string;

/** Records every invocation; responds by first matching predicate. Unmatched calls fail loudly. */
export function fakeExec(routes: [(call: Call) => boolean, Responder][]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const route = routes.find(([match]) => match(call));
    if (!route) return Promise.reject(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
    const out = route[1](call);
    const result: ExecResult =
      typeof out === 'string'
        ? { stdout: out, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0, ...out };
    return result.exitCode === 0 ? Promise.resolve(result) : Promise.reject(new ExecError(cmd, args, result));
  };
  return { exec, calls };
}

export const argsStartWith =
  (...prefix: string[]) =>
  (call: Call): boolean =>
    prefix.every((p, i) => call.args[i] === p);
