/**
 * GitHub webhook signature verification.
 *
 * GitHub signs the exact raw request body with HMAC-SHA256 using the webhook
 * secret and sends the hex digest in X-Hub-Signature-256 as "sha256=<hex>".
 * The body must therefore be verified as raw bytes before any JSON parsing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
export const EVENT_HEADER = 'x-github-event';
export const DELIVERY_HEADER = 'x-github-delivery';

export const SIGNATURE_PREFIX = 'sha256=';

/**
 * The signature GitHub should have sent for `rawBody`.
 *
 * @param {string | Buffer} rawBody
 * @param {string} secret
 * @returns {string} "sha256=<hex>"
 */
export function computeWebhookSignature(rawBody, secret) {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Timing-safe check that `signatureHeader` authenticates `rawBody`.
 *
 * Returns false (never throws) for missing/malformed headers, wrong schemes,
 * wrong secrets and tampered bodies.
 *
 * @param {string | Buffer} rawBody - the exact bytes received off the wire
 * @param {string | null | undefined} signatureHeader - value of X-Hub-Signature-256
 * @param {string} secret - GITHUB_WEBHOOK_SECRET
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), 'utf8');
  const actual = Buffer.from(signatureHeader, 'utf8');
  // Hex digests are fixed length; guard anyway so timingSafeEqual never throws.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
