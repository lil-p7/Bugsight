import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REVIEW_TEMPERATURE, ReviewOutputError, reviewCode } from '../src/services/openai.service.js';
import { buildMessages } from '../src/prompts/code-review.prompt.js';

/** OpenAI-compatible fake: records the request, returns canned content. */
function fakeClient(content, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return {
            choices: [{ message: { content } }],
            usage,
          };
        },
      },
    },
  };
}

const TEN_LINE_CODE = Array.from({ length: 10 }, (_, i) => `line ${i + 1};`).join('\n');

function finding(overrides = {}) {
  return {
    title: 'Unchecked division',
    category: 'bug',
    severity: 'high',
    confidence: 0.9,
    file: 'src/calc.js',
    line: 3,
    explanation: 'The denominator can be zero at this line.',
    suggestion: 'Guard against a zero denominator before dividing.',
    ...overrides,
  };
}

describe('reviewCode', () => {
  it('returns validated, severity-sorted findings from a good response', async () => {
    const content = JSON.stringify({
      findings: [
        finding({ severity: 'low', title: 'Low issue' }),
        finding({ severity: 'critical', title: 'Critical issue', confidence: 0.8 }),
        finding({ severity: 'critical', title: 'Most confident', confidence: 0.99 }),
      ],
    });
    const client = fakeClient(content);

    const { findings, rejected, usage } = await reviewCode({
      code: TEN_LINE_CODE,
      language: 'javascript',
      filePath: 'src/calc.js',
      client,
      model: 'test-model',
    });

    assert.equal(findings.length, 3);
    assert.equal(rejected.length, 0);
    assert.deepEqual(
      findings.map((f) => f.title),
      ['Most confident', 'Critical issue', 'Low issue']
    );
    assert.equal(usage.total_tokens, 150);

    // Request shape: JSON mode, low temperature, prompt reviewed the code.
    const request = client.calls[0];
    assert.equal(request.response_format.type, 'json_object');
    assert.equal(request.temperature, REVIEW_TEMPERATURE);
    assert.match(request.messages[1].content, /line 1;/);
  });

  it('rejects findings whose line does not exist in the reviewed code', async () => {
    const content = JSON.stringify({
      findings: [
        finding({ title: 'In bounds' }),
        finding({ title: 'Beyond EOF', line: 900 }),
        finding({ title: 'File level', line: null }),
      ],
    });
    const client = fakeClient(content);

    const { findings, rejected } = await reviewCode({
      code: TEN_LINE_CODE,
      client,
      model: 'test-model',
    });

    assert.deepEqual(
      findings.map((f) => f.title),
      ['In bounds', 'File level']
    );
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /out of bounds/);
  });

  it('drops structurally invalid findings but keeps good ones', async () => {
    const content = JSON.stringify({
      findings: [finding(), { ...finding(), severity: 'catastrophic' }],
    });
    const client = fakeClient(content);

    const { findings, rejected } = await reviewCode({
      code: TEN_LINE_CODE,
      client,
      model: 'test-model',
    });

    assert.equal(findings.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /severity/);
  });

  it('throws ReviewOutputError on malformed JSON', async () => {
    const client = fakeClient('{"findings": [ oops');
    await assert.rejects(
      reviewCode({ code: TEN_LINE_CODE, client, model: 'test-model' }),
      (err) => err instanceof ReviewOutputError && err.code === 'REVIEW_OUTPUT_INVALID'
    );
  });

  it('throws ReviewOutputError when the response has no content', async () => {
    const client = {
      chat: { completions: { create: async () => ({ choices: [{ message: {} }] }) } },
    };
    await assert.rejects(
      reviewCode({ code: TEN_LINE_CODE, client, model: 'test-model' }),
      (err) => err instanceof ReviewOutputError
    );
  });

  it('throws ReviewOutputError on an empty findings envelope shape mismatch', async () => {
    const client = fakeClient(JSON.stringify({ issues: [] }));
    await assert.rejects(
      reviewCode({ code: TEN_LINE_CODE, client, model: 'test-model' }),
      (err) => err.code === 'REVIEW_OUTPUT_INVALID'
    );
  });

  it('rejects empty code before calling the model', async () => {
    const client = fakeClient('{}');
    await assert.rejects(
      reviewCode({ code: '   ', client, model: 'test-model' }),
      (err) => err instanceof ReviewOutputError
    );
    assert.equal(client.calls.length, 0);
  });

  it('passes an empty findings array through untouched', async () => {
    const client = fakeClient(JSON.stringify({ findings: [] }));
    const { findings, rejected } = await reviewCode({
      code: TEN_LINE_CODE,
      client,
      model: 'test-model',
    });
    assert.deepEqual(findings, []);
    assert.deepEqual(rejected, []);
  });
});

describe('buildMessages', () => {
  it('includes the review rules, JSON requirement and untrusted-code guard', () => {
    const [system, user] = buildMessages({
      code: 'const x = 1;',
      language: 'javascript',
      filePath: 'src/x.js',
    });
    assert.match(system.content, /Report only issues introduced by/);
    assert.match(system.content, /Return ONLY a JSON object/);
    assert.match(system.content, /untrusted data/);
    assert.match(user.content, /`src\/x\.js`/);
    assert.match(user.content, /const x = 1;/);
  });

  it('includes optional context when provided', () => {
    const { length } = buildMessages({ code: 'x', context: 'New file added in this PR' });
    const [, user] = buildMessages({ code: 'x', context: 'New file added in this PR' });
    assert.equal(length, 2);
    assert.match(user.content, /New file added in this PR/);
  });
});