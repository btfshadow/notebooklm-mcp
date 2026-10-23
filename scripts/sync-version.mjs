#!/usr/bin/env node
/**
 * Sync the version from package.json to every other file that ships it:
 *   - .claude-plugin/plugin.json   (Claude Code plugin manifest)
 *   - website/docusaurus.config.ts (schema.org softwareVersion)
 *   - README.md                    (hero "v1.x.x — ..." line)
 *   - server.json                  (MCP Registry manifest, two fields)
 *   - deployment/docs/openapi.yaml (REST spec info.version)
 *   - website/static/llms.txt      (the AI-facing entry point)
 *   - ROADMAP.md                   ("## Current Version" header)
 *
 * Usage:
 *   node scripts/sync-version.mjs           # rewrite drifted files in place
 *   node scripts/sync-version.mjs --check   # exit 1 if anything would change (CI guard)
 *
 * Run after bumping package.json. The CI release workflow runs --check so a
 * release can never ship with a stale plugin manifest or website badge.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;
if (!VERSION) {
  console.error('package.json has no version field');
  process.exit(2);
}

/** @type {Array<{path: string, label: string, transform: (s: string) => string}>} */
const targets = [
  {
    path: '.claude-plugin/plugin.json',
    label: 'plugin manifest',
    // Regex replace (not reparse+reserialize) so prettier-controlled
    // formatting decisions (e.g. keywords array on one line vs many) are
    // preserved between releases and don't trigger phantom drift.
    //
    // We rewrite TWO things in this file:
    //   1. The top-level "version" field — what /plugin Discover shows.
    //   2. The npx version pin in mcpServers.notebooklm.args — what the MCP
    //      runtime actually downloads. Pinning is required because npx -y
    //      without a version reuses the _npx/<hash>/ cache and ignores newly
    //      published releases until the cache is manually purged. By pinning
    //      to the same version /plugin update just installed, we force npx
    //      to fetch (or use the matching cache) for that exact version.
    transform: (s) =>
      s
        .replace(/^(\s*"version":\s*)"\d+\.\d+\.\d+"/m, `$1"${VERSION}"`)
        .replace(
          /"@roomi-fields\/notebooklm-mcp(?:@\d+\.\d+\.\d+)?"/,
          `"@roomi-fields/notebooklm-mcp@${VERSION}"`
        ),
  },
  {
    path: 'website/docusaurus.config.ts',
    label: 'docusaurus softwareVersion',
    transform: (s) => s.replace(/softwareVersion:\s*'[^']+'/, `softwareVersion: '${VERSION}'`),
  },
  {
    path: 'README.md',
    label: 'README hero version',
    transform: (s) => s.replace(/(>\s*v)\d+\.\d+\.\d+(\s+—)/, `$1${VERSION}$2`),
  },
  {
    path: 'server.json',
    label: 'MCP Registry server manifest',
    // Two "version" fields (top-level + the npm package entry) must both track
    // package.json, or the published registry entry drifts (it sat at 1.5.9
    // while the package shipped 3.0.0). Global replace hits both; the "$schema"
    // URL has no "version" key so it is untouched.
    transform: (s) => s.replace(/("version":\s*)"\d+\.\d+\.\d+"/g, `$1"${VERSION}"`),
  },
  {
    path: 'website/static/llms.txt',
    label: 'llms.txt version line',
    // The one file written for AI answer engines, and the one that had
    // drifted furthest: it still announced 1.5.9 and "33 endpoints" while
    // the package shipped 4.1.0 with 45 — so engines quoting us repeated a
    // version six releases old. Nothing else was syncing it.
    transform: (s) => s.replace(/(current version )\d+\.\d+\.\d+/, `$1${VERSION}`),
  },
  {
    path: 'website/static/.well-known/ai-catalog.json',
    label: 'AI catalog entry version',
    // The catalog states the server's version itself, and the AI Catalog spec
    // makes a present entry version authoritative for latest-selection — a
    // stale one there is a publishing error that breaks exactly the discovery
    // the file exists for.
    transform: (s) => s.replace(/("version":\s*)"\d+\.\d+\.\d+"/g, `$1"${VERSION}"`),
  },
  {
    path: 'deployment/docs/openapi.yaml',
    label: 'OpenAPI info.version',
    // The published REST spec carries its own version and had drifted to
    // 1.5.9 while the package shipped 3.0.x — consumers generating a client
    // from it were told they were on a two-major-versions-old API.
    transform: (s) => s.replace(/(^info:\n(?:.*\n)*?  version:\s*)\d+\.\d+\.\d+/m, `$1${VERSION}`),
  },
  {
    path: 'ROADMAP.md',
    label: 'ROADMAP current version',
    // The "## Current Version" header drifted to 1.5.4 while the package shipped
    // 3.0.x. Kept in lockstep here (and enforced by version:check in CI).
    transform: (s) => s.replace(/(## Current Version:\s*v)\d+\.\d+\.\d+/, `$1${VERSION}`),
  },
];

let drifted = 0;
for (const target of targets) {
  const fullPath = join(ROOT, target.path);
  const original = readFileSync(fullPath, 'utf-8');
  const updated = target.transform(original);

  if (original === updated) {
    console.log(`✓ ${target.path} already at ${VERSION} (${target.label})`);
    continue;
  }

  drifted++;
  if (checkOnly) {
    console.error(`✗ DRIFT in ${target.path} (${target.label})`);
  } else {
    writeFileSync(fullPath, updated, 'utf-8');
    console.log(`→ ${target.path} synced to ${VERSION} (${target.label})`);
  }
}

if (checkOnly && drifted > 0) {
  console.error(
    `\n${drifted} file(s) out of sync with package.json@${VERSION}. ` +
      `Run "npm run version:sync" locally and commit.`
  );
  process.exit(1);
}

if (!checkOnly) {
  console.log(
    drifted === 0
      ? `\nAll files already at ${VERSION}.`
      : `\nSynced ${drifted} file(s) to ${VERSION}.`
  );
}
