import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Every tool call in the review session — including subagents' — passes through this guard
 * before Claude Code's own permission rules. Permission rules match by prefix and cannot see
 * options such as `git show --output=~/.zshrc`, and the operator's own `~/.claude/settings.json`
 * may pre-allow tools (MCP servers that post to Slack or GitHub) that a prompt-injected review must
 * never reach. So the guard is an allowlist: anything it does not understand is denied.
 */

export type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface GuardContext {
  /** Directories the session may read. Resolved with realpath before comparison. */
  readonly readableRoots: readonly string[];
  /** Working directory used to resolve relative paths (the PR checkout). */
  readonly cwd: string;
  /** Operator-approved `Bash(...)` rules and tool names from per_repo.allowed_tools. */
  readonly extraRules: readonly string[];
  /**
   * Subagents and skills the review may launch. A user-level agent can carry its own hooks, which
   * run with the checkout as cwd; only the configured, reviewed ones are allowed.
   * Undefined means "do not restrict" (used by tests of unrelated rules).
   */
  readonly allowedAgents?: readonly string[];
  readonly allowedSkills?: readonly string[];
}

const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

/** Tools with no side effects outside the session itself. */
const ALWAYS_ALLOWED = new Set(['StructuredOutput', 'TodoWrite']);
/** Claude Code's built-in subagent; it has no hooks of its own and runs under this guard. */
const BUILTIN_AGENTS = ['general-purpose'];

const GIT_SUBCOMMANDS = new Set([
  'diff',
  'log',
  'show',
  'blame',
  'status',
  'merge-base',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
]);

/** Options that write files, read outside the repository, or run external programs. */
const GIT_FORBIDDEN_OPTIONS = new Set([
  '--output',
  '--no-index',
  '--contents',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--open-files-in-pager',
  '-O',
  '--exec',
  '--upload-pack',
  '--git-dir',
  '--work-tree',
  '--paginate',
]);

/** Never allowed anywhere, even inside quotes or in operator-approved commands. */
const ALWAYS_FORBIDDEN = /[\n\r`]|\$\(|\$\{/;
/** Shell syntax that is only harmless inside quotes: chaining, redirection, subshells, escapes. */
const UNQUOTED_CONTROL = new Set([';', '&', '|', '<', '>', '(', ')', '$', '\\']);
/**
 * Expansions that turn one word into other words. They are refused outside quotes for git commands:
 * `--{output=/x,stat}` becomes `--output=/x`, and `git diff *` expands a committed file named
 * `--output=...` into an option. zsh also expands `=cmd` to a path, and `~` to a home directory.
 */
const UNQUOTED_EXPANSION = new Set(['{', '}', '*', '?', '[', ']']);
const EXPANDING_WORD_START = new Set(['~', '=']);

/**
 * Splits a command the way a POSIX shell would for simple words, honouring single and double
 * quotes. Returns null if the command uses shell syntax outside quotes, expands variables inside
 * double quotes, or has unbalanced quotes — so `git grep -nE "a|b"` passes but `git log | sh` does not.
 * With `strict`, word-producing expansions outside quotes are refused as well.
 */
export function tokenize(command: string, opts: { strict?: boolean } = {}): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  let escaped = false; // previous char was a backslash inside double quotes
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      // POSIX: inside double quotes a backslash only escapes $ ` " \; elsewhere (`\b`, `\|` in a
      // regex) it is a literal backslash. Either way nothing is expanded or executed.
      if (escaped) {
        current += '$`"\\'.includes(ch) ? ch : `\\${ch}`;
        escaped = false;
      } else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
      else if (ch === '$') return null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (UNQUOTED_CONTROL.has(ch)) return null;
    if (ch === ' ' || ch === '\t') {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    if (opts.strict && UNQUOTED_EXPANSION.has(ch)) return null;
    if (opts.strict && !inToken && EXPANDING_WORD_START.has(ch)) return null;
    current += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

/** Real options that happen to be prefixes of forbidden ones; git matches them exactly. */
/**
 * Real options that happen to be prefixes of forbidden ones, and the subcommands where git resolves
 * them exactly. Elsewhere `--text` is an abbreviation of `--textconv` (e.g. `git cat-file --text`).
 */
const EXACT_ALLOWED_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['--text', new Set(['diff', 'log', 'show', 'grep'])],
]);

