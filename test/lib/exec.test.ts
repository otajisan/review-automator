import { describe, expect, it } from 'vitest';
import { exec, ExecError, ExecTimeoutError } from '../../src/lib/exec.js';

describe('exec', () => {
  it('returns stdout of a successful command', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write("hi")']);

    expect(result).toEqual({ stdout: 'hi', stderr: '', exitCode: 0 });
  });

  it('passes arguments verbatim without shell interpretation', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); `id`']);

    expect(result.stdout).toBe('$(echo pwned); `id`');
  });

  it('feeds input to stdin', async () => {
    const result = await exec('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: '{"a":1}' });

    expect(result.stdout).toBe('{"a":1}');
  });

  it('rejects with ExecError carrying stderr on non-zero exit', async () => {
    const run = exec('node', ['-e', 'process.stderr.write("boom"); process.exit(3)']);

    await expect(run).rejects.toBeInstanceOf(ExecError);
    await expect(run).rejects.toMatchObject({ result: { exitCode: 3, stderr: 'boom' } });
  });

  it('kills the process and rejects on timeout', async () => {
    await expect(
      exec('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(exec('definitely-not-a-real-binary-xyz', [])).rejects.toThrow(/failed to start/);
  });
});
