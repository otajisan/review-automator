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
    // Regex escapes inside double quotes, as reviewers write them (seen denied in real reviews):
    'git grep -n -E "class (ReportRow|ReportDto)\\b" -- src',
    'git grep -n "foo\\|bar" -- src/a.ts',
    // Plain grep, as reviewers write it (seen denied in real reviews):
    'grep -rn "MetricBasis\\|daily_total" src/a.ts src',
    'grep -n "def \\|^class " "src/a.ts"',
    "grep -rn --include='*.ts' 'TODO' .",
    'grep -c x src/a.ts',
    // Found by Codex: patterns are not paths, and options may follow the files.
    "grep -n -e '/api/users' src/a.ts",
    "grep -rn '../lib' src",
    'grep -n name src/a.ts -i',
    'grep -n name src/a.ts --',
    'grep -eREADME src/a.ts',
    'grep -e -R src/a.ts',
    'grep -- -R src/a.ts',
    'grep -F -fsrc/a.ts src',
    "grep -n '#' src/a.ts",
    'grep -rn -A2 --include="*.ts" x src',
    // Found by Codex in the second round:
    'grep -rn TODO',
    'grep -r -A2 TODO',
    'grep --recursive -n TODO',
    'grep -n --context=2 x src/a.ts',
    'grep -n --color x src/a.ts',
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
    ['substitution hidden behind an escaped dollar', 'git log "\\$(id)"'],
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
    // Plain grep gets the same path checks as git:
    ['grep on a file outside the checkout', 'grep -n root /etc/passwd'],
    ['grep through a committed symlink', 'grep -n x outside/.ssh/id_ed25519'],
    ['grep recursing from a committed symlinked directory', 'grep -rn x outside'],
    ['grep with a parent-relative path', 'grep -rn x ../..'],
    ['grep with a tilde path', 'grep -rn x ~/.ssh'],
    ['grep with a pattern file outside the checkout', 'grep -f /etc/hosts src/a.ts'],
    ['grep with an attached pattern file outside the checkout', 'grep -nf/etc/hosts src/a.ts'],
    ['grep with an --exclude-from file outside the checkout', 'grep -r --exclude-from=/etc/hosts x .'],
    ['grep with no file (it would read stdin)', 'grep -n x'],
    ['grep following symlinks while recursing (-R)', 'grep -Rn x .'],
    ['grep following symlinks while recursing (-S)', 'grep -rSn x .'],
    ['grep following symlinks via the long option', 'grep --dereference-recursive x .'],
    ['grep following symlinks via an abbreviated long option', 'grep --deref x .'],
    ['grep with an unquoted glob', 'grep -n x src/*.ts'],
    ['grep piped into another command', 'grep -rn x . | sh'],
    ['other commands named like grep', 'egrep -rn x .'],
    // Found by Codex: grep must never wait on stdin.
    ['grep whose only operand is the pattern', 'grep -n src/a.ts'],
    ['grep -e with no file', 'grep -e src/a.ts'],
    ['grep -f with no file', 'grep -F -f src/a.ts'],
    ['grep with - as a file', 'grep x - src/a.ts'],
    ['grep -f reading stdin', 'grep -f - src/a.ts'],
    ['grep -f- attached', 'grep -nf- src/a.ts'],
    ['grep --file=- abbreviated', 'grep --fil=- src/a.ts'],
    ['grep --exclude-from=-', 'grep -r --exclude-from=- x src'],
    ['a shell comment hiding the file', 'grep -n x # src/a.ts'],
    ['grep -D with an unknown action', 'grep -D skipx x src/a.ts'],
    ['grep -d with an unknown action', 'grep --directories=follow x src'],
    ['grep -m without its value', 'grep x src/a.ts -m'],
    ['grep with no pattern', 'grep -n'],
    // Found by Codex in the second round:
    ['an abbreviation another grep reads as a different flag', 'grep --binary localhost /etc/hosts src/a.ts'],
    ['an abbreviated long option', 'grep --line-num x src/a.ts'],
    ['--context with a separate value (GNU and BSD disagree)', 'grep --context 2 src/a.ts src'],
    ['a recursive grep switched back to reading directories', 'grep -r -d read TODO'],
    ['grep with an unknown option', 'grep --mmap x src/a.ts'],
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
  it('tokenize applies POSIX backslash rules inside double quotes', () => {
    expect(tokenize('git grep "a\\"b" "c\\d" "e\\\\f"')).toEqual(['git', 'grep', 'a"b', 'c\\d', 'e\\f']);
    expect(tokenize('git grep "unterminated\\"')).toBeNull();
  });

  it('tokenize honours quotes', () => {
    expect(tokenize(`git grep -n "a b" 'c d'`)).toEqual(['git', 'grep', '-n', 'a b', 'c d']);
    expect(tokenize('git "x')).toBeNull();
  });

  it('bashRuleMatches supports the legacy :* suffix', () => {
    expect(bashRuleMatches('Bash(make lint:*)', 'make lint --fast')).toBe(true);
    expect(bashRuleMatches('Bash(make lint)', 'make lint --fast')).toBe(false);
  });
});