/** git accepts unique prefixes of long options (`--op` for `--open-files-in-pager`); treat those alike. */
function abbreviatesForbidden(name: string, sub: string): boolean {
  if (!name.startsWith('--') || name.length < 3) return false;
  if (EXACT_ALLOWED_OPTIONS.get(name)?.has(sub)) return false;
  return [...GIT_FORBIDDEN_OPTIONS].some((opt) => opt.startsWith('--') && opt.startsWith(name));
}

function optionName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Everything in a token git might treat as a path: the token, a `--opt=value`, or the value attached
 * to a short option (`-O<file>`, `-f<file>`).
 */
function pathCandidates(token: string): string[] {
  const candidates = [token];
  const eq = token.indexOf('=');
  if (token.startsWith('--') && eq !== -1) candidates.push(token.slice(eq + 1));
  // A short-option cluster can end in an argument anywhere: `-nf/etc/hosts` is `-n -f /etc/hosts`.
  if (/^-[A-Za-z0-9]/.test(token)) {
    for (let i = 2; i < token.length; i++) candidates.push(token.slice(i));
  }
  return candidates.filter((c) => c.length > 0);
}

/**
 * `..` is resolved by the OS after following symlinks (`outside/../x` with `outside -> ~/.ssh`
 * opens `~/x`), but by path.resolve before. Refusing it outright avoids the disagreement.
 */
function hasParentSegment(p: string): boolean {
  return p.split(/[/\\]/).includes('..');
}

function existsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * git may only see paths inside the checkout. Explicit outside paths make `git diff` switch to
 * --no-index silently; and a PR can commit a symlink (`outside -> ~`) so that an innocent-looking
 * relative path such as `outside/.ssh/id_ed25519` resolves elsewhere.
 */
function escapesCheckout(candidate: string, ctx: GuardContext): boolean {
  if (candidate.startsWith('~') || hasParentSegment(candidate)) return true;
  const abs = path.resolve(ctx.cwd, candidate);
  const looksLikePath = path.isAbsolute(candidate) || candidate.split('/').includes('..');
  if (!looksLikePath && !existsNoFollow(abs)) return false; // a ref, range or pathspec, not a file
  return !isInside(abs, [ctx.cwd]);
}

export function evaluateGit(tokens: readonly string[], ctx: GuardContext): Verdict {
  const sub = tokens[1];
  if (!sub || sub.startsWith('-'))
    return deny('git global options are not allowed; use `git <subcommand> ...`');
  if (!GIT_SUBCOMMANDS.has(sub)) return deny(`git ${sub} is not allowed in a read-only review`);
  for (const token of tokens.slice(2)) {
    const name = optionName(token);
    if (GIT_FORBIDDEN_OPTIONS.has(name) || abbreviatesForbidden(name, sub)) {
      return deny(`git option ${name} is not allowed in a read-only review`);
    }
    // git grep's -O runs a pager command; catch it in short-option clusters such as `-nO` or `-1O`.
    if (sub === 'grep' && /^-[A-Za-z0-9]*O/.test(token)) return deny('git grep -O is not allowed');
    const outside = pathCandidates(token).find((c) => escapesCheckout(c, ctx));
    if (outside) return deny(`${outside} is outside the review checkout; use paths inside it`);
  }
  return ALLOW;
}

/** `Bash(python3 /x/match.py *)` matches `python3 /x/match.py --base origin/main`. */
export function bashRuleMatches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m?.[1]) return false;
  const pattern = m[1].replace(/:\*$/, ' *');
  const body = pattern
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(command);
}

