#!/usr/bin/env node
/**
 * Production dependency audit with reviewed exceptions.
 *
 * `npm audit --audit-level=moderate` is the bar. Some advisories have no fixed
 * version upstream, and the only "fix" npm offers is a major downgrade that
 * costs more than it buys. Lowering the global level would hide the next real
 * one, so each such advisory is listed here instead: named, justified, and
 * given a review date. An exception that outlives its date fails the build, so
 * it has to be looked at again rather than quietly inherited.
 */

import { execFileSync } from 'child_process';

/**
 * Each entry: why this advisory cannot reach us, and when to look again.
 * Remove an entry the moment a patched version exists.
 */
const REVIEWED = {
  // Empty by design. The four file-search advisories that lived here went away
  // with the globber itself in 4.1.0 — Node 22's built-in search replaced it.
  // Add an entry only for an advisory with no upstream fix, and say why it
  // cannot reach us.
};

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const MIN_LEVEL = process.env.AUDIT_LEVEL ?? 'moderate';

function runAudit() {
  try {
    return JSON.parse(
      execFileSync('npm', ['audit', '--omit=dev', '--json'], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      })
    );
  } catch (error) {
    // npm exits non-zero whenever it finds anything; the report is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

const report = runAudit();
const found = Object.entries(report.vulnerabilities ?? {}).filter(
  ([, v]) => LEVELS.indexOf(v.severity) >= LEVELS.indexOf(MIN_LEVEL)
);

const unreviewed = found.filter(([name]) => !REVIEWED[name]);
const expired = found.filter(
  ([name]) => REVIEWED[name] && new Date(REVIEWED[name].reviewBy) < new Date()
);

for (const [name, v] of found) {
  const entry = REVIEWED[name];
  const mark = !entry ? '✗' : new Date(entry.reviewBy) < new Date() ? '⏰' : '✓';
  console.log(`${mark} ${name} (${v.severity}) ${entry ? `— reviewed, by ${entry.reviewBy}` : ''}`);
}

if (unreviewed.length) {
  console.error(
    `\n${unreviewed.length} unreviewed advisory/advisories at ${MIN_LEVEL}+: ` +
      unreviewed.map(([n]) => n).join(', ') +
      `\nFix them, or add an entry to REVIEWED in scripts/audit-check.mjs saying why they cannot reach us.`
  );
  process.exit(1);
}

if (expired.length) {
  console.error(
    `\n${expired.length} exception(s) past their review date: ` + expired.map(([n]) => n).join(', ')
  );
  process.exit(1);
}

console.log(`\nNo unreviewed advisories at ${MIN_LEVEL} or above.`);
