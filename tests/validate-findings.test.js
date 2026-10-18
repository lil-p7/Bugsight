import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findingsEnvelopeSchema,
  findingSchema,
  isLineInBounds,
  parseModelContent,
  validateFindings,
} from '../src/utils/validate-findings.js';

const validFinding = {
  title: 'Handle failed database requests',
  category: 'bug',
  severity: 'medium',
  confidence: 0.94,
  file: 'src/users.js',
  line: 24,
  explanation: 'The request can fail without a handled error response.',
  suggestion: 'Add error handling and return an appropriate HTTP status.',
};

describe('findingSchema', () => {
  it('accepts a fully valid finding', () => {
    const result = findingSchema.safeParse(validFinding);
    assert.equal(result.success, true);
  });

  it('accepts a file-level finding with line: null', () => {
    const result = findingSchema.safeParse({ ...validFinding, line: null });
    assert.equal(result.success, true);
  });

  it('rejects an unknown severity', () => {
    const result = findingSchema.safeParse({ ...validFinding, severity: 'urgent' });
    assert.equal(result.success, false);
  });

  it('rejects an unknown category', () => {
    const result = findingSchema.safeParse({ ...validFinding, category: 'style' });
    assert.equal(result.success, false);
  });

  it('rejects confidence outside 0..1', () => {
    assert.equal(findingSchema.safeParse({ ...validFinding, confidence: 1.4 }).success, false);
    assert.equal(findingSchema.safeParse({ ...validFinding, confidence: -0.1 }).success, false);
  });

  it('rejects non-integer or zero line numbers', () => {
    assert.equal(findingSchema.safeParse({ ...validFinding, line: 0 }).success, false);
    assert.equal(findingSchema.safeParse({ ...validFinding, line: 2.5 }).success, false);
    assert.equal(findingSchema.safeParse({ ...validFinding, line: -3 }).success, false);
    assert.equal(findingSchema.safeParse({ ...validFinding, line: '24' }).success, false);
  });

  it('rejects findings missing required fields', () => {
    const { title, ...withoutTitle } = validFinding;
    assert.equal(findingSchema.safeParse(withoutTitle).success, false);
    const { suggestion, ...withoutSuggestion } = validFinding;
    assert.equal(findingSchema.safeParse(withoutSuggestion).success, false);
  });
});

describe('validateFindings', () => {
  it('splits valid from invalid findings with reasons', () => {
    const { valid, rejected } = validateFindings([
      validFinding,
      { ...validFinding, severity: 'apocalyptic' },
      'not even an object',
    ]);
    assert.equal(valid.length, 1);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /severity/);
  });

  it('returns empty result for a non-array input', () => {
    const { valid, rejected } = validateFindings(undefined);
    assert.deepEqual(valid, []);
    assert.deepEqual(rejected, []);
  });
});

describe('parseModelContent', () => {
  it('parses a valid envelope', () => {
    const envelope = parseModelContent(JSON.stringify({ findings: [validFinding] }));
    assert.equal(envelope.findings.length, 1);
  });

  it('throws MODEL_OUTPUT_INVALID on malformed JSON', () => {
    assert.throws(
      () => parseModelContent('Sure! Here is the review: {...'),
      (err) => err.code === 'MODEL_OUTPUT_INVALID'
    );
  });

  it('throws MODEL_OUTPUT_INVALID when findings is not an array', () => {
    assert.throws(
      () => parseModelContent(JSON.stringify({ findings: 'none' })),
      (err) => err.code === 'MODEL_OUTPUT_INVALID'
    );
  });

  it('throws MODEL_OUTPUT_INVALID when the top level is an array', () => {
    assert.throws(
      () => parseModelContent(JSON.stringify([validFinding])),
      (err) => err.code === 'MODEL_OUTPUT_INVALID'
    );
  });
});

describe('findingsEnvelopeSchema', () => {
  it('allows a summary alongside findings', () => {
    const result = findingsEnvelopeSchema.safeParse({
      findings: [],
      summary: 'Looks good.',
    });
    assert.equal(result.success, true);
  });
});

describe('isLineInBounds', () => {
  it('accepts lines 1..lineCount and null', () => {
    assert.equal(isLineInBounds(1, 10), true);
    assert.equal(isLineInBounds(10, 10), true);
    assert.equal(isLineInBounds(null, 10), true);
  });

  it('rejects lines outside the code', () => {
    assert.equal(isLineInBounds(11, 10), false);
    assert.equal(isLineInBounds(0, 10), false);
  });
});