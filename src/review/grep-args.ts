/**
 * Parses a `grep` command line far enough to tell file operands from patterns, so the guard can
 * confine the files and leave patterns such as `'/api/users'` alone. Options are an allowlist that
 * works for both GNU grep and macOS (BSD) grep; anything unknown is refused rather than guessed.
 * Long options must be spelled out: each grep resolves abbreviations against its own, larger option
 * table (`--binary` is a flag, not `--binary-files`), so guessing what an abbreviation means could let
 * a file operand pass as a pattern.
 */

export type GrepArgs =
  | {
      readonly ok: true;
      /** Files and directories grep will search. */
      readonly files: readonly string[];
      /** Values of options that name a file grep reads (`-f`, `--exclude-from`). */
      readonly optionFiles: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Short options without a value. `-R` / `-S` / `-O` (follow symlinks) are deliberately absent. */
const SHORT_FLAGS = new Set('EFGPiywxsvVbnHhoqaIlLcTUuzZrp0123456789');
/** Short options that take a value, attached (`-m5`) or as the next word. */
const SHORT_WITH_VALUE = new Set('efmABCdD');
const FOLLOWS_SYMLINKS = new Set('RSO');

const LONG_FLAGS = [
  '--extended-regexp',
  '--fixed-strings',
  '--basic-regexp',
  '--perl-regexp',
  '--ignore-case',
  '--no-ignore-case',
  '--word-regexp',
  '--line-regexp',
  '--no-messages',
  '--invert-match',
  '--byte-offset',
  '--line-number',
  '--no-line-number',
  '--line-buffered',
  '--with-filename',
  '--no-filename',
  '--only-matching',
  '--quiet',
  '--silent',
  '--text',
  '--files-without-match',
  '--files-with-matches',
  '--count',
  '--initial-tab',
  '--null',
  '--null-data',
  '--recursive',
  '--no-group-separator',
];
const LONG_WITH_VALUE = [
  '--regexp',
  '--file',
  '--max-count',
  '--after-context',
  '--before-context',
  '--context',
  '--directories',
  '--devices',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--label',
  '--binary-files',
  '--group-separator',
  '--color',
  '--colour',
];
/** GNU and BSD grep disagree on whether these take the next word as a value; only `=` is unambiguous. */
const LONG_ATTACHED_VALUE_ONLY = new Set(['--color', '--colour', '--context']);
const PATTERN_OPTIONS = new Set(['-e', '-f', '--regexp', '--file']);
const FILE_OPTIONS = new Set(['-f', '--file', '--exclude-from']);
/** Allowed values for options whose value changes what grep opens. */
const ENUM_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['-d', new Set(['read', 'skip', 'recurse'])],
  ['--directories', new Set(['read', 'skip', 'recurse'])],
  ['-D', new Set(['read', 'skip'])],
  ['--devices', new Set(['read', 'skip'])],
]);
const SYMLINK_ADVICE = 'follows symlinks out of the checkout; use grep -r';

type DirectoryMode = 'read' | 'skip' | 'recurse';

/** What one option contributes; `used` is how many following words it consumed as its value. */
interface OptionResult {
  readonly used: number;
  readonly isPattern?: boolean;
  readonly file?: string;
  readonly directories?: DirectoryMode;
}
type Step = OptionResult | string;

const DIRECTORY_OPTIONS = new Set(['-d', '--directories']);

function withValue(option: string, value: string, used: number): Step {
  const allowed = ENUM_VALUES.get(option);
  if (allowed && !allowed.has(value)) return `grep ${option} ${value} is not allowed`;
  if (FILE_OPTIONS.has(option) && (value === '-' || value === '')) {
    return `grep ${option} needs a file, not stdin`;
  }
  return {
    used,
    isPattern: PATTERN_OPTIONS.has(option),
    ...(FILE_OPTIONS.has(option) ? { file: value } : {}),
    ...(DIRECTORY_OPTIONS.has(option) ? { directories: value as DirectoryMode } : {}),
  };
}

/** `-abc`, `-m5`, `-e pattern`: letters are flags until one takes the rest of the word as its value. */
function parseShort(token: string, next: string | undefined): Step {
  let recursive = false;
  for (let i = 1; i < token.length; i++) {
    const ch = token.charAt(i);
    if (SHORT_WITH_VALUE.has(ch)) {
      const attached = token.slice(i + 1);
      if (!attached && next === undefined) return `grep -${ch} needs a value`;
      const step = withValue(`-${ch}`, attached || next || '', attached ? 0 : 1);
      if (typeof step === 'string' || !recursive || step.directories) return step;
      return { ...step, directories: 'recurse' };
    }
    if (FOLLOWS_SYMLINKS.has(ch)) return `grep -${ch} ${SYMLINK_ADVICE}`;
    if (!SHORT_FLAGS.has(ch)) return `grep -${ch} is not allowed in a read-only review`;
    if (ch === 'r') recursive = true;
  }
  return recursive ? { used: 0, directories: 'recurse' } : { used: 0 };
}

function parseLong(token: string, next: string | undefined): Step {
  const eq = token.indexOf('=');
  const name = eq === -1 ? token : token.slice(0, eq);
  if (name.length > 3 && '--dereference-recursive'.startsWith(name)) {
    return `grep --dereference-recursive ${SYMLINK_ADVICE}`;
  }
  if (LONG_FLAGS.includes(name)) {
    if (eq !== -1) return `grep ${name} does not take a value`;
    return name === '--recursive' ? { used: 0, directories: 'recurse' } : { used: 0 };
  }
  if (!LONG_WITH_VALUE.includes(name)) {
    return `grep ${name} is not allowed in a read-only review (spell long options out in full)`;
  }
  if (eq !== -1) return withValue(name, token.slice(eq + 1), 0);
  if (name === '--context') return 'write grep --context=N, or use -C N';
  if (LONG_ATTACHED_VALUE_ONLY.has(name)) return { used: 0 };
  if (next === undefined) return `grep ${name} needs a value`;
  return withValue(name, next, 1);
}

/** `args` excludes the leading `grep`. Options may follow operands, as both greps permute them. */
export function parseGrepArgs(args: readonly string[]): GrepArgs {
  let operands: readonly string[] = [];
  let optionFiles: readonly string[] = [];
  let hasPattern = false;
  let directories: DirectoryMode = 'read';
  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? '';
    if (token === '--') {
      operands = [...operands, ...args.slice(i + 1)];
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      operands = [...operands, token];
      i += 1;
      continue;
    }
    const next = args[i + 1];
    const step = token.startsWith('--') ? parseLong(token, next) : parseShort(token, next);
    if (typeof step === 'string') return { ok: false, reason: step };
    hasPattern ||= step.isPattern === true;
    directories = step.directories ?? directories;
    if (step.file !== undefined) optionFiles = [...optionFiles, step.file];
    i += 1 + step.used;
  }
  if (!hasPattern && operands.length === 0) return { ok: false, reason: 'grep needs a pattern' };
  const named = hasPattern ? operands : operands.slice(1);
  // A recursive grep with no file searches the working directory; any other grep would read stdin.
  const files = named.length === 0 && directories === 'recurse' ? ['.'] : named;
  if (files.length === 0 || files.includes('-')) {
    return { ok: false, reason: 'name the files or directories to search, e.g. grep -rn "x" src' };
  }
  return { ok: true, files, optionFiles };
}
