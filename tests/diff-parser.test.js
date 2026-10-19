import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReviewChunk,
  detectLanguage,
  isGeneratedPath,
  parseDiff,
} from '../src/utils/diff-parser.js';

const FIXTURE = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = a / b;',
  ' const d = 4;',
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone',
  'diff --git a/img.png b/img.png',
  'index 5555555..6666666 100644',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

describe('parseDiff', () => {
  it('splits a multi-file diff and reports statuses', () => {
    const files = parseDiff(FIXTURE);
    assert.equal(files.length, 4);

    const [app, notes, old, img] = files;
    assert.equal(app.file, 'src/app.js');
    assert.equal(app.isNew, false);
    assert.equal(app.isDeleted, false);
    assert.equal(app.isBinary, false);
    assert.equal(app.addedLines, 2);

    assert.equal(notes.file, 'notes.txt');
    assert.equal(notes.isNew, true);
    assert.equal(notes.oldFile, null);
    assert.equal(notes.addedLines, 2);

    assert.equal(old.file, 'old.js');
    assert.equal(old.isDeleted, true);
    assert.equal(old.addedLines, 0);

    assert.equal(img.file, 'img.png');
    assert.equal(img.isBinary, true);
    assert.equal(img.hunks.length, 0);
  });

  it('tracks new-file line numbers across context, added and removed lines', () => {
    const [app] = parseDiff(FIXTURE);
    const lines = app.hunks[0].lines;

    // Removed lines must not consume new-file line numbers.
    assert.deepEqual(
      lines.map((l) => [l.type, l.newLine ?? null]),
      [
        ['context', 1],
        ['removed', null],
        ['added', 2],
        ['added', 3],
        ['context', 4],
      ]
    );
    assert.equal(lines[1].oldLine, 2);
  });

  it('parses hunks that start at line 0 of a new file', () => {
    const [, notes] = parseDiff(FIXTURE);
    assert.equal(notes.hunks[0].newStart, 1);
    assert.deepEqual(notes.hunks[0].lines.map((l) => l.newLine), [1, 2]);
  });

  it('returns an empty list for an empty diff', () => {
    assert.deepEqual(parseDiff(''), []);
    assert.deepEqual(parseDiff(null), []);
  });

  it('handles CRLF line endings', () => {
    const files = parseDiff(FIXTURE.replace(/\n/g, '\r\n'));
    assert.equal(files.length, 4);
    assert.equal(files[0].addedLines, 2);
    assert.equal(files[1].isNew, true);
  });

  it('ends a hunk cleanly on metadata lines such as "index ..."', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      'index aaa..bbb 100644',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,1 +1,1 @@',
      '-old;',
      '+new;',
      'diff --git a/y.js b/y.js',
      'index ccc..ddd 100644',
      '--- a/y.js',
      '+++ b/y.js',
      '@@ -1,1 +1,1 @@',
      '+other;',
      '',
    ].join('\n');
    const files = parseDiff(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0].addedLines, 1);
    assert.equal(files[1].addedLines, 1);
    assert.equal(files[1].file, 'y.js');
  });
});

describe('buildReviewChunk', () => {
  it('excludes removed lines and maps positions to real file lines', () => {
    const [app] = parseDiff(FIXTURE);
    const chunk = buildReviewChunk(app);
    assert.equal(chunk.code, ['const a = 1;', 'const b = 3;', 'const c = a / b;', 'const d = 4;'].join('\n'));
    assert.deepEqual(chunk.lineMap, [1, 2, 3, 4]);
    assert.equal(chunk.truncated, false);
  });

  it('truncates at a line boundary and keeps the map aligned', () => {
    const [app] = parseDiff(FIXTURE);
    // Line 1 is 12 chars; adding line 2 (1 + 12) exceeds 20.
    const chunk = buildReviewChunk(app, 20);
    assert.equal(chunk.code, 'const a = 1;');
    assert.deepEqual(chunk.lineMap, [1]);
    assert.equal(chunk.truncated, true);
    assert.ok(chunk.code.length <= 20);
  });

  it('returns null when there is nothing new to review', () => {
    const files = parseDiff(FIXTURE);
    assert.equal(buildReviewChunk(files[2]), null); // deleted file, only removed lines
    assert.equal(buildReviewChunk(files[3]), null); // binary, no hunks
  });

  it('keeps a single oversized first line rather than returning nothing', () => {
    const diff = [
      'diff --git a/big.js b/big.js',
      '--- a/big.js',
      '+++ b/big.js',
      '@@ -0,0 +1,1 @@',
      '+' + 'x'.repeat(500),
      '',
    ].join('\n');
    const [big] = parseDiff(diff);
    const chunk = buildReviewChunk(big, 10);
    assert.equal(chunk.code.length, 500);
    assert.deepEqual(chunk.lineMap, [1]);
    assert.equal(chunk.truncated, false);
  });
});

describe('isGeneratedPath', () => {
  it('flags lockfiles, bundles and binary assets', () => {
    assert.equal(isGeneratedPath('package-lock.json'), true);
    assert.equal(isGeneratedPath('frontend/yarn.lock'), true);
    assert.equal(isGeneratedPath('pnpm-lock.yaml'), true);
    assert.equal(isGeneratedPath('assets/app.min.js'), true);
    assert.equal(isGeneratedPath('assets/app.js.map'), true);
    assert.equal(isGeneratedPath('img/logo.png'), true);
  });

  it('leaves ordinary source paths alone', () => {
    assert.equal(isGeneratedPath('src/app.js'), false);
    assert.equal(isGeneratedPath('package.json'), false);
    assert.equal(isGeneratedPath('src/utils/diff-parser.js'), false);
  });
});

describe('detectLanguage', () => {
  it('maps common extensions to prompt language hints', () => {
    assert.equal(detectLanguage('src/app.js'), 'javascript');
    assert.equal(detectLanguage('src/app.tsx'), 'typescript');
    assert.equal(detectLanguage('main.py'), 'python');
    assert.equal(detectLanguage('cmd/server.go'), 'go');
    assert.equal(detectLanguage('README.md'), 'markdown');
  });

  it('returns undefined for unknown or missing extensions', () => {
    assert.equal(detectLanguage('Makefile'), undefined);
    assert.equal(detectLanguage('weird.qqq'), undefined);
    assert.equal(detectLanguage(''), undefined);
  });
});
