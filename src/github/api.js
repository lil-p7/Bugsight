/**
 * Thin GitHub REST client for what Phase 2 needs: pull-request metadata and
 * the raw unified diff. Review publishing (PR comments) lands in Phase 4.
 *
 * Auth is delegated to an async getToken() (see app-auth.js) so tokens are
 * fetched lazily and cached; fetch is injectable for tests.
 */
import {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_USER_AGENT,
  GITHUB_API_VERSION,
} from './app-auth.js';

export { GITHUB_API_VERSION, DEFAULT_GITHUB_API_BASE_URL, DEFAULT_USER_AGENT };

/** Non-2xx or transport failure while talking to the GitHub API. */
export class GitHubApiError extends Error {
  constructor(message, { status = null, url = null, body = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubApiError';
    this.code = 'GITHUB_API_ERROR';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Parse an "owner/repo" CLI-style spec. */
export function parseRepoSpec(spec) {
  const parts = String(spec ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length !== 2) {
    throw new TypeError(`Expected "<owner>/<repo>", got "${spec}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function assertPullNumber(pullNumber) {
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new TypeError(`pullNumber must be a positive integer, got ${pullNumber}`);
  }
}

/**
 * @param {object} params
 * @param {() => Promise<string>} params.getToken - returns an installation token
 * @param {typeof fetch} [params.fetchImpl]
 * @param {string} [params.apiBaseUrl]
 * @param {string} [params.userAgent]
 */
export function createGithubClient({
  getToken,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  if (typeof getToken !== 'function') {
    throw new TypeError('createGithubClient requires an async getToken() function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createGithubClient requires a fetch implementation');
  }

  /** @param {string} path - API path starting with "/" (or an absolute URL)
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {string} [options.accept]
   * @param {Record<string, string>} [options.headers]
   * @returns {Promise<Response>}
   * @throws {GitHubApiError}
   */
  async function request(path, { method = 'GET', accept = 'application/vnd.github+json', headers = {} } = {}) {
    const token = await getToken();
    const url = path.startsWith('http') ? path : `${apiBaseUrl}${path}`;

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': userAgent,
          ...headers,
        },
      });
    } catch (err) {
      throw new GitHubApiError(`GitHub API request to ${url} failed: ${err.message}`, {
        url,
        cause: err,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GitHubApiError(
        `GitHub API ${method} ${url} returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
        { status: res.status, url, body }
      );
    }
    return res;
  }

  function pullPath(owner, repo, pullNumber) {
    assertPullNumber(pullNumber);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
  }

  return {
    request,

    /** Pull-request metadata: state, title, head/base SHAs, draft flag, etc. @param {{ owner: string, repo: string, pullNumber: number }} params @returns {Promise<object>} */
    async getPullRequest({ owner, repo, pullNumber }) {
      const res = await request(pullPath(owner, repo, pullNumber));
      return res.json();
    },

    /** Post a review with findings to the pull request. @param {{ owner: string, repo: string, pullNumber: number, findings: Array<object>, event?: string }} params @param {string} [params.event] - review event (COMMAND, APPROVE, REQUEST_CHANGES) @returns {Promise<object>} GitHub API response */
    async postReview({ owner, repo, pullNumber, findings, event = 'COMMENT' }) {
      // Sort findings by severity
      const sorted = findings.sort((a, b) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        return (severityOrder[b.severity] ?? 0) - (severityOrder[a.severity] ?? 0) ||
          (b.confidence ?? 0) - (a.confidence ?? 0);
      });

      // Group findings by file
      const byFile = {};
      for (const f of sorted) {
        const file = f.file || 'untitled';
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push(f);
      }

      // Build a summary body from findings
      const bodyLines = sorted.map((f) => {
        const severityIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[f.severity] || '⚪';
        const lineRef = f.line != null ? ` (line ${f.line})` : '';
        return `- **${severityIcon} ${f.title}** (${f.severity}${lineRef}): ${f.explanation || ''} ${f.suggestion || ''}`.trim();
      });

      const body = `## Code Review Findings\n\n${bodyLines.join('\n\n')}\n\n*Generated by AI Code Review Bot*`;

      const requestBody = {
        event,
        body,
        comments: Object.entries(byFile).map(([file, fileFindings]) => ({
          path: file,
          line: fileFindings[0]?.line != null ? fileFindings[0].line : 1,
        })),
      };

      const res = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        requestBody
      );
      return res.json();
    },

    /** The raw unified diff of the pull request (the same bytes `git diff` would show), parsed in Phase 3. @param {{ owner: string, repo: string, pullNumber: number }} params @returns {Promise<string>} */
    async getPullRequestDiff({ owner, repo, pullNumber }) {
      const res = await request(pullPath(owner, repo, pullNumber), {
        accept: 'application/vnd.github.v3.diff',
      });
      return res.text();
    },
  };
}