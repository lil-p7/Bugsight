#!/usr/bin/env node
/**
 * Start the GitHub webhook server:
 *   npm run server
 *
 * GitHub delivers events to POST /webhook (see WEBHOOK_PATH/PORT below).
 * For local development point a tunnel (ngrok, smee.io, ...) at the port and
 * configure that URL as the App's webhook URL with the same secret.
 *
 * Phase 3 wires the review pipeline into the pull_request handler; until then
 * deliveries are logged and acknowledged so the whole receive path can be
 * exercised end to end.
 */
import { getGithubWebhookConfig } from '../src/config/env.js';
import { startWebhookServer } from '../src/github/webhook-server.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

let webhookSecret;
try {
  ({ webhookSecret } = getGithubWebhookConfig());
} catch (err) {
  fail(err.message);
}

const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

const handlers = {
  ping: (payload) => ({ pong: true, zen: payload?.zen ?? null }),
  pull_request: async (payload, ctx) => {
    const pr = payload.pull_request;
    console.log(
      `[webhook] pull_request ${payload.action} on ${payload.repository?.full_name}#${pr?.number}` +
        ` (delivery ${ctx.delivery ?? 'n/a'})`
    );
    if (!REVIEWABLE_ACTIONS.has(payload.action)) {
      return { ignored: true, reason: `action "${payload.action}" is not reviewable` };
    }
    return {
      ignored: true,
      reason: 'review pipeline not wired yet (Phase 3)',
      installation: payload.installation?.id ?? null,
    };
  },
};

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const path = process.env.WEBHOOK_PATH ?? '/webhook';

const started = await startWebhookServer({ secret: webhookSecret, handlers, port, host, path });

console.log(`Webhook server listening on ${started.url}${path}`);
console.log('Waiting for GitHub deliveries (Ctrl-C to stop)...');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    started.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}
