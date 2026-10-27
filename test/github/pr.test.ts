import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGh } from '../../src/github/gh.js';
import {
  diffFromFiles,
  extractPrRefs,
  fetchDiffForComments,
  fetchPr,
  isRepoAllowed,
  prSlug,
  prUrl,
} from '../../src/github/pr.js';
import { argsStartWith, fakeExec } from '../helpers/fake-exec.js';

const SHA = 'a'.repeat(40);

describe('extractPrRefs', () => {
  it('finds a bare PR URL', () => {
    expect(extractPrRefs('please review https://github.com/acme/api/pull/42 thanks')).toEqual([
      { owner: 'acme', repo: 'api', number: 42 },
    ]);
  });

  it('finds a Slack-wrapped link with a label', () => {
    expect(extractPrRefs('<https://github.com/acme/web.app/pull/7|acme/web.app#7> お願いします')).toEqual([
      { owner: 'acme', repo: 'web.app', number: 7 },
    ]);
  });

  it('ignores /files and other suffixes but keeps the PR', () => {
    expect(extractPrRefs('https://github.com/acme/api/pull/42/files#diff-1')).toHaveLength(1);
  });

  it('dedupes the same PR mentioned twice regardless of case', () => {
    const text = 'https://github.com/acme/api/pull/1 and <https://github.com/Acme/API/pull/1>';

    expect(extractPrRefs(text)).toHaveLength(1);
  });

  it('returns multiple distinct PRs in order', () => {
    const refs = extractPrRefs('https://github.com/a/b/pull/2 https://github.com/a/b/pull/1');

    expect(refs.map((r) => r.number)).toEqual([2, 1]);
  });

  it('rejects owner or repo names that are dot paths', () => {
    expect(
      extractPrRefs(
        'https://github.com/../x/pull/1 https://github.com/a/../pull/2 https://github.com/a/.git/pull/3',
      ),
    ).toEqual([]);
  });

  it('ignores issue links and other hosts', () => {
    expect(extractPrRefs('https://github.com/a/b/issues/1 https://gitlab.com/a/b/pull/1')).toEqual([]);
  });
});

describe('isRepoAllowed', () => {
  const ref = { owner: 'Acme', repo: 'api', number: 1 };

  it('matches org globs case-insensitively', () => {
    expect(isRepoAllowed(ref, ['acme/*'])).toBe(true);
  });

  it('rejects repos outside the list', () => {
    expect(isRepoAllowed(ref, ['other/*', 'acme/web'])).toBe(false);
  });
});

describe('prSlug / prUrl', () => {
  it('formats a ref', () => {
    const ref = { owner: 'a', repo: 'b', number: 3 };

    expect(prSlug(ref)).toBe('a/b#3');
    expect(prUrl(ref)).toBe('https://github.com/a/b/pull/3');
  });
});

describe('fetchPr', () => {
  it('maps gh pr view JSON into PrInfo', async () => {
    const { exec, calls } = fakeExec([
      [
        argsStartWith('pr', 'view'),
        () =>
          JSON.stringify({
            number: 5,
            url: 'https://github.com/acme/api/pull/5',
            title: 'Add thing',
            state: 'OPEN',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: SHA,
            baseRefName: 'main',
            body: null,
          }),
      ],
    ]);

    const pr = await fetchPr(createGh(exec), { owner: 'acme', repo: 'api', number: 5 });

    expect(pr).toMatchObject({ author: 'alice', headSha: SHA, baseRef: 'main', state: 'OPEN', body: '' });
    expect(calls[0]?.args).toContain('--repo');
    expect(calls[0]?.args).toContain('acme/api');
  });
});

describe('createGh.json', () => {
  it('fails clearly on non-JSON output', async () => {
    const { exec } = fakeExec([[() => true, () => 'not json']]);

    await expect(createGh(exec).json(['api', 'x'], z.object({}))).rejects.toThrow(/non-JSON/);
  });

  it('fails clearly when JSON does not match the schema', async () => {
    const { exec } = fakeExec([[() => true, () => '{"a":1}']]);

    await expect(createGh(exec).json(['api', 'x'], z.object({ b: z.string() }))).rejects.toThrow(
      /unexpected JSON/,
    );
  });
});

describe('fetchDiffForComments', () => {
  const ref = { owner: 'acme', repo: 'api', number: 5 };

  it('keeps text patches when a binary file has no patch in the files API', async () => {
    const { exec } = fakeExec([
      [argsStartWith('pr', 'diff'), () => ({ exitCode: 1, stderr: 'HTTP 406: diff too large' })],
      [
        argsStartWith('api', '--paginate'),
        () =>
          [
            JSON.stringify({ filename: 'img.png', patch: null }),
            JSON.stringify({ filename: 'src/a.ts', patch: '@@ -1 +1,2 @@\n a\n+b' }),
          ].join('\n'),
      ],
    ]);
    const steps: string[] = [];

    const diff = await fetchDiffForComments(createGh(exec), ref, (step) => steps.push(step));

    expect(steps).toEqual(['files_api']);
    expect(diff).toContain('+++ b/src/a.ts');
    expect(diff).not.toContain('img.png');
  });

  it('returns an empty diff instead of throwing when every source fails', async () => {
    const { exec } = fakeExec([[() => true, () => ({ exitCode: 1, stderr: 'boom' })]]);

    expect(await fetchDiffForComments(createGh(exec), ref)).toBe('');
  });

  it('diffFromFiles rebuilds headers for each text patch', () => {
    expect(diffFromFiles([{ filename: 'x.ts', patch: '@@ -1 +1 @@\n-a\n+b' }])).toBe(
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
    );
  });
});

describe('createGh with a pinned login', () => {
  it("runs every call with that account's token, not the active account", async () => {
    const { exec, calls } = fakeExec([
      [argsStartWith('auth', 'token'), () => 'tok-owner\n'],
      [argsStartWith('api'), () => '{}'],
    ]);
    const gh = createGh(exec, 'gh', { login: 'owner' });

    await gh.run(['api', 'user']);
    await gh.run(['api', 'user']);

    expect(calls[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'owner']);
    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(1); // cached
    expect(calls[1]?.opts?.env?.['GH_TOKEN']).toBe('tok-owner');
  });

  it('fails clearly when gh has no credentials for the owner', async () => {
    const { exec } = fakeExec([
      [argsStartWith('auth', 'token'), () => ({ exitCode: 1, stderr: 'no account' })],
    ]);

    await expect(createGh(exec, 'gh', { login: 'owner' }).run(['api', 'user'])).rejects.toThrow(
      /no credentials for owner/,
    );
  });
});
