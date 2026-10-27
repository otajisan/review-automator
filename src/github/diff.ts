/**
 * Lines on the RIGHT (head) side of a PR that GitHub accepts inline review comments on:
 * added lines and context lines inside a hunk. Anything else is rejected with HTTP 422.
 */
export type CommentableLines = ReadonlyMap<string, ReadonlySet<number>>;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Undo git's C-style quoting, e.g. `"b/caf\303\251.txt"` → `b/café.txt`. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    // The full C-style escape set git uses when quoting paths.
    const escapes: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      a: '\x07',
      b: '\b',
      f: '\f',
      v: '\v',
      '"': '"',
      '\\': '\\',
    };
    bytes.push(...Buffer.from(escapes[next] ?? next, 'utf8'));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function newFilePath(line: string): string | null {
  const raw = unquoteGitPath(line.slice(4).replace(/\t.*$/, ''));
  if (raw === '/dev/null') return null;
  return raw.startsWith('b/') ? raw.slice(2) : raw;
}

export function parseCommentableLines(diff: string): CommentableLines {
  const result = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let rightLine = 0;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const file = newFilePath(line);
      current = file === null ? null : (result.get(file) ?? new Set<number>());
      if (file !== null && current) result.set(file, current);
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      rightLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || current === null) continue;

    if (line.startsWith('+') || line.startsWith(' ')) {
      current.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      // removed line or "\ No newline at end of file": no RIGHT-side line number
    } else if (line === '') {
      // trailing newline of the whole diff, or a blank context line some tools emit without the leading space
    } else {
      inHunk = false;
    }
  }
  return result;
}

export function isCommentable(lines: CommentableLines, path: string, line: number): boolean {
  return lines.get(path)?.has(line) ?? false;
}
