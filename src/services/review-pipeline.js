/**
 * Phase 3 review pipeline: raw PR diff -> filtered, budgeted file chunks ->
 * model -> validated findings anchored on real file lines.
 *
 * This is everything between "webhook received a reviewable pull_request"
 * and "findings Phase 4 can publish":
 *  - parse the diff and drop what must never be reviewed (binary files,
 *    deletions, lockfiles/generated bundles, files with no new lines),
 *  - enforce MAX_FILES_PER_REVIEW (most-changed files first) and the
 *    MAX_REVIEW_CHARS budget, truncating at line boundaries,
 *  - call reviewCode() per file with retry on rate limits / transient
 *    upstream failures (429, 5xx),
 *  - translate patch-relative finding lines to real new-file line numbers
 *    and pin `file` to the path actually reviewed,
 *  - isolate per-file failures so one bad model response or missing env var
 *    cannot sink the whole review.
 */
import { DEFAULT_MAX_FILES_PER_REVIEW, DEFAULT_MAX_REVIEW_CHARS } from '../config/env.js';

import { reviewCode } from './openai.service.js';
import {
  buildReviewChunk,
  detectLanguage,
  isGeneratedPath,
  parseDiff,
} from '../utils/diff-parser.js';

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

/** Default retry policy for transient failures (rate limits, 5xx). */
export const DEFAULT_RETRY = { retries: 2, baseDelayMs: 500, maxDelayMs: 5000 };

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry only where a retry can help: rate limits and transient server errors.
 * Deterministic failures (bad model output, 4xx permissions, config errors)
 * are thrown through immediately.
 * @param {any} err
 * @returns {boolean}
 */
