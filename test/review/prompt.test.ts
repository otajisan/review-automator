import { describe, expect, it } from 'vitest';
import { buildPrompt, buildSystemAppend, perRepoConfig } from '../../src/review/prompt.js';
import { BASE_SHA, HEAD_SHA, testConfig, testPr } from '../helpers/fixtures.js';

const ws = {
  worktree: '/w',
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  conventionFiles: ['/Users/x/Library/Application Support/ra/conventions/r1/CLAUDE.md'],
  conventionsDir: '/c',
  repoDir: '/r',
  refs: [],
};

describe('buildPrompt', () => {
  it('dispatches the configured skill with every argument', () => {
    const config = testConfig();
    const pr = testPr();

    const prompt = buildPrompt({ config, pr, ws, perRepo: perRepoConfig(config, pr) });

    expect(prompt).toBe(
      `/review-automator:pr-review --repo acme/api --pr 7 --base ${BASE_SHA} --head ${HEAD_SHA}` +
        ' --reviewers review-automator:correctness-reviewer,review-automator:security-reviewer' +
        ' --verifier review-automator:finding-verifier --language en' +
        ' --conventions "/Users/x/Library/Application Support/ra/conventions/r1/CLAUDE.md"',
    );
  });

  it('adds extra skills for the matching repo, case-insensitively', () => {
    const config = testConfig('review: { per_repo: { "Acme/API": { extra_skills: [api-kb] } } }');
    const pr = testPr();

    const prompt = buildPrompt({
      config,
      pr,
      ws: { ...ws, conventionFiles: [] },
      perRepo: perRepoConfig(config, pr),
    });

    expect(prompt).toMatch(/ --extra-skills api-kb$/);
  });

  it('refuses values that could smuggle extra arguments', () => {
    const config = testConfig('review: { reviewers: ["a --verifier evil"] }');
    const pr = testPr();

    expect(() => buildPrompt({ config, pr, ws, perRepo: perRepoConfig(config, pr) })).toThrow(/unsafe value/);
  });
});

describe('buildSystemAppend', () => {
  it('always states that PR content is untrusted', () => {
    expect(buildSystemAppend({ extra_skills: [], allowed_tools: [], extra_instructions: '' })).toMatch(
      /untrusted data/,
    );
  });

  it('appends operator guidance when configured', () => {
    expect(
      buildSystemAppend({ extra_skills: [], allowed_tools: [], extra_instructions: 'Check i18n keys.' }),
    ).toMatch(/Check i18n keys\.$/);
  });
});
