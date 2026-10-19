import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../src/github/webhook-signature.js';

const SECRET = 'test-webhook-secret';
const BODY = '{"zen":"Design for failure.","action":"opened"}';
// Pre-computed HMAC-SHA256(SECRET, BODY) so this vector does not merely
// re-run the implementation under test.
const KNOWN_SIGNATURE =
  'sha256=5ce88467f35044a5cef9bb226f99ba8b79b1450d0e8dbdbc59b404bb0a9a1da6';

describe('computeWebhookSignature', () => {
  it('matches the pre-computed HMAC-SHA256 vector', () => {
    assert.equal(computeWebhookSignature(BODY, SECRET), KNOWN_SIGNATURE);
  });

  it('agrees with an independent hmac over a Buffer body', () => {
    const expected =
      'sha256=' +
      createHmac('sha256', SECRET).update(Buffer.from(BODY, 'utf8')).digest('hex');
    assert.equal(computeWebhookSignature(Buffer.from(BODY, 'utf8'), SECRET), expected);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts the correct signature for a string body', () => {
    assert.equal(verifyWebhookSignature(BODY, KNOWN_SIGNATURE, SECRET), true);
  });

  it('accepts the correct signature for a Buffer body', () => {
    assert.equal(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), KNOWN_SIGNATURE, SECRET), true);
  });

  it('rejects a tampered body of the same length', () => {
    const tampered = BODY.replace('failure', 'failurX');
    assert.equal(tampered.length, BODY.length);
    assert.equal(verifyWebhookSignature(tampered, KNOWN_SIGNATURE, SECRET), false);
  });

  it('rejects a body with extra content appended', () => {
    assert.equal(verifyWebhookSignature(BODY + ' ', KNOWN_SIGNATURE, SECRET), false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const wrongSecretSig = computeWebhookSignature(BODY, 'not-the-secret');
    assert.equal(verifyWebhookSignature(BODY, wrongSecretSig, SECRET), false);
  });

  it('rejects an equal-length but wrong signature', () => {
    const flipped = KNOWN_SIGNATURE.slice(0, -1) + (KNOWN_SIGNATURE.endsWith('6') ? '7' : '6');
    assert.equal(flipped.length, KNOWN_SIGNATURE.length);
    assert.equal(verifyWebhookSignature(BODY, flipped, SECRET), false);
  });

  it('rejects the legacy sha1 scheme and unprefixed digests', () => {
    assert.equal(verifyWebhookSignature(BODY, `sha1=${'a'.repeat(40)}`, SECRET), false);
    assert.equal(verifyWebhookSignature(BODY, KNOWN_SIGNATURE.slice('sha256='.length), SECRET), false);
  });

  it('rejects missing or non-string signature headers', () => {
    assert.equal(verifyWebhookSignature(BODY, null, SECRET), false);
    assert.equal(verifyWebhookSignature(BODY, undefined, SECRET), false);
    assert.equal(verifyWebhookSignature(BODY, 42, SECRET), false);
    assert.equal(verifyWebhookSignature(BODY, { toString: () => KNOWN_SIGNATURE }, SECRET), false);
  });

  it('rejects an empty or non-string secret', () => {
    assert.equal(verifyWebhookSignature(BODY, KNOWN_SIGNATURE, ''), false);
    assert.equal(verifyWebhookSignature(BODY, KNOWN_SIGNATURE, null), false);
  });

  it('rejects a non-string, non-Buffer body without throwing', () => {
    assert.equal(verifyWebhookSignature({ body: BODY }, KNOWN_SIGNATURE, SECRET), false);
    assert.equal(verifyWebhookSignature(null, KNOWN_SIGNATURE, SECRET), false);
  });
});