export function isRetryableError(err) {
  // Quota/billing 429s never heal on retry — only rate limits and transient
  // server errors do. Shapes observed against the live API:
  //   { status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota' }
  //   { status: 429, code: 'insufficient_quota' }
  const code = err?.code ?? err?.error?.code;
  const type = err?.type ?? err?.error?.type;
  if (
    code === 'insufficient_quota' ||
    code === 'credit_balance_exhausted' ||
    type === 'insufficient_quota'
  ) {
    return false;
  }
  const status = err?.status ?? err?.details?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/**
 * Run `fn`, retrying with capped exponential backoff while `shouldRetry`.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number,
 *           sleep?: (ms: number) => Promise<void>, shouldRetry?: (err: any) => boolean }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    retries = DEFAULT_RETRY.retries,
    baseDelayMs = DEFAULT_RETRY.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY.maxDelayMs,
    sleep = defaultSleep,
    shouldRetry = isRetryableError,
  } = options;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      attempt += 1;
      await sleep(delay);
    }
  }
}

/**
 * @param {object} params
 * @param {string} params.diff - raw unified diff from the PR diff endpoint
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.pullNumber
 * @param {string} [params.title] - PR title, added to the review context
 * @param {import('openai').OpenAI} [params.client] - injected in tests
 * @param {string} [params.model]
 * @param {{ maxReviewChars?: number, maxFilesPerReview?: number }} [params.limits]
 * @param {object} [params.retry] - withRetry options (injectable sleep in tests)
 * @param {(args: object) => Promise<object>} [params.reviewFn] - injectable seam; defaults to reviewCode
 * @param {{ error?: Function }} [params.logger]
 * @returns {Promise<{
 *   findings: Array<object>,
 *   rejected: Array<object>,
 *   perFile: Array<object>,
 *   skipped: Array<{ file: string, reason: string }>,
 *   usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number } | null,
 *   stats: { filesInDiff: number, candidates: number, selected: number, reviewed: number, failed: number, skipped: number },
 * }>}
 * @throws {TypeError} when diff is missing or empty
 */
export async function runReviewPipeline({
  diff,
  owner,
  repo,
  pullNumber,
  title,
  client,
  model,
  limits = {},
  retry = {},
  reviewFn = reviewCode,
  logger = console,
}) {
  if (typeof diff !== 'string' || diff.trim() === '') {
    throw new TypeError('runReviewPipeline requires the raw PR diff text');
  }

  const maxReviewChars = limits.maxReviewChars ?? DEFAULT_MAX_REVIEW_CHARS;
  const maxFilesPerReview = limits.maxFilesPerReview ?? DEFAULT_MAX_FILES_PER_REVIEW;

  const files = parseDiff(diff);
  const skipped = [];
  const candidates = [];
  for (const entry of files) {
    if (!entry.file) skipped.push({ file: '<unparsed>', reason: 'no file path in diff' });
    else if (entry.isBinary) skipped.push({ file: entry.file, reason: 'binary file' });
    else if (entry.isDeleted) skipped.push({ file: entry.file, reason: 'deleted file' });
    else if (entry.addedLines === 0) skipped.push({ file: entry.file, reason: 'no added lines' });
    else if (isGeneratedPath(entry.file)) skipped.push({ file: entry.file, reason: 'generated or lockfile' });
    else candidates.push(entry);
  }

  candidates.sort((a, b) => b.addedLines - a.addedLines || a.file.localeCompare(b.file));
  const selected = candidates.slice(0, maxFilesPerReview);
  for (const entry of candidates.slice(maxFilesPerReview)) {
    skipped.push({ file: entry.file, reason: 'max_files_per_review' });
  }

  const context =
    `Pull request #${pullNumber} in ${owner}/${repo}` +
    (title ? `: "${title}"` : '') +
    '. Only report issues introduced by or materially affected by these changes.';

  const findings = [];
  const rejected = [];
  const perFile = [];
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let usageSeen = false;
  let budget = maxReviewChars;

  for (let i = 0; i < selected.length; i += 1) {
    const entry = selected[i];
    if (budget <= 0) {
      skipped.push({ file: entry.file, reason: 'max_review_chars' });
      continue;
    }
    const chunk = buildReviewChunk(entry, budget);
    if (!chunk) {
      skipped.push({ file: entry.file, reason: 'max_review_chars' });
      continue;
    }
    budget -= chunk.code.length;

    try {
      const result = await withRetry(
        () =>
          reviewFn({
            code: chunk.code,
            language: detectLanguage(entry.file),
            filePath: entry.file,
            context,
            client,
            model,
          }),
        retry
      );

      // Anchor findings on the file and real line numbers that were reviewed:
      // the model only ever sees chunk-relative positions.
      const translated = result.findings.map((finding) => ({
        ...finding,
        file: entry.file,
        line: finding.line === null ? null : chunk.lineMap[finding.line - 1] ?? null,
      }));

      findings.push(...translated);
      rejected.push(...result.rejected);
      if (result.usage) {
        usageSeen = true;
        usageTotals.prompt_tokens += result.usage.prompt_tokens ?? 0;
        usageTotals.completion_tokens += result.usage.completion_tokens ?? 0;
        usageTotals.total_tokens += result.usage.total_tokens ?? 0;
      }
      perFile.push({
        file: entry.file,
        findings: translated,
        rejected: result.rejected,
        usage: result.usage ?? null,
        truncated: chunk.truncated,
      });
    } catch (err) {
      perFile.push({
        file: entry.file,
        findings: [],
        rejected: [],
        usage: null,
        truncated: chunk.truncated,
        error: { code: err?.code ?? err?.name ?? 'Error', message: err?.message ?? String(err) },
      });
      logger.error?.(`[review] ${entry.file} failed: ${err?.stack ?? err}`);
      if (err?.code === 'ENV_CONFIG_ERROR') {
        // The environment itself is broken; every remaining file would fail
        // the same way before ever reaching the network.
        for (const rest of selected.slice(i + 1)) {
          skipped.push({ file: rest.file, reason: 'env_config_error' });
        }
        break;
      }
    }
  }

  findings.sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence
  );

  return {
    findings,
    rejected,
    perFile,
    skipped,
    usage: usageSeen ? usageTotals : null,
    stats: {
      filesInDiff: files.length,
      candidates: candidates.length,
      selected: selected.length,
      reviewed: perFile.filter((f) => !f.error).length,
      failed: perFile.filter((f) => f.error).length,
      skipped: skipped.length,
    },
  };
}
