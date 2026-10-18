/**
 * Deliberately buggy snippets used to test the review engine (Phase 1 exit
 * criteria). Each entry is small, self-contained, and contains at least one
 * real defect plus several red herrings that should NOT be reported.
 *
 * `expected` lists what a good review should catch; it is guidance for the
 * human reading the output, not an assertion (the model's exact wording and
 * severity will vary).
 */

export const buggySnippets = [
  {
    id: 'sql-injection',
    description: 'User input concatenated into a SQL query',
    language: 'javascript',
    path: 'src/users.js',
    expected: ['SQL injection via string concatenation (security)'],
    code: `export function findUser(db, username) {
  const query = "SELECT * FROM users WHERE name = '" + username + "'";
  return db.query(query);
}
`,
  },
  {
    id: 'json-parse-null',
    description: 'Unchecked JSON.parse result and unhandled failure',
    language: 'javascript',
    path: 'src/config.js',
    expected: [
      'JSON.parse can throw on malformed input (bug)',
      'settings.cacheTtl is read without checking the parsed value (bug / logic)',
    ],
    code: `export function loadSettings(raw) {
  const settings = JSON.parse(raw);
  const ttl = settings.cacheTtl.value;
  return ttl;
}
`,
  },
  {
    id: 'off-by-one',
    description: 'Loop reads one element past the end of the array',
    language: 'javascript',
    path: 'src/cart.js',
    expected: ['Off-by-one: items[i] is undefined on the last iteration (bug)'],
    code: `export function totalPrice(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total;
}
`,
  },
  {
    id: 'missing-await',
    description: 'Async write not awaited, then the result is used',
    language: 'javascript',
    path: 'src/queue.js',
    expected: [
      'processQueue resolves before tasks finish; results undefined (bug)',
      'Rejected task promise is not handled (bug / logic)',
    ],
    code: `export async function processQueue(tasks) {
  const results = tasks.map(async (task) => {
    throwIfInvalid(task);
    return save(task);
  });
  return results.map((r) => r.value);
}

function throwIfInvalid(task) {
  if (!task.id) throw new Error('missing id');
}

function save(task) {
  return Promise.resolve({ ok: true, task });
}
`,
  },
  {
    id: 'performance-repeated-work',
    description: 'Expensive work repeated inside a loop',
    language: 'javascript',
    path: 'src/report.js',
    expected: [
      'Rebuilding/parsing the same data on every iteration (performance)',
      'Possible branchless-ish issue: missing boundary check is NOT present here, should not be invented',
    ],
    code: `export function buildRows(records, template) {
  const rows = [];
  for (const record of records) {
    const config = JSON.parse(JSON.stringify(template));
    config.id = record.id;
    rows.push(config);
  }
  return rows;
}
`,
  },
];

export default buggySnippets;