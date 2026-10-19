/**
 * HTTP server that receives GitHub webhooks.
 *
 * Design notes:
 * - The raw body is kept verbatim: the HMAC signature (see
 *   webhook-signature.js) can only be verified against the exact bytes
 *   GitHub signed, so nothing parses the body before verification.
 * - Handlers run inline and the response is sent only after they settle, so
 *   GitHub sees failures as 5xx and retries the delivery. Keep handlers fast;
 *   the review pipeline (Phase 3) should queue work instead of reviewing
 *   inline.
 * - Status codes: 401 bad signature, 400 malformed delivery, 413 body too
 *   large, 202 accepted-but-ignored event, 200 handled, 500 handler failed.
 */
import http from 'node:http';

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from './webhook-signature.js';

export const DEFAULT_WEBHOOK_PATH = '/webhook';
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** A request GitHub (or its sender) can be told about with a 4xx/5xx. */
export class WebhookError extends Error {
  constructor(message, statusCode = 400, code = 'WEBHOOK_ERROR') {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Node gives repeated headers as arrays; GitHub sends single values. */
export function getHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

/**
 * Verify a delivery and decode it.
 *
 * @param {object} params
 * @param {object} params.headers - Node request headers
 * @param {string | Buffer} params.rawBody - untouched request body
 * @param {string} params.secret - GITHUB_WEBHOOK_SECRET
 * @returns {{ event: string, action: string | null, delivery: string | null, payload: object }}
 * @throws {WebhookError} 401 for bad signatures, 400 for malformed deliveries
 */
export function parseWebhookRequest({ headers, rawBody, secret }) {
  const signature = getHeader(headers, SIGNATURE_HEADER);
  if (!signature) {
    throw new WebhookError('Missing X-Hub-Signature-256 header', 401, 'SIGNATURE_MISSING');
  }
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    throw new WebhookError('Webhook signature does not match', 401, 'SIGNATURE_INVALID');
  }

  const event = getHeader(headers, EVENT_HEADER);
  if (!event) {
    throw new WebhookError('Missing X-GitHub-Event header', 400, 'EVENT_MISSING');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    throw new WebhookError(`Webhook body is not valid JSON: ${err.message}`, 400, 'PAYLOAD_INVALID');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookError('Webhook payload must be a JSON object', 400, 'PAYLOAD_INVALID');
  }

  return {
    event,
    action: typeof payload.action === 'string' ? payload.action : null,
    delivery: getHeader(headers, DELIVERY_HEADER),
    payload,
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering but keep draining so the response can still be
        // delivered instead of resetting the connection mid-upload.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(new WebhookError(`Request body exceeds ${maxBytes} bytes`, 413, 'BODY_TOO_LARGE'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function send(res, statusCode, body) {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Create the webhook HTTP server (not yet listening).
 *
 * @param {object} params
 * @param {string} params.secret - GITHUB_WEBHOOK_SECRET
 * @param {Record<string, (payload: object, ctx: object) => unknown>} [params.handlers]
 *   keyed by X-GitHub-Event value; unhandled events are accepted (202) and ignored
 * @param {{ error: Function }} [params.logger]
 * @param {string} [params.path]
 * @param {number} [params.maxBodyBytes]
 * @returns {http.Server}
 */
export function createWebhookServer({
  secret,
  handlers = {},
  logger = console,
  path = DEFAULT_WEBHOOK_PATH,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('createWebhookServer requires the webhook secret');
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return send(res, 200, { ok: true });
      }
      if (url.pathname !== path) {
        return send(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') {
        return send(res, 405, { error: 'method not allowed' });
      }

      let rawBody;
      try {
        rawBody = await readBody(req, maxBodyBytes);
      } catch (err) {
        if (err instanceof WebhookError) {
          return send(res, err.statusCode, { error: err.message });
        }
        throw err;
      }

      const { event, action, delivery, payload } = parseWebhookRequest({
        headers: req.headers,
        rawBody,
        secret,
      });

      const handler = handlers[event];
      if (typeof handler !== 'function') {
        // GitHub treats any 2xx as delivered; ping always gets a 200.
        return send(res, event === 'ping' ? 200 : 202, {
          received: true,
          handled: false,
          event,
        });
      }

      const result = await handler(payload, { event, action, delivery, rawBody });
      return send(res, 200, {
        received: true,
        handled: true,
        event,
        ...(result !== undefined && result !== null && typeof result === 'object'
          ? { result }
          : {}),
      });
    } catch (err) {
      if (err instanceof WebhookError) {
        return send(res, err.statusCode, { error: err.message });
      }
      logger.error?.(`[webhook] delivery failed: ${err?.stack ?? err}`);
      return send(res, 500, { error: 'internal error' });
    }
  });
}

/**
 * Create the server and start listening.
 *
 * @param {object} [options] - createWebhookServer options plus:
 * @param {number} [options.port] - 0 picks a free port (tests)
 * @param {string} [options.host]
 * @returns {Promise<{ server: http.Server, port: number, host: string, url: string, close: () => Promise<void> }>}
 */
export async function startWebhookServer({
  port = 0,
  host = '127.0.0.1',
  ...options
} = {}) {
  const server = createWebhookServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const boundHost = address.address;
  return {
    server,
    port: address.port,
    host: boundHost,
    url: `http://${boundHost.includes(':') ? `[${boundHost}]` : boundHost}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
