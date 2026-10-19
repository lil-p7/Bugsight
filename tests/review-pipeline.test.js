import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RETRY,
  isRetryableError,
  runReviewPipeline,
  withRetry,
} from '../src/services/review-pipeline.js';

/** OpenAI-compatible fake: records requests, returns canned content per call. */
function fakeClient(contents, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  const calls = [];
  const queue = Array.isArray(contents) ? [...contents] : [contents];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          const content = queue.length > 1 ? queue.shift() : queue[0];
          return { choices: [{ message: { content } }], usage };
        },
      },
    },
  };
}

/** Client that throws `failures` times with a status before succeeding. */
function flakyClient(failures, content) {
  const calls = [];
  let n = 0;
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          if (n++ < failures) throw { status: 429, message: 'rate limited' };
          return { choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  };
}

function finding(overrides = {}) {
  return {
    title: 'Unchecked division',
    category: 'bug',
    severity: 'medium',
    confidence: 0.9,
    file: 'src/x.js',
    line: 1,
    explanation: 'The denominator can be zero at this line.',
    suggestion: 'Guard against a zero denominator before dividing.',
    ...overrides,
  };
}

const EMPTY = JSON.stringify({ findings: [] });

/** Modified + new + deleted + binary + lockfile + deletions-only, all in one diff. */
const MIXED_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = a / 0;',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,1 @@',
  '+hello',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,1 +1,2 @@',
  ' {"x":1}',
  '+{"y":2}',
  'diff --git a/only-removals.js b/only-removals.js',
  '--- a/only-removals.js',
  '+++ b/only-removals.js',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  '',
].join('\n');

