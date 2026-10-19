/**
 * GitHub App authentication: short-lived JWT -> installation access token.
 *
 * Uses only node:crypto (RS256) and the global fetch available in Node 20+,
 * so no octokit dependency is needed. Everything network-shaped is
 * injectable for tests.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** GitHub rejects JWTs whose exp is more than 10 minutes in the future. */
export const APP_JWT_TTL_SECONDS = 10 * 60;
/** Backdate iat slightly so a bit of clock drift does not invalidate the JWT. */
export const APP_JWT_CLOCK_SKEW_SECONDS = 60;
/** How long before expiry the cached installation token is refreshed. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;
/** Fallback cache lifetime when GitHub omits expires_at. */
const DEFAULT_TOKEN_CACHE_MS = 8 * 60 * 1000;

export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
export const DEFAULT_USER_AGENT = 'ai-code-review-bot';

/** Thrown when GitHub App authentication cannot produce a token. */
export class GithubAuthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GithubAuthError';
    this.code = 'GITHUB_AUTH_FAILED';
    this.details = details;
  }
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Build the RS256 JWT GitHub App authentication expects.
 *
 * @param {object} params
 * @param {string | number} params.appId - GITHUB_APP_ID
 * @param {string | import('node:crypto').KeyObject} params.privateKey - PEM or KeyObject
 * @param {() => number} [params.now] - injectable clock (ms since epoch)
 * @returns {string} signed JWT
 * @throws {GithubAuthError} when the key is not a usable RSA private key
 */
export function createAppJwt({ appId, privateKey, now = Date.now }) {
  if (appId === undefined || appId === null || String(appId).trim() === '') {
    throw new GithubAuthError('createAppJwt requires the GitHub App id (GITHUB_APP_ID)');
  }

  const issuedAt = Math.floor(now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: issuedAt - APP_JWT_CLOCK_SKEW_SECONDS,
      exp: issuedAt + APP_JWT_TTL_SECONDS,
      iss: String(appId),
    })
  );
  const signingInput = `${header}.${payload}`;

  let key;
  if (typeof privateKey === 'string') {
    try {
      key = createPrivateKey(privateKey);
    } catch (err) {
      throw new GithubAuthError(
        `GitHub App private key could not be parsed: ${err.message}`,
        { cause: err }
      );
    }
  } else if (privateKey && typeof privateKey === 'object' && privateKey.type === 'private') {
    key = privateKey;
  } else {
    throw new GithubAuthError(
      'GitHub App private key must be a PEM string or a private KeyObject'
    );
  }

  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Read and validate the App private key PEM from disk.
 *
 * @param {string} privateKeyPath - GITHUB_PRIVATE_KEY_PATH
 * @returns {Promise<string>} the PEM contents
 * @throws {GithubAuthError} actionable message for missing/invalid files
 */
export async function loadPrivateKey(privateKeyPath) {
  if (!privateKeyPath) {
    throw new GithubAuthError('loadPrivateKey requires GITHUB_PRIVATE_KEY_PATH');
  }
  let pem;
  try {
    pem = await readFile(privateKeyPath, 'utf8');
  } catch (err) {
    throw new GithubAuthError(
      `Could not read GitHub App private key at ${privateKeyPath}: ${err.message}`,
      { cause: err }
    );
  }
  try {
    createPrivateKey(pem);
  } catch (err) {
    throw new GithubAuthError(
      `GitHub App private key at ${privateKeyPath} is not a valid PEM private key: ${err.message}`,
      { cause: err }
    );
  }
  return pem;
}

/**
 * Exchange the App JWT for an installation access token.
 *
 * @param {object} params
 * @param {string | number} params.appId
 * @param {string | import('node:crypto').KeyObject} params.privateKey
 * @param {string | number} params.installationId
 * @param {typeof fetch} [params.fetchImpl]
 * @param {string} [params.apiBaseUrl]
 * @param {() => number} [params.now]
 * @returns {Promise<{ token: string, expiresAt: string | null, expiresAtMs: number | null }>}
 * @throws {GithubAuthError} on non-2xx responses
 */
export async function createInstallationToken({
  appId,
  privateKey,
  installationId,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
  now = Date.now,
}) {
  if (installationId === undefined || installationId === null || !/^\d+$/.test(String(installationId))) {
    throw new GithubAuthError(
      'createInstallationToken requires a numeric installation id (GITHUB_INSTALLATION_ID or the webhook payload\'s installation.id)'
    );
  }

  const jwt = createAppJwt({ appId, privateKey, now });
  const url = `${apiBaseUrl}/app/installations/${installationId}/access_tokens`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });
  } catch (err) {
    throw new GithubAuthError(`GitHub token request failed: ${err.message}`, { cause: err });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GithubAuthError(
      `GitHub token endpoint returned ${res.status} for installation ${installationId}${body ? `: ${body.slice(0, 300)}` : ''}`,
      { status: res.status, body }
    );
  }

  const data = await res.json().catch(() => ({}));
  const token = data?.token;
  if (typeof token !== 'string' || token === '') {
    throw new GithubAuthError('GitHub token endpoint response contained no token');
  }

  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : null;
  const parsedExpiry = expiresAt ? Date.parse(expiresAt) : NaN;
  return {
    token,
    expiresAt,
    expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : null,
  };
}

/**
 * getToken() with caching: one network exchange until the token is close to
 * expiry, then a fresh one. This is what the API client consumes.
 *
 * @param {object} params - createInstallationToken params
 * @param {number} [params.refreshMarginSeconds]
 * @returns {() => Promise<string>}
 */
export function createInstallationTokenProvider({
  refreshMarginSeconds = TOKEN_REFRESH_MARGIN_SECONDS,
  ...tokenParams
}) {
  const { now = Date.now } = tokenParams;
  let cached = null;

  return async function getToken() {
    if (cached && now() < cached.validUntilMs) {
      return cached.token;
    }
    const issued = await createInstallationToken(tokenParams);
    const validUntilMs =
      issued.expiresAtMs !== null
        ? issued.expiresAtMs - refreshMarginSeconds * 1000
        : now() + DEFAULT_TOKEN_CACHE_MS;
    cached = { token: issued.token, validUntilMs };
    return issued.token;
  };
}
