#!/usr/bin/env node
/**
 * Fetch pull-request metadata and its raw diff from GitHub:
 *   npm run pr:diff -- <owner>/<repo> <pull-number>
 *
 * Phase 2 smoke test for GitHub App auth + diff retrieval without needing a
 * webhook tunnel. Requires GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH and
 * GITHUB_INSTALLATION_ID in .env.
 */
import { getGithubAppConfig } from '../src/config/env.js';
import {
  createInstallationTokenProvider,
  loadPrivateKey,
} from '../src/github/app-auth.js';
import { createGithubClient, parseRepoSpec } from '../src/github/api.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [repoSpec, pullNumberArg] = process.argv.slice(2);
if (!repoSpec || !pullNumberArg) {
  fail('Usage: npm run pr:diff -- <owner>/<repo> <pull-number>');
}

let config;
try {
  config = getGithubAppConfig();
} catch (err) {
  fail(err.message);
}
if (config.installationId === null) {
  fail('GITHUB_INSTALLATION_ID is not set. Add the installation id from your GitHub App installation page.');
}

const pullNumber = Number(pullNumberArg);
if (!Number.isInteger(pullNumber) || pullNumber < 1) {
  fail(`Pull request number must be a positive integer, got "${pullNumberArg}"`);
}

let privateKey;
try {
  privateKey = await loadPrivateKey(config.privateKeyPath);
} catch (err) {
  fail(err.message);
}

const getToken = createInstallationTokenProvider({
  appId: config.appId,
  privateKey,
  installationId: config.installationId,
});
const client = createGithubClient({ getToken });

const { owner, repo } = parseRepoSpec(repoSpec);

let pr;
try {
  pr = await client.getPullRequest({ owner, repo, pullNumber });
} catch (err) {
  fail(err.message);
}

console.error(
  `Fetching ${owner}/${repo}#${pullNumber} "${pr.title}" (state: ${pr.state}${pr.draft ? ', draft' : ''})...`
);

let diff;
try {
  diff = await client.getPullRequestDiff({ owner, repo, pullNumber });
} catch (err) {
  fail(err.message);
}

console.error(`Diff: ${diff.length} characters, ${diff.split(/\r?\n/).length} lines.\n`);
process.stdout.write(diff);
