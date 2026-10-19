import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MAX_FILES_PER_REVIEW,
  DEFAULT_MAX_REVIEW_CHARS,
  EnvConfigError,
  getReviewLimitsConfig,
} from '../src/config/env.js';

describe('getReviewLimitsConfig', () => {
  it('falls back to documented defaults when MAX_* vars are unset', () => {
    assert.deepEqual(getReviewLimitsConfig({}), {
      maxReviewChars: DEFAULT_MAX_REVIEW_CHARS,
      maxFilesPerReview: DEFAULT_MAX_FILES_PER_REVIEW,
    });
    assert.equal(DEFAULT_MAX_REVIEW_CHARS, 60000);
    assert.equal(DEFAULT_MAX_FILES_PER_REVIEW, 30);
  });

  it('reads positive integers and trims whitespace', () => {
    assert.deepEqual(
      getReviewLimitsConfig({ MAX_REVIEW_CHARS: ' 12345 ', MAX_FILES_PER_REVIEW: '7' }),
      { maxReviewChars: 12345, maxFilesPerReview: 7 }
    );
  });

  it('treats empty strings as unset', () => {
    const config = getReviewLimitsConfig({ MAX_REVIEW_CHARS: '', MAX_FILES_PER_REVIEW: '   ' });
    assert.equal(config.maxReviewChars, DEFAULT_MAX_REVIEW_CHARS);
    assert.equal(config.maxFilesPerReview, DEFAULT_MAX_FILES_PER_REVIEW);
  });

  it('rejects non-numeric, zero, negative and fractional values', () => {
    for (const bad of ['abc', '0', '-5', '2.5', '1e3']) {
      assert.throws(
        () => getReviewLimitsConfig({ MAX_REVIEW_CHARS: bad }),
        (err) => err instanceof EnvConfigError && err.code === 'ENV_CONFIG_ERROR' && /MAX_REVIEW_CHARS/.test(err.message),
        `expected MAX_REVIEW_CHARS=${bad} to be rejected`
      );
    }
    assert.throws(
      () => getReviewLimitsConfig({ MAX_FILES_PER_REVIEW: 'nope' }),
      (err) => err instanceof EnvConfigError && /MAX_FILES_PER_REVIEW/.test(err.message)
    );
  });
});
