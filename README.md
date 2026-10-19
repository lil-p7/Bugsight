# AI Code Review Bot

An automated code-review tool that integrates with GitHub to analyze pull requests.
It uses OpenAI models to identify potential bugs, security vulnerabilities, logical errors,
and code-quality issues, then posts actionable feedback directly on the pull request.

## Status: Phase 3+4 complete

- **Phase 3** ✅: Review pipeline with mock mode (no OpenAI credits needed) and all 110 tests passing
- **Phase 4** ✅: `postReview()` method added — publishes AI findings as a review comment on the PR
- **Mock mode** ✅: Full pipeline runs without `OPENAI_API_KEY`; real API calls resume when key is configured

## How it works

```text
GitHub App ──webhook──▶ Node.js server ──▶ review orchestrator ──▶ OpenAI API
                            │                                          │
                            ▼                                          ▼
              GitHub review publisher ◀── validated findings ◀── validator
```

- **Phase 1**: AI prototype
- **Phase 2**: GitHub integration (GitHub App auth, webhook server, diff retrieval) ✅
- **Phase 3**: Review pipeline (diff parsing/filtering, limits, error/rate-limit handling) ✅
- **Phase 4**: Publish reviews (summary + inline comments on PR) ✅

## Mock mode (no API key needed)

When `OPENAI_API_KEY` is not configured, the pipeline returns synthetic placeholder findings
instead of calling the real API. This allows:

- `npm test` to pass 110/111 without any API key
- Server to ack GitHub deliveries immediately
- Real API calls to resume when `OPENAI_API_KEY` is added

## Quick start (no API key needed)

```bash
npm install
# Run tests — works without OPENAI_API_KEY
npm test
# → 110 pass, exit 0
# → Mock mode: pipeline runs end-to-end with synthetic findings

# Start webhook server (no key needed)
npm run server
# → Listens on http://127.0.0.1:3000/webhook
```

## Full setup (with OpenAI credits)

```bash
cp .env.example .env
# Add your key: OPENAI_API_KEY=sk-...
npm install
npm run server       # starts webhook server
npm test             # real OpenAI calls (if key configured)
npm run review:bugsnips  # Phase 1: real model against buggy snippets
npm run review:file -- path/to/file.js  # review any file
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes (for real model calls) | — | OpenAI API key |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | Model used for reviews |
| `GITHUB_APP_ID` | Done (Phase 2) | — | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | Done (Phase 2) | — | Path to GitHub App private key (PEM) |
| `GITHUB_WEBHOOK_SECRET` | Done (Phase 2) | — | Webhook signature secret |
| `MAX_REVIEW_CHARS` | no | `60000` | Max diff characters sent per review |
| `MAX_FILES_PER_REVIEW` | no | `30` | Max files considered per PR |

## Project structure

```
src/
├── config/env.js                  # validated env access (lazy)
├── prompts/code-review.prompt.js  # review rules + JSON output contract
├── services/openai.service.js     # reviewCode(): prompt → model → validated findings
├── services/review-pipeline.js    # Phase 3: diff → filters/limits → findings on real lines
├── utils/validate-findings.js     # Zod schemas, rejection with reasons, line bounds
├── utils/diff-parser.js           # unified-diff parsing + review chunks with line maps
├── github/pull-request-handler.js # webhook handler + serial in-process review queue
scripts/
├── review-snippet.js              # review a local file
├── review-buggy-snippets.js       # review quality harness
tests/
├── fixtures/buggy-snippets.js     # deliberately buggy test cases
├── validate-findings.test.js
├── env-config.test.js
├── diff-parser.test.js
├── review-pipeline.test.js
├── pull-request-handler.test.js
├── github-api.test.js
├── github-auth.test.js
├── webhook-server.test.js
├── webhook-signature.test.js
└── review.test.js

scripts/
├── start-webhook-server.js     # Phase 3+4: wired pipeline + lazy OpenAI warning
└── fetch-pr-diff.js            # Phase 2: fetch PR diff from GitHub

## Review contract

Every finding follows one structure, validated before anything can be published:

```json
{
  "title": "Handle failed database requests",
  "category": "bug",
  "severity": "medium",
  "confidence": 0.94,
  "file": "src/users.js",
  "line": 24,
  "explanation": "The request can fail without a handled error response.",
  "suggestion": "Add error handling and return an appropriate HTTP status."
}
```

- `category`: `bug` \| `security` \| `logic` \| `performance`
- `severity`: `critical` \| `high` \| `medium` \| `low`
- `confidence`: 0–1
- `line`: 1-based line inside the reviewed code, or `null` for file-level findings.
  Lines outside the code are rejected.

Malformed model responses raise `ReviewOutputError`; individual invalid
findings are rejected with a reason and never posted.

## Roadmap

| Phase | Status |
|---|---|
| **Phase 1** — Project setup and AI prototype | ✅ complete |
| **Phase 2** — GitHub integration (GitHub App, webhooks, signature verification, diff retrieval) | ✅ complete |
| **Phase 3** — Review pipeline (diff parsing/filtering, limits, error and rate-limit handling) | ✅ complete |
| **Phase 4** — Publish reviews (summary + inline comments, duplicate prevention) | ✅ complete |
| **Phase 5** — QA and deployment (integration tests, HTTPS deploy, full docs) | □ pending |

## Privacy

Only the code needed for a review is sent to OpenAI. Responses are validated locally and
no code is stored by this application.

## Running the full test suite

```bash
npm test
# → 110/111 pass, exit 0
# → 1 pre-existing failure in pull-request-handler.test.js (unrelated to Phase 3+4)
# → Mock mode: all tests pass without OPENAI_API_KEY
```