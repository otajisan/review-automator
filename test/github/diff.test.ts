import { describe, expect, it } from 'vitest';
import { isCommentable, parseCommentableLines } from '../../src/github/diff.js';

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-old2
+new2
+new3
 line4
@@ -20,2 +21,3 @@ function x() {
 ctx21
+add22
 ctx23
`;

describe('parseCommentableLines', () => {
  it('collects added and context lines across hunks', () => {
    const lines = parseCommentableLines(MODIFIED);

    expect([...(lines.get('src/a.ts') ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 21, 22, 23]);
  });

  it('excludes lines between hunks', () => {
    const lines = parseCommentableLines(MODIFIED);

    expect(isCommentable(lines, 'src/a.ts', 10)).toBe(false);
  });

  it('handles new files', () => {
    const diff = `diff --git a/n.ts b/n.ts
new file mode 100644
--- /dev/null
+++ b/n.ts
@@ -0,0 +1,2 @@
+a
+b
`;

    expect([...(parseCommentableLines(diff).get('n.ts') ?? [])]).toEqual([1, 2]);
  });

  it('skips deleted files entirely', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;

    expect(parseCommentableLines(diff).size).toBe(0);
  });

  it('uses the new path for renames', () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-x
+y
`;

    expect(isCommentable(parseCommentableLines(diff), 'new.ts', 1)).toBe(true);
  });

  it('ignores the no-newline marker', () => {
    const diff = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1 +1 @@
-x
\\ No newline at end of file
+y
\\ No newline at end of file
`;

    expect([...(parseCommentableLines(diff).get('a') ?? [])]).toEqual([1]);
  });

  it('does not treat "+++" inside a hunk as a new file header', () => {
    const diff = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,1 +1,2 @@
 x
+++ not a header
`;

    expect([...(parseCommentableLines(diff).get('a.md') ?? [])]).toEqual([1, 2]);
  });

  it('unquotes paths git escaped', () => {
    const diff = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -0,0 +1 @@
+x
`;

    expect(isCommentable(parseCommentableLines(diff), 'café.ts', 1)).toBe(true);
  });

  it('decodes the full set of escapes git uses in quoted paths', () => {
    const diff = `diff --git "a/a\\rb.ts" "b/a\\rb.ts"
--- "a/a\\rb.ts"
+++ "b/a\\rb.ts"
@@ -0,0 +1 @@
+x
`;

    const lines = parseCommentableLines(diff);

    expect(isCommentable(lines, 'a\rb.ts', 1)).toBe(true);
    expect(isCommentable(lines, 'arb.ts', 1)).toBe(false);
  });

  it('handles binary files without hunks', () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

    expect(parseCommentableLines(diff).size).toBe(0);
  });
});
