#!/usr/bin/env node
/**
 * Phase 1 exit criteria harness: run the reviewer against several
 * deliberately buggy snippets and print what it catches.
 *
 *   npm run review:bugsnips
 *
 * Requires OPENAI_API_KEY (see .env.example).
 */
import { buggySnippets } from '../tests/fixtures/buggy-snippets.js';
import { getOpenAIConfig } from '../src/config/env.js';
import { reviewCode } from '../src/services/openai.service.js';

try {
  getOpenAIConfig();
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error('Hint: copy .env.example to .env and set OPENAI_API_KEY.');
  process.exit(1);
}

let totalFindings = 0;
let totalRejected = 0;
let totalTokens = 0;

for (const snippet of buggySnippets) {
  console.log('='.repeat(72));
  console.log(`${snippet.id} — ${snippet.description}`);
  console.log(`Expected: ${snippet.expected.join('; ')}`);
  console.log('-'.repeat(72));

  try {
    const { findings, rejected, usage } = await reviewCode({
      code: snippet.code,
      language: snippet.language,
      filePath: snippet.path,
      context: 'Isolated test snippet from the review-quality test suite.',
    });

    totalFindings += findings.length;
    totalRejected += rejected.length;
    totalTokens += usage?.total_tokens ?? 0;

    if (findings.length === 0) {
      console.log('No findings returned.');
    }
    for (const finding of findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.log(
        `- [${finding.severity.toUpperCase()}/${finding.category} ${finding.confidence.toFixed(2)}] ${finding.title} (${location})`
      );
      console.log(`  ${finding.explanation}`);
      console.log(`  Fix: ${finding.suggestion}`);
    }
    if (rejected.length > 0) {
      console.log(`  (${rejected.length} invalid finding(s) rejected)`);
    }
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  }
  console.log('');
}

console.log('='.repeat(72));
console.log(
  `Total: ${totalFindings} findings, ${totalRejected} rejected, ${totalTokens} tokens`
);