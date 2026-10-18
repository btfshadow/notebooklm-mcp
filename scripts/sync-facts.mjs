#!/usr/bin/env node
/**
 * Keep the countable claims in the docs equal to what the code actually does.
 *
 * `sync-version.mjs` keeps the version string in step. This keeps the facts:
 * how many REST endpoints exist, how many MCP tools, and which Node version is
 * required. Those drifted badly and silently — we advertised "33 endpoints" in
 * six places while shipping 45, and an AI answer engine quoted the stale figure
 * back at a user. The llms.txt written specifically for those engines was six
 * releases out of date.
 *
 * It also checks coverage: every route declared in the server must appear in
 * the REST reference and in the OpenAPI spec. A new endpoint that nobody
 * documents now fails the build instead of going unnoticed for a year.
 *
 * Usage:
 *   node scripts/sync-facts.mjs           # rewrite drifted claims in place
 *   node scripts/sync-facts.mjs --check   # exit 1 if anything would change
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

// ---------------------------------------------------------------- the facts

const routeLine = /^app\.(get|post|put|delete|patch)\('([^']+)'/gm;

function routes() {
  const found = [];
  const src = read('src/http-wrapper.ts');
  for (const m of src.matchAll(routeLine)) found.push(`${m[1].toUpperCase()} ${m[2]}`);
  return [...new Set(found)].sort();
}

function toolNames() {
  const src = read('src/tools/index.ts');
  return [...new Set([...src.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

function nodeFloor() {
  const pkg = JSON.parse(read('package.json'));
  const match = /(\d+)/.exec(pkg.engines?.node ?? '');
  if (!match) throw new Error('package.json has no engines.node to read');
  return match[1];
}

const ENDPOINTS = routes().length;
const TOOLS = toolNames().length;
const NODE = nodeFloor();

// --------------------------------------------------------------- the claims

/** Each rule rewrites the number inside a phrase, never the phrase itself. */
const TARGETS = [
  {
    path: 'README.md',
    rules: [
      [/\b\d+-endpoint HTTP REST API/g, `${ENDPOINTS}-endpoint HTTP REST API`],
      [/\bThe \d+-endpoint REST API/g, `The ${ENDPOINTS}-endpoint REST API`],
      [/\(\d+ endpoints\)/g, `(${ENDPOINTS} endpoints)`],
      [/Node\.js->=\d+-green/g, `Node.js->=${NODE}-green`],
      [/Node ≥ \d+ required/g, `Node ≥ ${NODE} required`],
    ],
  },
  {
    path: 'website/static/llms.txt',
    rules: [
      [/\b\d+ documented HTTP endpoints/g, `${ENDPOINTS} documented HTTP endpoints`],
      [/all \d+ HTTP endpoints/g, `all ${ENDPOINTS} HTTP endpoints`],
      [/Node \d+ or newer/g, `Node ${NODE} or newer`],
    ],
  },
  {
    path: 'deployment/docs/03-API.md',
    rules: [
      [/— \d+ HTTP endpoints/g, `— ${ENDPOINTS} HTTP endpoints`],
      [/## Available Endpoints \(\d+ total\)/g, `## Available Endpoints (${ENDPOINTS} total)`],
      [/All \d+ endpoints the server exposes/g, `All ${ENDPOINTS} endpoints the server exposes`],
      [/carries the same \d+/g, `carries the same ${ENDPOINTS}`],
    ],
  },
  {
    path: 'website/scripts/sync-docs.mjs',
    rules: [
      [/— \d+ HTTP endpoints/g, `— ${ENDPOINTS} HTTP endpoints`],
      [/NotebookLM, \d+ endpoints:/g, `NotebookLM, ${ENDPOINTS} endpoints:`],
    ],
  },
];

// -------------------------------------------------------------- the rewrite

let drifted = 0;

for (const { path, rules } of TARGETS) {
  const before = read(path);
  let after = before;
  for (const [pattern, replacement] of rules) after = after.replace(pattern, replacement);

  if (after === before) {
    console.log(`✓ ${path} already current`);
    continue;
  }
  drifted += 1;
  if (CHECK) {
    console.error(`✗ DRIFT in ${path}`);
  } else {
    writeFileSync(join(ROOT, path), after);
    console.log(`→ updated ${path}`);
  }
}

// ------------------------------------------------------------- the coverage

const declared = routes();

const reference = read('deployment/docs/03-API.md');
const documented = new Set(
  [...reference.matchAll(/^### `(GET|POST|PUT|DELETE|PATCH) ([^`?]+)/gm)].map(
    (m) => `${m[1]} ${m[2].trim()}`
  )
);

const spec = read('deployment/docs/openapi.yaml');
const specified = new Set();
{
  let path = null;
  for (const line of spec.split('\n')) {
    const p = /^ {2}(\/[^:]*):/.exec(line);
    if (p) path = p[1];
    const m = /^ {4}(get|post|put|delete|patch):/.exec(line);
    if (m && path) specified.add(`${m[1].toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
  }
}

const undocumented = declared.filter((r) => !documented.has(r));
const unspecified = declared.filter((r) => !specified.has(r));

if (undocumented.length) {
  console.error(`\n✗ ${undocumented.length} route(s) missing from the REST reference:`);
  undocumented.forEach((r) => console.error(`    ${r}`));
}
if (unspecified.length) {
  console.error(`\n✗ ${unspecified.length} route(s) missing from the OpenAPI spec:`);
  unspecified.forEach((r) => console.error(`    ${r}`));
}

console.log(
  `\n${ENDPOINTS} endpoints · ${TOOLS} MCP tools · Node >= ${NODE} ` +
    `· reference covers ${declared.length - undocumented.length}/${declared.length} ` +
    `· spec covers ${declared.length - unspecified.length}/${declared.length}`
);

const failed = (CHECK && drifted) || undocumented.length || unspecified.length;
if (failed) {
  if (CHECK && drifted) console.error(`\nRun: npm run facts:sync`);
  process.exit(1);
}
