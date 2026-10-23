/**
 * The AI Catalog we publish at `/.well-known/ai-catalog.json` is read by
 * machines that will never see a build log, so a malformed or dishonest entry
 * fails silently and for a long time.
 *
 * SEP-2127 points domain-level discovery at this file; the format itself is
 * the AI Catalog spec (https://github.com/Agent-Card/ai-catalog). These lock
 * the parts a careless edit breaks: the required members, one artifact source
 * per entry, and the version the spec treats as authoritative for picking the
 * latest — which must therefore equal the version we actually ship.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

interface CatalogEntry {
  identifier: string;
  type: string;
  url?: string;
  data?: unknown;
  version?: string;
  displayName?: string;
  description?: string;
  tags?: string[];
}

interface Catalog {
  specVersion: string;
  host?: { displayName: string; identifier?: string; documentationUrl?: string };
  entries: CatalogEntry[];
}

const catalog = JSON.parse(read('website/static/.well-known/ai-catalog.json')) as Catalog;
const pkg = JSON.parse(read('package.json')) as { version: string };

describe('the published AI catalog', () => {
  it('declares a spec version and at least one artifact', () => {
    expect(catalog.specVersion).toMatch(/^\d+\.\d+$/);
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it('names the same publisher as everything else we ship', () => {
    // Entity consistency: an artifact attributed to four different names is
    // four weak entities rather than one.
    expect(catalog.host?.displayName).toBe('roomi-fields');
  });

  it('gives every entry an identifier, a type and exactly one source', () => {
    for (const entry of catalog.entries) {
      expect(entry.identifier).toMatch(/^urn:air:roomi-fields\.com:[a-z:]+:[a-z-]+$/);
      expect(entry.type).toMatch(/^application\/[\w.+-]+$/);
      // The spec requires exactly one of `url` or `data` — both, or neither,
      // leaves a consumer with nothing to resolve.
      expect([entry.url, entry.data].filter((v) => v !== undefined)).toHaveLength(1);
    }
  });

  it('keeps identifiers unique per version', () => {
    const keys = catalog.entries.map((e) => `${e.identifier}@${e.version ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('states the version we actually ship', () => {
    const server = catalog.entries.find((e) => e.identifier.includes(':mcp:'));
    expect(server).toBeDefined();
    // A version here outranks the one in the referenced document, so a stale
    // value does not just look wrong — it makes a consumer select the wrong
    // release. `npm run version:sync` keeps it honest.
    expect(server!.version).toBe(pkg.version);
  });

  it('points only at documents that exist in our own namespaces', () => {
    for (const entry of catalog.entries) {
      if (!entry.url) continue;
      expect(entry.url).toMatch(
        /^https:\/\/(raw\.githubusercontent\.com\/roomi-fields\/|notebooklm\.roomi-fields\.com\/|registry\.modelcontextprotocol\.io\/)/
      );
    }
  });
});
