import type { Exec, ExecOptions, ExecResult } from '../../src/lib/exec.js';
import { ExecError } from '../../src/lib/exec.js';

export interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: ExecOptions | undefined;
}

type Responder = (call: Call) => Partial<ExecResult> | string | Promise<Partial<ExecResult> | string>;

/** Records every invocation; responds by first matching predicate. Unmatched calls fail loudly. */
export function fakeExec(routes: [(call: Call) => boolean, Responder][]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const route = routes.find(([match]) => match(call));
    if (!route) return Promise.reject(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
    // A responder may return a promise to model a slow command.
    return Promise.resolve(route[1](call)).then((out) => {
      const result: ExecResult =
        typeof out === 'string'
          ? { stdout: out, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0, ...out };
      if (result.exitCode !== 0) throw new ExecError(cmd, args, result);
      return result;
    });
  };
  return { exec, calls };
}

export const argsStartWith =
  (...prefix: string[]) =>
  (call: Call): boolean =>
    prefix.every((p, i) => call.args[i] === p);
