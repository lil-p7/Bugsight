# AI Code Review Bot

An automated code-review tool that integrates with GitHub to analyze pull
requests. It uses OpenAI models to identify potential bugs, security
vulnerabilities, logical errors, and code-quality issues, then posts
actionable feedback directly on the pull request.

> **Status: Phase 1 complete (AI review prototype).** GitHub integration,
> the webhook server, and review publishing are not built yet.

## How it works (target architecture)

```
GitHub App ──webhook──▶ Node.js server ──▶ review orchestrator ──▶ OpenAI API
                            │                                          │
                            ▼                                          ▼
              GitHub review publisher ◀── validated findings ◀── validator
```

Today only the AI review engine exists and can be exercised locally from the
command line.

## Requirements

- Node.js 20+ (developed on Node 24)
- An OpenAI API key

## Setup

```bash
npm install
cp .env.example .env
# put your key in .env: OPENAI_API_KEY=sk-...
```

## Usage

Run the unit tests (no API key needed — the model client is mocked):

```bash
npm test
```

Run the reviewer against the built-in deliberately-buggy snippets
(Phase 1 exit criteria — requires `OPENAI_API_KEY`):

```bash
npm run review:bugsnips
```

Review any local file:

```bash
npm run review:file -- path/to/file.js
```

## Environment variables

| Variable          | Required | Default       | Purpose                                   |
| ----------------- | -------- | ------------- | ----------------------------------------- |
| `OPENAI_API_KEY`  | yes      | —             | OpenAI API key                            |
| `OPENAI_MODEL`    | no       | `gpt-4o-mini` | Model used for reviews                    |
| `GITHUB_APP_ID`   | Phase 2  | —             | GitHub App ID (created in Phase 2)        |
| `GITHUB_PRIVATE_KEY_PATH` | Phase 2 | —        | Path to the GitHub App private key (PEM)  |
| `GITHUB_WEBHOOK_SECRET`   | Phase 2 | —        | Webhook signature secret                  |
| `MAX_REVIEW_CHARS`        | no (Phase 3) | `60000` | Max diff characters sent per review |
| `MAX_FILES_PER_REVIEW`    | no (Phase 3) | `30`    | Max files considered per PR         |

## Project structure

```
src/
├── config/env.js                  # validated env access (lazy)
├── prompts/code-review.prompt.js  # review rules + JSON output contract
├── services/openai.service.js     # reviewCode(): prompt → model → validated findings
├── utils/validate-findings.js     # Zod schemas, rejection with reasons, line bounds
scripts/
├── review-snippet.js              # review a local file
├── review-buggy-snippets.js       # review quality harness
tests/
├── fixtures/buggy-snippets.js     # deliberately buggy test cases
├── validate-findings.test.js
└── review.test.js
```

## Review contract

Every finding follows one structure, validated before anything can be
published:

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

- `category`: `bug` | `security` | `logic` | `performance`
- `severity`: `critical` | `high` | `medium` | `low`
- `confidence`: 0–1
- `line`: 1-based line inside the reviewed code, or `null` for file-level
  findings. Lines outside the code are rejected.

Malformed model responses raise `ReviewOutputError`; individual invalid
findings are rejected with a reason and never posted.

## Roadmap

- [x] **Phase 1** — Project setup and AI prototype
- [ ] **Phase 2** — GitHub integration (GitHub App, webhooks, signature
      verification, diff retrieval)
- [ ] **Phase 3** — Review pipeline (diff parsing/filtering, limits,
      error and rate-limit handling)
- [ ] **Phase 4** — Publish reviews (summary + inline comments, duplicate
      prevention)
- [ ] **Phase 5** — QA and deployment (integration tests, HTTPS deploy,
      full docs)

## Privacy

Only the code needed for a review is sent to OpenAI. Responses are validated
locally and no code is stored by this application.