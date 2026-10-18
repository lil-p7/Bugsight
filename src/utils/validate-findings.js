/**
 *_structured validation of model output.
 *
 * The model is untrusted: every finding is checked against a schema before
 * anything can be published to GitHub. Invalid findings are rejected with a
 * reason instead of being silently coerced.
 */
import { z } from 'zod';

import { CATEGORIES, SEVERITIES } from '../prompts/code-review.prompt.js';

export const findingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  confidence: z.number().gte(0).lte(1),
  file: z.string().trim().min(1),
  line: z.number().int().min(1).nullable(),
  explanation: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
});

/** Envelope the model must return: { findings: [...] }. */
export const findingsEnvelopeSchema = z.object({
  findings: z.array(z.unknown()),
});

/** A finding rejected during validation, with a machine-readable reason. */
export const rejectedFindingSchema = z.object({
  reason: z.string(),
  value: z.unknown(),
});

/**
 * Validate an array of raw (untrusted) findings.
 *
 * @param {unknown} rawFindings - value of the envelope's `findings` property
 * @returns {{ valid: z.infer<typeof findingSchema>[], rejected: {reason: string, value: unknown}[] }}
 */
export function validateFindings(rawFindings) {
  const valid = [];
  const rejected = [];
  for (const value of Array.isArray(rawFindings) ? rawFindings : []) {
    const result = findingSchema.safeParse(value);
    if (result.success) {
      valid.push(result.data);
    } else {
      rejected.push({
        reason: result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        value,
      });
    }
  }
  return { valid, rejected };
}

/**
 * Parse the model's JSON text into a validated envelope.
 * Throws on malformed JSON or a wrong top-level shape.
 *
 * @param {string} content
 * @returns {{ findings: unknown[] }}
 * @throws {Error} code: MODEL_OUTPUT_INVALID
 */
export function parseModelContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const error = new Error(`Model returned invalid JSON: ${err.message}`);
    error.code = 'MODEL_OUTPUT_INVALID';
    throw error;
  }
  const envelope = findingsEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    const error = new Error(
      `Model output is not a valid findings envelope: ${envelope.error.issues
        .map((i) => i.path.join('.') || '(root)')
        .join(', ')}`
    );
    error.code = 'MODEL_OUTPUT_INVALID';
    throw error;
  }
  return envelope.data;
}

/**
 * True when a line number can exist in code with `lineCount` lines.
 * `null` (file-level finding) is always acceptable.
 *
 * @param {number | null} line
 * @param {number} lineCount
 */
export function isLineInBounds(line, lineCount) {
  if (line === null) return true;
  return Number.isInteger(line) && line >= 1 && line <= lineCount;
}