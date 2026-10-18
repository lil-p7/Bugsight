#!/usr/bin/env node
/**
 * Review a local file from the command line:
 *   npm run review:file -- path/to/file.js
 *
 * Useful for iterating on prompts and checking review quality without
 * needing GitHub.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { reviewCode } from '../src/services/openai.service.js';

const LANGUAGE_BY_EXT = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.rs': 'rust',
};

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  fail('Usage: npm run review:file -- <path-to-file>');
}

const absolute = path.resolve(target);
let code;
try {
  code = await readFile(absolute, 'utf8');
} catch (err) {
  fail(`Could not read ${target}: ${err.message}`);
}

const language = LANGUAGE_BY_EXT[path.extname(absolute)] ?? 'text';
const filePath = path.relative(process.cwd(), absolute) || target;

console.log(`Reviewing ${filePath} (${language})...\n`);

let result;
try {
  result = await reviewCode({ code, language, filePath });
} catch (err) {
  fail(err.message);
}

const { findings, rejected, usage } = result;

if (findings.length === 0) {
  console.log('No findings. 🎉');
} else {
  for (const finding of findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.log(
      `[${finding.severity.toUpperCase()}] (${finding.category}, confidence ${finding.confidence.toFixed(2)}) ${finding.title}`
    );
    console.log(`  at ${location}`);
    console.log(`  ${finding.explanation}`);
    console.log(`  Suggestion: ${finding.suggestion}\n`);
  }
}

if (rejected.length > 0) {
  console.log(`\n${rejected.length} finding(s) rejected by validation:`);
  for (const item of rejected) {
    console.log(`  - ${item.reason}`);
  }
}

if (usage?.total_tokens != null) {
  console.log(`\nTokens used: ${usage.total_tokens}`);
}