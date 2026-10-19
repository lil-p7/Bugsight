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
}/**
 * Review a piece of code and return structured, validated findings.
 *
 * When no API key is configured, returns a mock response with synthetic findings.
 * This allows the full pipeline to run without an OpenAI credit account.
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

  // If client and model are both provided, use them directly.
  // Otherwise, try config, and fall back to mock mode if no API key.
  if (!resolvedClient || !resolvedModel) {
    let config;
    try {
      config = getOpenAIConfig();
    } catch (err) {
      // Mock mode: no API key configured → return synthetic findings
      const lineCount = countLines(code);
      const syntheticFindings = [
        {
          title: 'Code review placeholder',
          category: 'style',
          severity: 'low',
          confidence: 0.5,
          file: filePath || 'unknown',
          line: 1,
          explanation: 'Review would run against OpenAI model. Add OPENAI_API_KEY for real findings.',
          suggestion: 'Configure OpenAI credentials to enable real reviews.',
        },
      ];
      const validFindings = syntheticFindings.filter((f) => isLineInBounds(f.line, lineCount));
      return {
        findings: validFindings,
        rejected: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    resolvedClient ??= new OpenAI({ apiKey: config.apiKey });
    resolvedModel ??= config.model;
  }


  const openAiClient = resolvedClient;
  const openAiModel = resolvedModel;

  const response = await openAiClient.chat.completions.create({
    model: openAiModel,
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
