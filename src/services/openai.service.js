/**
 * The AI review engine: sends code to OpenAI and returns validated findings.
 *
 * The client is injectable so tests can run the whole pipeline (prompt ->
 * model response -> parse -> validate -> line check) without a real API key.
 */
import OpenAI from 'openai';

import { getOpenAIConfig } from '../config/env.js';
import { buildMessages } from '../prompts/code-review.prompt.js';
import {
  isLineInBounds,
  parseModelContent,
  validateFindings,
} from '../utils/validate-findings.js';

export const REVIEW_TEMPERATURE = 0.1;

/** Thrown when the model response cannot be turned into usable findings. */
export class ReviewOutputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ReviewOutputError';
    this.code = 'REVIEW_OUTPUT_INVALID';
    this.details = details;
  }
}

function countLines(code) {
  return code.split(/\r?\n/).length;
}

/**
 * Review a piece of code and return structured, validated findings.
 *
 * @param {object} params
 * @param {string} params.code - code (or single-file diff) to review
 * @param {string} [params.language]
 * @param {string} [params.filePath]
 * @param {string} [params.context]
 * @param {import('openai').OpenAI} [params.client] - injected in tests
 * @param {string} [params.model]
 * @returns {Promise<{
 *   findings: Array<object>,
 *   rejected: Array<{reason: string, value: unknown}>,
 *   usage: {prompt_tokens?: number, completion_tokens?: number, total_tokens?: number} | null
 * }>}
 * @throws {ReviewOutputError} when the model response is malformed
 */
export async function reviewCode({
  code,
  language,
  filePath,
  context,
  client,
  model,
}) {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ReviewOutputError('reviewCode requires a non-empty code string');
  }

  let resolvedClient = client;
  let resolvedModel = model;
  if (!resolvedClient || !resolvedModel) {
    const config = getOpenAIConfig();
    resolvedClient ??= new OpenAI({ apiKey: config.apiKey });
    resolvedModel ??= config.model;
  }

  const response = await resolvedClient.chat.completions.create({
    model: resolvedModel,
    temperature: REVIEW_TEMPERATURE,
    response_format: { type: 'json_object' },
    messages: buildMessages({ code, language, filePath, context }),
  });

  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ReviewOutputError('Model response contained no content');
  }

  let envelope;
  try {
    envelope = parseModelContent(content);
  } catch (err) {
    throw new ReviewOutputError(err.message, { raw: content });
  }

  const { valid, rejected } = validateFindings(envelope.findings);

  // The model must point at lines that exist in the reviewed code.
  const lineCount = countLines(code);
  const findings = [];
  for (const finding of valid) {
    if (isLineInBounds(finding.line, lineCount)) {
      findings.push(finding);
    } else {
      rejected.push({
        reason: `line ${finding.line} is out of bounds (code has ${lineCount} lines)`,
        value: finding,
      });
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      b.confidence - a.confidence
  );

  return {
    findings,
    rejected,
    usage: response?.usage ?? null,
  };
}

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };