import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REVIEWABLE_ACTIONS,
  createPullRequestHandler,
} from '../src/github/pull-request-handler.js';
import { startWebhookServer } from '../src/github/webhook-server.js';
import { computeWebhookSignature } from '../src/github/webhook-signature.js';

const SECRET = 'test-webhook-secret';
const DIFF = [
  'diff --git a/src/x.js b/src/x.js',
  '--- a/src/x.js',
  '+++ b/src/x.js',
  '@@ -1,1 +1,2 @@',
  ' const x = 1;',
  '+const y = 2;',
  '',
].join('\n');

const REVIEW_RESULT = {
  findings: [],
  rejected: [],
  perFile: [],
  skipped: [],
  usage: null,
  stats: { filesInDiff: 1, candidates: 1, selected: 1, reviewed: 1, failed: 0, skipped: 0 },
};

function makeDeps({ title = 'Add thing', review } = {}) {
  const state = { installations: [], reviews: [], log: [], errors: [] };
  const getGithubClient = ({ installationId }) => {
    state.installations.push(installationId);
    return {
      getPullRequest: async () => ({ number: 7, title }),
      getPullRequestDiff: async () => DIFF,
    };
  };
  const runReview = review ?? (async (args) => { state.reviews.push(args); return REVIEW_RESULT; });
  const logger = { log: (m) => state.log.push(m), error: (m) => state.errors.push(m) };
  return { state, getGithubClient, runReview, logger };
}

function payload(overrides = {}) {
  return {
    action: 'opened',
    installation: { id: 42 },
    pull_request: { number: 7 },
    repository: { full_name: 'acme/widgets' },
    ...overrides,
  };
}

describe('createPullRequestHandler', () => {
  it('requires its collaborators', () => {
    assert.throws(() => createPullRequestHandler({}), TypeError);
    assert.throws(() => createPullRequestHandler({ getGithubClient: () => ({}) }), TypeError);
    assert.throws(() => createPullRequestHandler({ runReview: async () => {} }), TypeError);
  });

  it('exports exactly the reviewable actions', () => {
    assert.deepEqual([...REVIEWABLE_ACTIONS].sort(), ['opened', 'reopened', 'synchronize']);
  });

  it('acknowledges non-reviewable actions without queueing anything', async () => {
    const { state, getGithubClient, runReview, logger } = makeDeps();
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    const result = await handler(payload({ action: 'labeled' }), { delivery: 'd1' });
    assert.equal(result.ignored, true);
    assert.match(result.reason, /not reviewable/);
    assert.equal(handler.pendingCount, 0);
    await handler.onIdle();
    assert.equal(state.reviews.length, 0);
    assert.equal(state.installations.length, 0);
  });

  it('rejects payloads missing identity or installation without queueing', async () => {
    const { state, getGithubClient, runReview, logger } = makeDeps();
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    const noInstallation = await handler(payload({ installation: null }), {});
    assert.equal(noInstallation.ignored, true);
    assert.match(noInstallation.reason, /installation/);

    const noNumber = await handler(payload({ pull_request: undefined }), {});
    assert.equal(noNumber.ignored, true);
    assert.match(noNumber.reason, /number/);

    const noRepo = await handler(payload({ repository: undefined }), {});
    assert.equal(noRepo.ignored, true);
    assert.match(noRepo.reason, /full_name/);

    assert.equal(handler.pendingCount, 0);
    await handler.onIdle();
    assert.equal(state.reviews.length, 0);
  });

  it('returns queued immediately while the review is still running, then completes', async () => {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let reviewDone = false;
    const state = { installations: [], reviews: [], log: [], errors: [] };
    const runReview = async (args) => {
      state.reviews.push(args);
      await gate;
      reviewDone = true;
      return REVIEW_RESULT;
    };
    const { getGithubClient, logger } = makeDeps();
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    const result = await handler(payload(), { delivery: 'delivery-1' });
    assert.deepEqual(result, { queued: true, action: 'opened', pullNumber: 7, delivery: 'delivery-1' });
    assert.equal(reviewDone, false, 'handler must not wait for the review');

    releaseGate();
    await handler.onIdle();
    assert.equal(reviewDone, true);
    assert.equal(state.reviews.length, 1);
  });

  it('fetches PR data with the payload installation and passes diff/title to the pipeline', async () => {
    const { state, getGithubClient, runReview, logger } = makeDeps({ title: 'Add thing' });
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    await handler(payload(), {});
    await handler.onIdle();

    assert.deepEqual(state.installations, [42]);
    assert.equal(state.reviews.length, 1);
    const args = state.reviews[0];
    assert.equal(args.owner, 'acme');
    assert.equal(args.repo, 'widgets');
    assert.equal(args.pullNumber, 7);
    assert.equal(args.title, 'Add thing');
    assert.equal(args.diff, DIFF);
  });

  it('runs jobs strictly in order, one at a time', async () => {
    const events = [];
    const { getGithubClient, logger } = makeDeps();
    const runReview = async () => {
      events.push('start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('end');
      return REVIEW_RESULT;
    };
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    await handler(payload(), {});
    await handler(payload({ action: 'synchronize' }), {});
    assert.equal(handler.pendingCount, 2);

    await handler.onIdle();
    assert.deepEqual(events, ['start', 'end', 'start', 'end']);
    assert.equal(handler.pendingCount, 0);
  });

  it('a failing job is logged and never poisons later jobs', async () => {
    const { state, getGithubClient, logger } = makeDeps();
    let calls = 0;
    const runReview = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return REVIEW_RESULT;
    };
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });

    await handler(payload(), {});
    await handler(payload({ action: 'synchronize' }), {});
    await handler.onIdle();

    assert.equal(calls, 2, 'second job must still run after the first failed');
    assert.equal(state.errors.length, 1);
    assert.match(state.errors[0], /boom/);
    assert.equal(handler.pendingCount, 0);
  });
});

describe('pull_request handler over HTTP (signed webhook round trip)', () => {
  it('accepts a signed delivery, answers 200 with queued:true, and completes the job', async () => {
    const { state, getGithubClient, runReview, logger } = makeDeps();
    const handler = createPullRequestHandler({ getGithubClient, runReview, logger });
    const info = await startWebhookServer({ secret: SECRET, handlers: { pull_request: handler } });

    try {
      const body = JSON.stringify(payload());
      const res = await fetch(`${info.url}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-http-1',
          'x-hub-signature-256': computeWebhookSignature(body, SECRET),
        },
        body,
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.handled, true);
      assert.deepEqual(json.result, {
        queued: true,
        action: 'opened',
        pullNumber: 7,
        delivery: 'delivery-http-1',
      });

      await handler.onIdle();
      assert.equal(state.reviews.length, 1);
      assert.equal(state.reviews[0].pullNumber, 7);
      assert.deepEqual(state.installations, [42]);
      assert.equal(state.errors.length, 0);
    } finally {
      await info.close();
    }
  });
});