describe('runReviewPipeline — filtering', () => {
  it('reviews only reviewable files and reports every skip reason', async () => {
    const client = fakeClient(EMPTY);
    const result = await runReviewPipeline({
      diff: MIXED_DIFF,
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 12,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 60000, maxFilesPerReview: 30 },
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });

    assert.equal(client.calls.length, 2); // src/app.js + new.txt only
    assert.deepEqual(
      result.skipped.map((s) => s.reason).sort(),
      ['binary file', 'deleted file', 'generated or lockfile', 'no added lines']
    );
    assert.equal(result.stats.filesInDiff, 6);
    assert.equal(result.stats.candidates, 2);
    assert.equal(result.stats.reviewed, 2);
    assert.equal(result.stats.failed, 0);
    assert.deepEqual(result.findings, []);
  });

  it('sends language, file path and PR context with each review', async () => {
    const client = fakeClient(EMPTY);
    await runReviewPipeline({
      diff: MIXED_DIFF,
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 12,
      title: 'Add thing',
      client,
      model: 'test-model',
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    const sent = client.calls.map((c) => c.messages[1].content).join('\n');
    assert.match(sent, /src\/app\.js/);
    assert.match(sent, /javascript/);
    assert.match(sent, /Pull request #12 in acme\/widgets: "Add thing"/);
  });
});

describe('runReviewPipeline — limits', () => {
  const TWO_FILES = [
    'diff --git a/src/big.js b/src/big.js',
    '--- a/src/big.js',
    '+++ b/src/big.js',
    '@@ -1,1 +1,3 @@',
    ' const x = 1;',
    '+const y = 2;',
    '+const z = 3;',
    'diff --git a/src/small.js b/src/small.js',
    '--- a/src/small.js',
    '+++ b/src/small.js',
    '@@ -1,1 +1,2 @@',
    ' const s = 1;',
    '+const t = 2;',
    '',
  ].join('\n');

  it('keeps only the top MAX_FILES_PER_REVIEW files by added lines', async () => {
    const client = fakeClient(EMPTY);
    const result = await runReviewPipeline({
      diff: TWO_FILES,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 60000, maxFilesPerReview: 1 },
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[1].content, /src\/big\.js/);
    assert.deepEqual(result.skipped, [{ file: 'src/small.js', reason: 'max_files_per_review' }]);
    assert.equal(result.stats.selected, 1);
  });

  it('truncates a file at the line boundary when it exceeds MAX_REVIEW_CHARS', async () => {
    const diff = [
      'diff --git a/src/lines.js b/src/lines.js',
      '--- a/src/lines.js',
      '+++ b/src/lines.js',
      '@@ -0,0 +1,3 @@',
      '+' + 'a'.repeat(15),
      '+' + 'b'.repeat(15),
      '+' + 'c'.repeat(15),
      '',
    ].join('\n');
    const client = fakeClient(EMPTY);
    const result = await runReviewPipeline({
      diff,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 20, maxFilesPerReview: 30 },
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    const sent = client.calls[0].messages[1].content;
    assert.ok(!sent.includes('c'.repeat(15)), 'third line must not be sent');
    assert.ok(sent.includes('a'.repeat(15)));
    assert.ok(!sent.includes('b'.repeat(15)), 'second line must be cut at the boundary');
    assert.equal(result.perFile[0].truncated, true);
    assert.ok(result.perFile[0].findings !== undefined);
  });

  it('stops reviewing once the shared char budget is exhausted', async () => {
    // Budget math: file one = 41 chars (20+1+20) -> 9 left;
    // file three keeps its first line (first line is never dropped) -> budget
    // goes negative; file two is skipped outright.
    const diff = [
      'diff --git a/src/one.js b/src/one.js',
      '--- a/src/one.js',
      '+++ b/src/one.js',
      '@@ -0,0 +1,2 @@',
      '+' + 'a'.repeat(20),
      '+' + 'b'.repeat(20),
      'diff --git a/src/three.js b/src/three.js',
      '--- a/src/three.js',
      '+++ b/src/three.js',
      '@@ -0,0 +1,1 @@',
      '+' + 'd'.repeat(20),
      'diff --git a/src/two.js b/src/two.js',
      '--- a/src/two.js',
      '+++ b/src/two.js',
      '@@ -0,0 +1,1 @@',
      '+' + 'c'.repeat(30),
      '',
    ].join('\n');
    const client = fakeClient(EMPTY);
    const result = await runReviewPipeline({
      diff,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 50, maxFilesPerReview: 30 },
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.deepEqual(
      result.perFile.map((f) => f.file),
      ['src/one.js', 'src/three.js']
    );
    assert.deepEqual(result.skipped, [{ file: 'src/two.js', reason: 'max_review_chars' }]);
  });
});

describe('runReviewPipeline — findings', () => {
  const TWO_HUNK_DIFF = [
    'diff --git a/src/two-hunk.js b/src/two-hunk.js',
    '--- a/src/two-hunk.js',
    '+++ b/src/two-hunk.js',
    '@@ -1,2 +1,2 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '@@ -40,1 +40,2 @@',
    ' const z = 40;',
    '+const y = 41;',
    '',
  ].join('\n');

  it('translates chunk-relative lines to real file lines and pins the file path', async () => {
    const content = JSON.stringify({
      findings: [finding({ line: 3, file: 'WRONG.js', severity: 'high' })],
    });
    const client = fakeClient(content);
    const result = await runReviewPipeline({
      diff: TWO_HUNK_DIFF,
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      client,
      model: 'test-model',
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.equal(result.findings.length, 1);
    // Chunk position 3 is `const z = 40;` — real file line 40 (hunk gap).
    assert.equal(result.findings[0].line, 40);
    assert.equal(result.findings[0].file, 'src/two-hunk.js');
  });

  it('sorts findings by severity across files, not just within one', async () => {
    const lowFirst = JSON.stringify({ findings: [finding({ title: 'Low', severity: 'low' })] });
    const criticalSecond = JSON.stringify({ findings: [finding({ title: 'Crit', severity: 'critical' })] });
    const client = fakeClient([lowFirst, criticalSecond]);
    const twoFiles = [
      'diff --git a/src/aaa.js b/src/aaa.js',
      '--- a/src/aaa.js',
      '+++ b/src/aaa.js',
      '@@ -0,0 +1,1 @@',
      '+const aaa = 1;',
      'diff --git a/src/bbb.js b/src/bbb.js',
      '--- a/src/bbb.js',
      '+++ b/src/bbb.js',
      '@@ -0,0 +1,1 @@',
      '+const bbb = 1;',
      '',
    ].join('\n');
    const result = await runReviewPipeline({
      diff: twoFiles,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.deepEqual(result.findings.map((f) => f.title), ['Crit', 'Low']);
  });

  it('aggregates token usage across files', async () => {
    const client = fakeClient(EMPTY, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    const result = await runReviewPipeline({
      diff: TWO_HUNK_DIFF,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });
});

describe('runReviewPipeline — errors and rate limits', () => {
  const TWO_FILES = [
    'diff --git a/src/one.js b/src/one.js',
    '--- a/src/one.js',
    '+++ b/src/one.js',
    '@@ -0,0 +1,1 @@',
    '+const one = 1;',
    'diff --git a/src/two.js b/src/two.js',
    '--- a/src/two.js',
    '+++ b/src/two.js',
    '@@ -0,0 +1,1 @@',
    '+const two = 2;',
    '',
  ].join('\n');

  it('isolates a per-file model failure and still reviews the rest', async () => {
    const malformed = '{"findings": [ oops';
    const good = JSON.stringify({ findings: [finding({ title: 'Found', severity: 'low' })] });
    const client = fakeClient([malformed, good]);
    const errors = [];
    const result = await runReviewPipeline({
      diff: TWO_FILES,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      retry: { sleep: async () => {} },
      logger: { error: (msg) => errors.push(msg) },
    });
    assert.equal(result.stats.failed, 1);
    assert.equal(result.stats.reviewed, 1);
    assert.equal(result.perFile[0].error.code, 'REVIEW_OUTPUT_INVALID');
    assert.equal(result.perFile[1].error, undefined);
    assert.deepEqual(result.findings.map((f) => f.title), ['Found']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /src\/one\.js/);
  });

  it('retries rate limits with capped exponential backoff, then succeeds', async () => {
    const client = flakyClient(2, EMPTY);
    const sleeps = [];
    const result = await runReviewPipeline({
      diff: TWO_FILES,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 60000, maxFilesPerReview: 1 },
      retry: { retries: 2, baseDelayMs: 10, maxDelayMs: 1000, sleep: async (ms) => sleeps.push(ms) },
      logger: { error: () => {} },
    });
    assert.deepEqual(sleeps, [10, 20]);
    assert.equal(result.stats.reviewed, 1);
    assert.equal(result.stats.failed, 0);
  });

  it('gives up after retries are exhausted and records the error', async () => {
    const client = flakyClient(99, EMPTY);
    const result = await runReviewPipeline({
      diff: TWO_FILES,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      client,
      model: 'test-model',
      limits: { maxReviewChars: 60000, maxFilesPerReview: 1 },
      retry: { retries: 1, baseDelayMs: 1, sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.equal(result.stats.failed, 1);
    assert.equal(result.perFile[0].error.message, 'rate limited');
    assert.equal(client.calls.length, 2); // initial attempt + 1 retry
  });

  it('aborts remaining files when the environment itself is broken', async () => {
    let calls = 0;
    const reviewFn = async () => {
      calls += 1;
      const err = new Error('OPENAI_API_KEY is not set.');
      err.code = 'ENV_CONFIG_ERROR';
      throw err;
    };
    const result = await runReviewPipeline({
      diff: TWO_FILES,
      owner: 'a',
      repo: 'b',
      pullNumber: 1,
      reviewFn,
      retry: { sleep: async () => {} },
      logger: { error: () => {} },
    });
    assert.equal(calls, 1);
    assert.equal(result.stats.failed, 1);
    assert.deepEqual(
      result.skipped.filter((s) => s.reason === 'env_config_error').map((s) => s.file),
      ['src/two.js']
    );
  });

  it('rejects a missing or empty diff before doing anything', async () => {
    await assert.rejects(() => runReviewPipeline({ diff: '', owner: 'a', repo: 'b', pullNumber: 1 }), TypeError);
    await assert.rejects(() => runReviewPipeline({ owner: 'a', repo: 'b', pullNumber: 1 }), TypeError);
  });
});

describe('withRetry / isRetryableError', () => {
  it('classifies rate limits and 5xx as retryable, everything else as not', () => {
    assert.equal(isRetryableError({ status: 429 }), true);
    assert.equal(isRetryableError({ status: 500 }), true);
    assert.equal(isRetryableError({ status: 503 }), true);
    assert.equal(isRetryableError({ status: 429, code: 'insufficient_quota' }), false);
    // Exact shape observed from the live API when the account has no credits:
    assert.equal(
      isRetryableError({ status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota' }),
      false
    );
    assert.equal(
      isRetryableError({ status: 429, error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' } }),
      false
    );
    assert.equal(isRetryableError({ details: { status: 429 } }), true);
    assert.equal(isRetryableError({ status: 403 }), false);
    assert.equal(isRetryableError({ status: 404 }), false);
    assert.equal(isRetryableError({ code: 'REVIEW_OUTPUT_INVALID' }), false);
    assert.equal(isRetryableError(new Error('network')), false);
  });

  it('does not retry when retries are exhausted or the error is deterministic', async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            n += 1;
            throw { status: 429 };
          },
          { retries: 2, sleep: async () => {} }
        ),
        (err) => err.status === 429
    );
    assert.equal(n, 3); // initial + 2 retries

    n = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            n += 1;
            throw Object.assign(new Error('bad output'), { code: 'REVIEW_OUTPUT_INVALID' });
          },
          { retries: 5, sleep: async () => {} }
        )
    );
    assert.equal(n, 1); // deterministic: no retries
  });

  it('exposes a sane default retry policy', () => {
    assert.deepEqual(DEFAULT_RETRY, { retries: 2, baseDelayMs: 500, maxDelayMs: 5000 });
  });
});
