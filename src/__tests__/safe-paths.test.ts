/**
 * The guard that keeps caller-supplied paths from reaching the session store.
 *
 * Every case here is a way the previous check could be walked past: a string
 * comparison with no separator, a path checked before it was resolved, and a
 * symlink inside an allowed directory. The session-store cases are the ones
 * that mattered — the data directory was an allowed root, and it holds the
 * live Google login.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { CONFIG } from '../config.js';
import { confinePath, downloadRoots, uploadRoots } from '../utils/safe-paths.js';

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nblm-safe-paths-'));
  root = path.join(base, 'allowed');
  outside = path.join(base, 'elsewhere');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(`${root}-evil`, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
  symlinkSync(outside, path.join(root, 'link-out'), 'dir');
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

const confine = (input: string, roots: string[] | null = [root]) =>
  confinePath(input, { roots, what: 'file_path' });

describe('confinePath', () => {
  it('requires a non-empty string', () => {
    expect(() => confine('')).toThrow(/required/i);
    expect(() => confinePath(undefined, { roots: [root], what: 'file_path' })).toThrow(/required/i);
  });

  it('resolves a relative path against the first root', () => {
    expect(confine('notes/a.md')).toBe(path.join(root, 'notes', 'a.md'));
  });

  it('accepts an absolute path inside the root', () => {
    const inside = path.join(root, 'deep', 'file.pdf');
    expect(confine(inside)).toBe(inside);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => confine(path.join(outside, 'secret.txt'))).toThrow(/escapes/i);
  });

  it('rejects traversal that climbs out', () => {
    expect(() => confine('../elsewhere/secret.txt')).toThrow(/escapes/i);
  });

  it('rejects a sibling directory sharing a name prefix', () => {
    // The old check was startsWith on strings, which accepted this.
    expect(() => confine(path.join(`${root}-evil`, 'x'))).toThrow(/escapes/i);
  });

  it('rejects a symlink inside the root that points out of it', () => {
    expect(() => confine(path.join(root, 'link-out', 'secret.txt'))).toThrow(/escapes/i);
  });

  it('returns the symlink-resolved path, not the path it was given', () => {
    const link = path.join(root, 'link-in');
    const target = path.join(root, 'real');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'dir');
    expect(confine(path.join(link, 'f.txt'))).toBe(path.join(target, 'f.txt'));
  });
});

describe('the session store is never reachable', () => {
  const secrets = [
    CONFIG.browserStateDir,
    CONFIG.chromeProfileDir,
    CONFIG.chromeInstancesDir,
    path.join(CONFIG.dataDir, 'accounts.json'),
  ];

  it.each(secrets)('refuses %s even when the data directory is an allowed root', (secret) => {
    expect(() => confinePath(secret, { roots: [CONFIG.dataDir], what: 'file_path' })).toThrow(
      /session store/i
    );
  });

  it('refuses a file inside the browser state directory', () => {
    const inside = path.join(CONFIG.browserStateDir, 'state.json');
    expect(() => confinePath(inside, { roots: [CONFIG.dataDir], what: 'file_path' })).toThrow(
      /session store/i
    );
  });

  it('refuses it with no containment at all, which is how the vault runs', () => {
    expect(() => confinePath(CONFIG.chromeProfileDir, { roots: null, what: 'vault_dir' })).toThrow(
      /session store/i
    );
  });

  it('still allows the rest of the data directory', () => {
    const ok = path.join(CONFIG.dataDir, 'report.pdf');
    expect(confinePath(ok, { roots: [CONFIG.dataDir], what: 'output_path' })).toBe(ok);
  });
});

describe('roots', () => {
  afterAll(() => {
    delete process.env.NOTEBOOKLM_UPLOAD_ROOT;
    delete process.env.NOTEBOOKLM_DOWNLOAD_ROOT;
  });

  it('default to the working directory and the data directory', () => {
    delete process.env.NOTEBOOKLM_UPLOAD_ROOT;
    delete process.env.NOTEBOOKLM_DOWNLOAD_ROOT;
    expect(uploadRoots()).toEqual([process.cwd(), CONFIG.dataDir]);
    expect(downloadRoots()).toEqual([process.cwd(), CONFIG.dataDir]);
  });

  it('narrow to the configured directory when the operator sets one', () => {
    process.env.NOTEBOOKLM_UPLOAD_ROOT = root;
    process.env.NOTEBOOKLM_DOWNLOAD_ROOT = outside;
    expect(uploadRoots()).toEqual([root]);
    expect(downloadRoots()).toEqual([outside]);
  });
});
