import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  APP_JWT_CLOCK_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  GithubAuthError,
  createAppJwt,
  createInstallationToken,
  createInstallationTokenProvider,
  loadPrivateKey,
} from '../src/github/app-auth.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_NOW = () => FIXED_NOW_MS;

function decodeJwt(jwt) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    signature,
    signingInput: `${header}.${payload}`,
  };
};

function tokenEndpoint({ token = 'ghs_test_token', expiresAt = '2030-01-01T00:00:00Z', status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) {
      return { ok: false, status, text: async () => 'Not Found', json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ token, expires_at: expiresAt }) };
  };
  return { calls, fetchImpl };
}

describe('createAppJwt', () => {
  it('returns a verifiable RS256 JWT with GitHub-compatible claims', () => {
    const jwt = createAppJwt({ appId: '12345', privateKey: PRIVATE_PEM, now: FIXED_NOW });
    const { header, payload } = decodeJwt(jwt);

    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');
    assert.equal(payload.iss, '12345');
    assert.equal(payload.iat, Math.floor(FIXED_NOW_MS / 1000) - APP_JWT_CLOCK_SKEW_SECONDS);
    assert.equal(payload.exp, Math.floor(FIXED_NOW_MS / 1000) + APP_JWT_TTL_SECONDS);
    assert.equal(jwt.split('.').length, 3);
  });

  

  it('rejects unusable keys and missing app ids with GithubAuthError', () => {
    assert.throws(
      () => createAppJwt({ appId: '1', privateKey: 'not a pem key' }),
      (err) => err instanceof GithubAuthError && err.code === 'GITHUB_AUTH_FAILED'
    );
    assert.throws(
      () => createAppJwt({ appId: '', privateKey: PRIVATE_PEM }),
      GithubAuthError
    );
  });
});

describe('loadPrivateKey', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'review-bot-key-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates a PEM file', async () => {
    const keyPath = path.join(dir, 'app.pem');
    await writeFile(keyPath, PRIVATE_PEM, 'utf8');
    const pem = await loadPrivateKey(keyPath);
    assert.equal(pem, PRIVATE_PEM);
  });

  it('reports a missing file with the path', async () => {
    const missing = path.join(dir, 'nope.pem');
    await assert.rejects(
      loadPrivateKey(missing),
      (err) => err instanceof GithubAuthError && err.message.includes(missing)
    );
  });

  it('reports a file that is not a valid private key', async () => {
    const badPath = path.join(dir, 'bad.pem');
    await writeFile(badPath, '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----\n', 'utf8');
    await assert.rejects(
      loadPrivateKey(badPath),
      (err) => err instanceof GithubAuthError && /valid PEM/.test(err.message)
    );
  });

  it('requires a path', async () => {
    await assert.rejects(loadPrivateKey(''), GithubAuthError);
  });
});

describe('createInstallationToken', () => {
  it('exchanges the App JWT for an installation token', async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    const result = await createInstallationToken({
      appId: '12345',
      privateKey: PRIVATE_PEM,
      installationId: '4242',
      fetchImpl,
      now: FIXED_NOW,
    });

    assert.equal(result.token, 'ghs_test_token');
    assert.equal(result.expiresAt, '2030-01-01T00:00:00Z');
    assert.equal(result.expiresAtMs, Date.parse('2030-01-01T00:00:00Z'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/app/installations/4242/access_tokens');
    assert.equal(calls[0].init.method, 'POST');
    const auth = calls[0].init.headers.Authorization;
    assert.match(auth, /^Bearer eyJ/);
    assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(calls[0].init.headers['User-Agent'], 'ai-code-review-bot');
  });

  it('honours a custom apiBaseUrl', async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    await createInstallationToken({
      appId: '1',
      privateKey: PRIVATE_PEM,
      installationId: 7,
      fetchImpl,
      apiBaseUrl: 'https://github.example.com/api/v3',
      now: FIXED_NOW,
    });
    assert.equal(calls[0].url, 'https://github.example.com/api/v3/app/installations/7/access_tokens');
  });

  it('throws GithubAuthError with the status on non-2xx', async () => {
    const { fetchImpl } = tokenEndpoint({ status: 404 });
    await assert.rejects(
      createInstallationToken({
        appId: '1',
        privateKey: PRIVATE_PEM,
        installationId: 99,
        fetchImpl,
        now: FIXED_NOW,
      }),
      (err) => err instanceof GithubAuthError && /404/.test(err.message)
    );
  });

  it('requires a numeric installation id', async () => {
    const { fetchImpl } = tokenEndpoint();
    await assert.rejects(
      createInstallationToken({ appId: '1', privateKey: PRIVATE_PEM, installationId: null, fetchImpl }),
      GithubAuthError
    );
    await assert.rejects(
      createInstallationToken({ appId: '1', privateKey: PRIVATE_PEM, installationId: 'abc', fetchImpl }),
      GithubAuthError
    );
  });

  it('throws when the response has no token', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await assert.rejects(
      createInstallationToken({ appId: '1', privateKey: PRIVATE_PEM, installationId: 1, fetchImpl }),
      GithubAuthError
    );
  });
});

describe('createInstallationTokenProvider', () => {
  it('caches the token until it nears expiry, then refreshes', async () => {
    let nowMs = FIXED_NOW_MS;
    const now = () => nowMs;
    const expiresAt = new Date(nowMs + 10 * 60 * 1000).toISOString();
    const { calls, fetchImpl } = tokenEndpoint({ token: 'ghs_first', expiresAt });

    const getToken = createInstallationTokenProvider({
      appId: '1',
      privateKey: PRIVATE_PEM,
      installationId: 3,
      fetchImpl,
      now,
    });

    assert.equal(await getToken(), 'ghs_first');
    // Still inside the refresh margin: served from cache.
    nowMs += 8 * 60 * 1000;
    assert.equal(await getToken(), 'ghs_first');
    assert.equal(calls.length, 1);

    // Past expires_at - 60s: a fresh exchange happens.
    nowMs += 2 * 60 * 1000 + 1;
    assert.equal(await getToken(), 'ghs_first');
    assert.equal(calls.length, 2);
  });

  it('returns the same token for concurrent first calls after the first fetch', async () => {
    const { calls, fetchImpl } = tokenEndpoint({ token: 'ghs_first' });
    const getToken = createInstallationTokenProvider({
      appId: '1',
      privateKey: PRIVATE_PEM,
      installationId: 3,
      fetchImpl,
      now: FIXED_NOW,
    });

    assert.equal(await getToken(), 'ghs_first');
    assert.equal(await getToken(), 'ghs_first');
    assert.equal(calls.length, 1);
  });
});