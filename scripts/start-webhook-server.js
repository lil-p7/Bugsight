#!/usr/bin/env node
/**
 * Start the GitHub webhook server:
 *   npm run server
 *
 * GitHub delivers events to POST /webhook (see WEBHOOK_PATH/PORT below).
 * For local development point a tunnel (ngrok, smee.io, ...) at the port and
 * configure that URL as the App's webhook URL with the same secret.
 *
 * Phase 3: pull_request deliveries are validated, queued on an in-process
 * serial queue and reviewed through the pipeline (diff -> limits -> OpenAI ->
 * validated findings anchored on real file lines). The handler answers GitHub
 * immediately; results are logged here until Phase 4 publishes them back to
 * the PR.
 */
import {
  getGithubAppConfig,
  getGithubWebhookConfig,
  getReviewLimitsConfig,
} from '../src/config/env.js';
import { createGithubClient } from '../src/github/api.js';
import { createInstallationTokenProvider, loadPrivateKey } from '../src/github/app-auth.js';
import { createPullRequestHandler } from '../src/github/pull-request-handler.js';
import { startWebhookServer } from '../src/github/webhook-server.js';
import { runReviewPipeline } from '../src/services/review-pipeline.js';

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

// The pipeline needs App credentials (diff fetch) and limits at startup;
// OpenAI is checked lazily so the server still acks deliveries without a key.
let appConfig;
let privateKey;
try {
  appConfig = getGithubAppConfig();
  privateKey = await loadPrivateKey(appConfig.privateKeyPath);
} catch (err) {
  fail(err.message);
}

let limits;
try {
  limits = getReviewLimitsConfig();
} catch (err) {
  fail(err.message);
}

if (!(process.env.OPENAI_API_KEY ?? '').trim()) {
  console.warn(
    '[startup] OPENAI_API_KEY is not set — queued reviews will fail until it is added to .env'
  );
}

const getGithubClient = ({ installationId }) =>
  createGithubClient({
    getToken: createInstallationTokenProvider({
      appId: appConfig.appId,
      privateKey,
      installationId,
    }),
  });

const reviewHandler = createPullRequestHandler({
  getGithubClient,
  runReview: (args) => runReviewPipeline({ ...args, limits }),
  logger: console,
});

const handlers = {
  ping: (payload) => ({ pong: true, zen: payload?.zen ?? null }),
  pull_request: reviewHandler,
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
