/**
 * The countable claims, derived from the code rather than from prose.
 *
 * Shared by `sync-facts.mjs` (rewrites the claims in this repo) and
 * `check-skill-sync.mjs` (verifies the standalone skill repo repeats the same
 * numbers). Deriving them twice is how they drifted in the first place.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

const routeLine = /^app\.(get|post|put|delete|patch)\('([^']+)'/gm;

export function routes() {
  const found = [];
  const src = read('src/http-wrapper.ts');
  for (const m of src.matchAll(routeLine)) found.push(`${m[1].toUpperCase()} ${m[2]}`);
  return [...new Set(found)].sort();
}

export function toolNames() {
  const src = read('src/tools/index.ts');
  return [...new Set([...src.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

export function nodeFloor() {
  const pkg = JSON.parse(read('package.json'));
  const match = /(\d+)/.exec(pkg.engines?.node ?? '');
  if (!match) throw new Error('package.json has no engines.node to read');
  return match[1];
}

export const ENDPOINTS = routes().length;
export const TOOLS = toolNames().length;
export const NODE = nodeFloor();