export function evaluateBash(command: string, ctx: GuardContext): Verdict {
  const trimmed = command.trim();
  if (ALWAYS_FORBIDDEN.test(trimmed)) return deny('newlines and command substitution are not allowed');
  const loose = tokenize(trimmed);
  if (!loose || loose.length === 0) {
    return deny('shell operators, redirection and substitution are not allowed; run one plain command');
  }
  // Operator-approved commands may use `~` paths and globs; chaining was already refused above.
  if (ctx.extraRules.some((rule) => bashRuleMatches(rule, trimmed))) return ALLOW;
  if (loose[0] !== 'git') return deny(`${loose[0]} is not allowed; only read-only git commands can run`);
  const tokens = tokenize(trimmed, { strict: true });
  if (!tokens) {
    return deny(
      "quote glob patterns and braces, e.g. git grep -n 'x' -- '*.ts'; unquoted shell expansion is not allowed",
    );
  }
  return evaluateGit(tokens, ctx);
}

function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A path that does not exist: resolve its parent so `..` and symlinks are still caught.
    const parent = path.dirname(p);
    return parent === p ? p : path.join(resolveReal(parent), path.basename(p));
  }
}

function isInside(target: string, roots: readonly string[]): boolean {
  const abs = resolveReal(target);
  return roots.some((root) => {
    const r = resolveReal(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
}

export function isReadable(target: string, ctx: GuardContext): boolean {
  return isInside(path.resolve(ctx.cwd, target), ctx.readableRoots);
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function evaluateAgent(input: unknown, ctx: GuardContext): Verdict {
  if (!ctx.allowedAgents) return ALLOW;
  const type = stringField(input, 'subagent_type') ?? 'general-purpose';
  if ([...ctx.allowedAgents, ...BUILTIN_AGENTS].includes(type)) return ALLOW;
  return deny(`subagent ${type} is not one of the configured reviewers`);
}

function evaluateSkill(input: unknown, ctx: GuardContext): Verdict {
  if (!ctx.allowedSkills) return ALLOW;
  const skill = (stringField(input, 'skill') ?? '').replace(/^\//, '');
  if (ctx.allowedSkills.includes(skill)) return ALLOW;
  return deny(`skill ${skill || '(none)'} is not configured for this review`);
}

function readablePath(p: string, ctx: GuardContext): boolean {
  return !hasParentSegment(p) && isReadable(p, ctx);
}

export function evaluateToolCall(toolName: string, input: unknown, ctx: GuardContext): Verdict {
  if (ALWAYS_ALLOWED.has(toolName)) return ALLOW;
  switch (toolName) {
    case 'Agent':
    case 'Task':
      return evaluateAgent(input, ctx);
    case 'Skill':
      return evaluateSkill(input, ctx);
    case 'Read': {
      const file = stringField(input, 'file_path');
      if (!file) return deny('Read requires file_path');
      return readablePath(file, ctx) ? ALLOW : deny(`${file} is outside the review checkout`);
    }
    case 'Grep':
    case 'Glob': {
      const dir = stringField(input, 'path') ?? ctx.cwd;
      if (!readablePath(dir, ctx)) return deny(`${dir} is outside the review checkout`);
      const pattern = toolName === 'Glob' ? stringField(input, 'pattern') : undefined;
      if (pattern && (pattern.startsWith('/') || pattern.startsWith('~') || pattern.includes('..'))) {
        return deny('Glob patterns must be relative to the checkout');
      }
      return ALLOW;
    }
    case 'Bash': {
      const command = stringField(input, 'command');
      return command ? evaluateBash(command, ctx) : deny('Bash requires command');
    }
    default:
      // Operator-approved non-Bash tools, e.g. a read-only MCP tool listed in per_repo.allowed_tools.
      if (ctx.extraRules.includes(toolName)) return ALLOW;
      return deny(`${toolName} is not available in a read-only review`);
  }
}

/** Wraps the guard as an Agent SDK PreToolUse hook. The denial reason is shown to the model. */
export function toolGuardHook(
  ctx: GuardContext,
  onDeny?: (tool: string, reason: string) => void,
  /** Called for every tool call the guard inspects, allowed or not. */
  onCheck?: () => void,
): HookCallbackMatcher {
  return {
    hooks: [
      (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
        onCheck?.();
        const verdict = evaluateToolCall(input.tool_name, input.tool_input, ctx);
        if (verdict.allow) return Promise.resolve({});
        onDeny?.(input.tool_name, verdict.reason);
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason,
          },
        });
      },
    ],
  };
}
