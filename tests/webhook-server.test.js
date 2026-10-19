import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  WebhookError,
  parseWebhookRequest,
  startWebhookServer,
} from '../src/github/webhook-server.js';
import { computeWebhookSignature } from '../src/github/webhook-signature.js';

const SECRET = 'test-webhook-secret';

describe('webhook server', () => {
  let info;
  let handleCalls;
  let loggedErrors;

  before(async () => {
    handleCalls = [];
    loggedErrors = [];
    info = await startWebhookServer({
      secret: SECRET,
      maxBodyBytes: 1024,
      logger: { error: (msg) => loggedErrors.push(msg) },
      handlers: {
        pull_request: async (payload, ctx) => {
          handleCalls.push({ payload, ctx });
          return { queued: true };
        },
        boom: () => {
          throw new Error('handler exploded');
        },
      },
    });
  });

  after(async () => {
    await info.close();
  });

  function postRaw(body, headers) {
    return fetch(`${info.url}/webhook`, { method: 'POST', headers, body });
  }

  function post(event, payload, { secret = SECRET, signature, deliveryId = 'delivery-1' } = {}) {
    const body = JSON.stringify(payload);
    const headers = {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
    };
    if (signature !== null) {
      headers['x-hub-signature-256'] = signature ?? computeWebhookSignature(body, secret);
    }
    return postRaw(body, headers);
  }

  it('accepts a signed pull_request delivery and calls the handler', async () => {
    const res = await post('pull_request', {
      action: 'opened',
      installation: { id: 42 },
      pull_request: { number: 7 },
      repository: { full_name: 'acme/widgets' },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      received: true,
      handled: true,
      event: 'pull_request',
      result: { queued: true },
    });

    const call = handleCalls.at(-1);
    assert.equal(call.payload.action, 'opened');
    assert.equal(call.payload.installation.id, 42);
    assert.equal(call.ctx.event, 'pull_request');
    assert.equal(call.ctx.delivery, 'delivery-1');
  });

  it('answers ping deliveries with 200 even without a handler', async () => {
    const res = await post('ping', { zen: 'Design for failure.' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.handled, false);
    assert.equal(body.event, 'ping');
  });

  it('accepts and ignores unhandled events with 202', async () => {
    const res = await post('star', { action: 'created' });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.handled, false);
  });

  it('rejects a bad signature with 401 and never calls the handler', async () => {
    const beforeCount = handleCalls.length;
    const res = await post('pull_request', { action: 'opened' }, { secret: 'wrong-secret' });

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Webhook signature does not match');
    assert.equal(handleCalls.length, beforeCount);
  });

  it('rejects a delivery with no signature header', async () => {
    const beforeCount = handleCalls.length;
    const res = await post('pull_request', { action: 'opened' }, { signature: null });

    assert.equal(res.status, 401);
    assert.equal(handleCalls.length, beforeCount);
  });

  it('rejects a correctly signed but malformed JSON body', async () => {
    const body = '{not json';
    const res = await postRaw(body, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': computeWebhookSignature(body, SECRET),
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not valid JSON/);
  });

  it('rejects oversized bodies with 413', async () => {
    const body = JSON.stringify({ action: 'opened', filler: 'x'.repeat(2048) });
    const res = await postRaw(body, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': computeWebhookSignature(body, SECRET),
    });

    assert.equal(res.status, 413);
  });

  it('returns 500 and logs when a handler throws', async () => {
    const loggedBefore = loggedErrors.length;
    const res = await post('boom', { action: 'whatever' });

    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'internal error');
    assert.equal(loggedErrors.length, loggedBefore + 1);
    assert.match(loggedErrors.at(-1), /handler exploded/);
  });

  it('serves a health check and 404s unknown paths', async () => {
    const health = await fetch(`${info.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const missing = await fetch(`${info.url}/nope`, { method: 'POST' });
    assert.equal(missing.status, 404);
  });

  it('rejects non-POST requests to the webhook path', async () => {
    const res = await fetch(`${info.url}/webhook`, { method: 'GET' });
    assert.equal(res.status, 405);
  });
});

describe('parseWebhookRequest', () => {
  const body = JSON.stringify({ action: 'opened' });
  const headers = {
    'x-hub-signature-256': computeWebhookSignature(body, SECRET),
    'x-github-event': 'pull_request',
    'x-github-delivery': 'abc-123',
  };

  it('decodes event, action, delivery and payload', () => {
    const parsed = parseWebhookRequest({ headers, rawBody: body, secret: SECRET });
    assert.equal(parsed.event, 'pull_request');
    assert.equal(parsed.action, 'opened');
    assert.equal(parsed.delivery, 'abc-123');
    assert.deepEqual(parsed.payload, { action: 'opened' });
  });

  it('handles array-valued headers (repeated headers)', () => {
    const parsed = parseWebhookRequest({
      headers: { ...headers, 'x-github-event': ['pull_request'] },
      rawBody: body,
      secret: SECRET,
    });
    assert.equal(parsed.event, 'pull_request');
  });

  it('throws WebhookError 400 when the event header is missing', () => {
    const { 'x-github-event': _, ...rest } = headers;
    assert.throws(
      () => parseWebhookRequest({ headers: rest, rawBody: body, secret: SECRET }),
      (err) => err instanceof WebhookError && err.statusCode === 400 && err.code === 'EVENT_MISSING'
    );
  });

  it('throws WebhookError 400 when the payload is not a JSON object', () => {
    const arrayBody = '[]';
    assert.throws(
      () =>
        parseWebhookRequest({
          headers: {
            ...headers,
            'x-hub-signature-256': computeWebhookSignature(arrayBody, SECRET),
          },
          rawBody: arrayBody,
          secret: SECRET,
        }),
      (err) => err instanceof WebhookError && err.code === 'PAYLOAD_INVALID'
    );
  });

  it('throws WebhookError 401 for a bad signature', () => {
    assert.throws(
      () => parseWebhookRequest({ headers, rawBody: '{}', secret: SECRET }),
      (err) => err instanceof WebhookError && err.statusCode === 401 && err.code === 'SIGNATURE_INVALID'
    );
  });
});
