/**
 * Environment access with validation.
 *
 * Nothing is read or validated at import time so tests (and any code that
 * injects its own OpenAI client) can run without OPENAI_API_KEY set.
 */

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

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