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