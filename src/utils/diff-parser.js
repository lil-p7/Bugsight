/**
 * Unified-diff parsing for the Phase 3 review pipeline.
 *
 * GitHub's PR diff endpoint returns the same bytes `git diff` prints. The
 * pipeline needs three things from it:
 *  1. which files changed (and their status: added/deleted/binary),
 *  2. which lines are *new* — the review rules only care about issues the
 *     proposed changes introduce or materially affect,
 *  3. a stable mapping from positions inside the text we send the model back
 *     to real file line numbers, so findings can later be anchored on the PR.
 *
 * Everything here is pure string work: no network, no git, no side effects.
 */

/** Paths whose churn is noise for review purposes (lockfiles, bundles, media). */
const GENERATED_PATH_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /\.(min|bundle)\.[cm]?js$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tar|woff2?|ttf|eot)$/,
];

/**
 * True when a path is a lockfile, minified bundle or binary asset that
 * should never be sent to the model.
 * @param {string} file
 * @returns {boolean}
 */
export function isGeneratedPath(file) {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(String(file ?? '')));
}

const LANGUAGE_BY_EXTENSION = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', kt: 'kotlin', swift: 'swift',
  md: 'markdown', graphql: 'graphql', proto: 'protobuf',
};

/**
 * Best-effort language hint for the prompt from a file extension.
 * @param {string} file
 * @returns {string | undefined}
 */
export function detectLanguage(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file ?? ''));
  return m ? LANGUAGE_BY_EXTENSION[m[1].toLowerCase()] : undefined;
}

/** Normalize a `---`/`+++`/git-header path: strip quotes, a/ b/ prefixes, /dev/null. */
function cleanPath(raw) {
  if (!raw) return null;
  let p = String(raw).trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into per-file entries.
 *
 * @param {string} diffText - raw bytes from the PR diff endpoint
 * @returns {Array<{
 *   file: string | null,
 *   oldFile: string | null,
 *   isNew: boolean,
 *   isDeleted: boolean,
 *   isBinary: boolean,
 *   addedLines: number,
 *   hunks: Array<{ oldStart: number, oldCount: number, newStart: number, newCount: number, header: string,
 *     lines: Array<{ type: 'context' | 'added' | 'removed', text: string, newLine?: number, oldLine?: number }> }>
 * }>}
 */
export function parseDiff(diffText) {
  const files = [];
  const lines = String(diffText ?? '').split(/\r?\n/);
  let current = null;
  let hunk = null;
  let newLine = 0;
  let oldLine = 0;

  const flush = () => {
    if (current) {
      current.addedLines = current.hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.type === 'added').length,
        0
      );
      files.push(current);
    }
    current = null;
    hunk = null;
  };

  const startFile = (gitPath) => {
    flush();
    current = {
      file: gitPath ?? null,
      oldFile: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      addedLines: 0,
      hunks: [],
    };
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      // "diff --git a/<path> b/<path>" — prefer the b/ side as the file path;
      // `+++ b/...` below refines it when present (renames, deletions).
      const parts = line.slice('diff --git '.length).split(' ');
      startFile(cleanPath(parts[1]));
      continue;
    }

    if (!current) {
      // Tolerate headers that start directly with ---/+++ (no git header).
      if (line.startsWith('+++ ')) startFile(null);
      else continue;
    }

    if (line.startsWith('new file mode')) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      continue;
    }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      current.oldFile = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = cleanPath(line.slice(4));
      if (p) current.file = p;
      continue;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      oldLine = Number(hm[1]);
      newLine = Number(hm[3]);
      hunk = {
        oldStart: oldLine,
        oldCount: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: newLine,
        newCount: hm[4] === undefined ? 1 : Number(hm[4]),
        header: line,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      if (line === '\\ No newline at end of file') continue;
      const tag = line[0];
      if (tag === ' ') {
        hunk.lines.push({ type: 'context', text: line.slice(1), newLine, oldLine });
        newLine += 1;
        oldLine += 1;
      } else if (tag === '+') {
        hunk.lines.push({ type: 'added', text: line.slice(1), newLine });
        newLine += 1;
      } else if (tag === '-') {
        hunk.lines.push({ type: 'removed', text: line.slice(1), oldLine });
        oldLine += 1;
      } else {
        // Any other line — metadata (index/mode), the trailing empty string
        // from split, or the next file header — ends the hunk body. Blank
        // context lines inside a hunk always arrive as a single space.
        // Any other line (index/mode/next file header...) ends the hunk body.
        hunk = null;
      }
    }
  }
  flush();
  return files;
}

/**
 * Build the text chunk to send the model for one file: every hunk line that
 * survives into the new file (context + added), concatenated in order, with a
 * parallel `lineMap` where `lineMap[i]` is the real new-file line number of
 * chunk line `i` (1-based positions in `code` are `i + 1`).
 *
 * Removed lines are excluded: findings must anchor on lines that exist in the
 * new file. Truncation happens at a line boundary so the map stays aligned.
 *
 * @param {ReturnType<typeof parseDiff>[number]} fileEntry
 * @param {number} [maxChars] - hard cap on `code.length` (the first line is always kept)
 * @returns {{ code: string, lineMap: number[], truncated: boolean } | null}
 */
export function buildReviewChunk(fileEntry, maxChars) {
  const texts = [];
  const lineMap = [];
  let total = 0;
  let truncated = false;

  outer: for (const hunk of fileEntry.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.type === 'removed') continue;
      const sep = texts.length > 0 ? 1 : 0; // joining newline
      const next = total + sep + line.text.length;
      if (maxChars != null && texts.length > 0 && next > maxChars) {
        truncated = true;
        break outer;
      }
      texts.push(line.text);
      lineMap.push(line.newLine);
      total = next;
    }
  }

  if (texts.length === 0) return null;
  return { code: texts.join('\n'), lineMap, truncated };
}
