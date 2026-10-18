#!/usr/bin/env node
/**
 * Guard: the skills bundled in this repo (skills/<name>/) must stay identical to
 * their canonical standalone repo. Skills are published twice on purpose — a
 * dedicated public repo for discovery, and a bundled copy so plugin installs
 * ship them — and duplicated content drifts unless something fails loudly.
 *
 * Compares **git blob SHAs**, not bytes: the index SHA is computed on the
 * normalized (LF) content, so a CRLF working copy cannot cause false drift.
 * One API call per skill (the recursive tree), no file downloads.
 *
 * Usage:  node scripts/check-skill-sync.mjs
 * Exit 0 = in sync, 1 = drift (or the canonical repo could not be read).
 */
import { execFileSync } from 'node:child_process';

import { ENDPOINTS } from './lib/facts.mjs';

/** bundled skill dir -> canonical location in its standalone repo */
const SKILLS = [
  {
    local: 'skills/notebooklm',
    repo: 'roomi-fields/notebooklm-skill',
    ref: 'main',
    remotePrefix: 'skills/notebooklm',
    // The standalone repo's own README sits outside the bundled prefix, so the
    // blob comparison cannot see it. It restates countable claims, so check the
    // numbers against the code the same way `sync-facts.mjs` does locally.
    claims: [
      {
        file: 'README.md',
        pattern: /(\d+) REST endpoints/,
        expected: () => ENDPOINTS,
      },
    ],
  },
];

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

function localBlobs(dir) {
  // "<mode> <sha> <stage>\t<path>" for every tracked file under dir
  const out = execFileSync('git', ['ls-files', '-s', '--', dir], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    const [, sha] = meta.split(/\s+/);
    map.set(path.slice(dir.length + 1), sha);
  }
  return map;
}

async function ghJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'skill-sync-guard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${url} (${await res.text()})`);
  return res.json();
}

async function remoteText({ repo, ref }, file) {
  const { content } = await ghJson(
    `https://api.github.com/repos/${repo}/contents/${file}?ref=${ref}`
  );
  return Buffer.from(content, 'base64').toString('utf8');
}

/** The standalone repo's prose must repeat the numbers the code actually has. */
async function staleClaims(skill) {
  const stale = [];
  for (const { file, pattern, expected } of skill.claims ?? []) {
    const text = await remoteText(skill, file);
    const found = pattern.exec(text);
    const want = expected();
    if (!found) stale.push(`claim missing:  ${file} has no match for ${pattern}`);
    else if (found[1] !== String(want))
      stale.push(`claim stale:    ${file} says ${found[1]}, the code says ${want}`);
  }
  return stale;
}

async function remoteBlobs({ repo, ref, remotePrefix }) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'skill-sync-guard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${repo} (${await res.text()})`);
  const { tree } = await res.json();
  const map = new Map();
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (!entry.path.startsWith(remotePrefix + '/')) continue;
    map.set(entry.path.slice(remotePrefix.length + 1), entry.sha);
  }
  return map;
}

let drifted = 0;

for (const skill of SKILLS) {
  const local = localBlobs(skill.local);
  if (local.size === 0) {
    console.error(`✘ ${skill.local} — no tracked files found`);
    drifted++;
    continue;
  }

  let remote;
  try {
    remote = await remoteBlobs(skill);
  } catch (e) {
    console.error(`✘ ${skill.local} — cannot read canonical ${skill.repo}: ${e.message}`);
    drifted++;
    continue;
  }

  const problems = [];
  for (const [path, sha] of local) {
    if (!remote.has(path)) problems.push(`only here:      ${path}`);
    else if (remote.get(path) !== sha) problems.push(`differs:        ${path}`);
  }
  for (const path of remote.keys()) {
    if (!local.has(path)) problems.push(`only upstream:  ${path}`);
  }

  try {
    problems.push(...(await staleClaims(skill)));
  } catch (e) {
    problems.push(`cannot read the claims in ${skill.repo}: ${e.message}`);
  }

  if (problems.length) {
    drifted++;
    console.error(`✘ ${skill.local} is out of sync with ${skill.repo}:`);
    for (const p of problems) console.error(`    ${p}`);
  } else {
    console.log(`✓ ${skill.local} matches ${skill.repo} (${local.size} files)`);
  }
}

if (drifted) {
  console.error(
    `\n${drifted} skill(s) drifted. Sync the bundled copy with its canonical repo ` +
      `(the standalone repo is the source of truth), then commit.`
  );
  process.exit(1);
}
