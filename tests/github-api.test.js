import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GitHubApiError,
  createGithubClient,
  parseRepoSpec,
} from '../src/github/api.js';

function jsonResponse(data, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, fetchImpl };
}

const TOKEN = 'ghs_test_token';

describe('createGithubClient', () => {
  it('requires getToken and fetch implementations', () => {
    assert.throws(() => createGithubClient({}), TypeError);
    assert.throws(() => createGithubClient({ getToken: async () => 'x', fetchImpl: null }), TypeError);
  });

  it('fetches PR metadata with bearer auth and API version headers', async () => {
    const { calls, fetchImpl } = recordingFetch(jsonResponse({ number: 42, title: 'Add thing' }));
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    const pr = await client.getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 42 });

    assert.equal(pr.number, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widgets/pulls/42');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(calls[0].init.headers['User-Agent'], 'ai-code-review-bot');
  });

  it('retrieves the raw diff with the v3.diff media type', async () => {
    const diff = 'diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-old\n+new\n';
    const { calls, fetchImpl } = recordingFetch(textResponse(diff));
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    const result = await client.getPullRequestDiff({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
    });

    assert.equal(result, diff);
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widgets/pulls/7');
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.v3.diff');
  });

  it('URL-encodes owner and repo segments', async () => {
    const { calls, fetchImpl } = recordingFetch(jsonResponse({ number: 1 }));
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    await client.getPullRequest({ owner: 'acme corp', repo: 'my repo', pullNumber: 1 });
    assert.equal(
      calls[0].url,
      'https://api.github.com/repos/acme%20corp/my%20repo/pulls/1'
    );
  });

  it('throws GitHubApiError with status and body on non-2xx', async () => {
    const { fetchImpl } = recordingFetch(textResponse('Not Found', { status: 404 }));
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    await assert.rejects(
      client.getPullRequest({ owner: 'acme', repo: 'ghost', pullNumber: 1 }),
      (err) =>
        err instanceof GitHubApiError &&
        err.code === 'GITHUB_API_ERROR' &&
        err.status === 404 &&
        /404/.test(err.message)
    );
  });

  it('wraps transport failures in GitHubApiError', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    await assert.rejects(
      client.getPullRequestDiff({ owner: 'acme', repo: 'widgets', pullNumber: 3 }),
      (err) => err instanceof GitHubApiError && /ECONNRESET/.test(err.message)
    );
  });

  it('lets getToken failures propagate without calling fetch', async () => {
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return jsonResponse({});
    };
    const client = createGithubClient({
      getToken: async () => {
        throw new Error('token expired');
      },
      fetchImpl,
    });

    await assert.rejects(
      client.getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 1 }),
      /token expired/
    );
    assert.equal(fetched, false);
  });

  it('validates the pull number before any request', async () => {
    const { calls, fetchImpl } = recordingFetch(jsonResponse({}));
    const client = createGithubClient({ getToken: async () => TOKEN, fetchImpl });

    await assert.rejects(
      client.getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 0 }),
      TypeError
    );
    await assert.rejects(
      client.getPullRequestDiff({ owner: 'acme', repo: 'widgets', pullNumber: '42' }),
      TypeError
    );
    assert.equal(calls.length, 0);
  });
});

describe('parseRepoSpec', () => {
  it('splits owner/repo', () => {
    assert.deepEqual(parseRepoSpec('acme/widgets'), { owner: 'acme', repo: 'widgets' });
    assert.deepEqual(parseRepoSpec(' acme / widgets '), { owner: 'acme', repo: 'widgets' });
  });

  it('rejects anything that is not exactly owner/repo', () => {
    assert.throws(() => parseRepoSpec('widgets'), TypeError);
    assert.throws(() => parseRepoSpec('a/b/c'), TypeError);
    assert.throws(() => parseRepoSpec(''), TypeError);
    assert.throws(() => parseRepoSpec(undefined), TypeError);
  });
});
