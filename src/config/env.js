/**
 * Environment access with validation.
 *
 * Nothing is read or validated at import time so tests (and any code that
 * injects its own OpenAI client) can run without OPENAI_API_KEY set.
 */

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** Default for MAX_REVIEW_CHARS: total diff characters sent to the model per PR review. */
export const DEFAULT_MAX_REVIEW_CHARS = 60000;
/** Default for MAX_FILES_PER_REVIEW: most-changed files considered per PR. */
export const DEFAULT_MAX_FILES_PER_REVIEW = 30;

/**
 * Review-pipeline safety limits (Phase 3).
 *
 * @returns {{ maxReviewChars: number, maxFilesPerReview: number }}
 * @throws {EnvConfigError} when a MAX_* value is set but is not a positive integer
 */
export function getReviewLimitsConfig(env = process.env) {
  const readPositiveInt = (name, fallback) => {
    const raw = (env[name] ?? '').trim();
    if (raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1) {
      throw new EnvConfigError(`${name} must be a positive integer, got "${raw}".`);
    }
    return value;
  };
  return {
    maxReviewChars: readPositiveInt('MAX_REVIEW_CHARS', DEFAULT_MAX_REVIEW_CHARS),
    maxFilesPerReview: readPositiveInt('MAX_FILES_PER_REVIEW', DEFAULT_MAX_FILES_PER_REVIEW),
  };
}

export class EnvConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvConfigError';
    this.code = 'ENV_CONFIG_ERROR';
  }
}

/**
 * GitHub webhook configuration.
 *
 * Separate from getGithubAppConfig() because the webhook server only needs
 * the shared secret; calls into the GitHub API need App credentials.
 *
 * @returns {{ webhookSecret: string }}
 * @throws {EnvConfigError}
 */
export function getGithubWebhookConfig(env = process.env) {
  const webhookSecret = (env.GITHUB_WEBHOOK_SECRET ?? '').trim();
  if (!webhookSecret) {
    throw new EnvConfigError(
      'GITHUB_WEBHOOK_SECRET is not set. Copy .env.example to .env and add the webhook secret from your GitHub App settings.'
    );
  }
  return { webhookSecret };
}

/**
 * GitHub App credentials for API calls (JWT -> installation token).
 *
 * `installationId` is optional: webhook payloads carry `installation.id`, so
 * it only matters for out-of-band calls such as the pr:diff script.
 *
 * @returns {{ appId: string, privateKeyPath: string, installationId: number | null }}
 * @throws {EnvConfigError}
 */
export function getGithubAppConfig(env = process.env) {
  const appId = (env.GITHUB_APP_ID ?? '').trim();
  const privateKeyPath = (env.GITHUB_PRIVATE_KEY_PATH ?? '').trim();
  const missing = [];
  if (!appId) missing.push('GITHUB_APP_ID');
  if (!privateKeyPath) missing.push('GITHUB_PRIVATE_KEY_PATH');
  if (missing.length > 0) {
    throw new EnvConfigError(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. Copy .env.example to .env and add your GitHub App credentials.`
    );
  }

  const rawInstallationId = (env.GITHUB_INSTALLATION_ID ?? '').trim();
  let installationId = null;
  if (rawInstallationId) {
    if (!/^\d+$/.test(rawInstallationId)) {
      throw new EnvConfigError(
        `GITHUB_INSTALLATION_ID must be a numeric installation id, got "${rawInstallationId}".`
      );
    }
    installationId = Number(rawInstallationId);
  }

  return { appId, privateKeyPath, installationId };
}

/** Returns { apiKey, model } or throws EnvConfigError with an actionable message. */
export function getOpenAIConfig(env = process.env) {
  const apiKey = (env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new EnvConfigError(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and add your OpenAI API key.'
    );
  }
  const model = (env.OPENAI_MODEL ?? '').trim() || DEFAULT_OPENAI_MODEL;
  return { apiKey, model };
}