/**
 * The file search behind cleanup scanning. It replaced a third-party globber
 * in 4.1.0 and had no coverage at all before that — the suite passed either
 * way, which is exactly why this exists.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { findPaths } from '../utils/cleanup-manager.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nblm-find-'));
  await fs.mkdir(path.join(root, 'a', 'node_modules', 'notebooklm-mcp'), { recursive: true });
  await fs.mkdir(path.join(root, 'b', 'node_modules', 'other-pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'logs', 'exthost'), { recursive: true });
  await fs.writeFile(path.join(root, 'logs', 'exthost', 'mcp-notebooklm.log'), 'x');
  await fs.writeFile(path.join(root, 'logs', 'exthost', 'unrelated.log'), 'x');
  await fs.writeFile(path.join(root, 'a', 'notebooklm-mcp'), 'a file, not a directory');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('findPaths', () => {
  it('expands a single wildcard segment and returns absolute paths', async () => {
    const found = await findPaths(path.join(root, '*/node_modules/notebooklm-mcp'), {
      onlyDirectories: true,
    });

    expect(found).toEqual([path.join(root, 'a', 'node_modules', 'notebooklm-mcp')]);
    expect(path.isAbsolute(found[0])).toBe(true);
  });

  it('keeps directories out when files are asked for, and the reverse', async () => {
    const pattern = path.join(root, 'a', 'notebooklm-mcp');

    expect(await findPaths(pattern, { onlyFiles: true })).toHaveLength(1);
    expect(await findPaths(pattern, { onlyDirectories: true })).toHaveLength(0);
  });

  it('crosses directory levels with **', async () => {
    const found = await findPaths(path.join(root, '**/exthost/**/*notebooklm*.log'), {
      onlyFiles: true,
    });

    expect(found).toEqual([path.join(root, 'logs', 'exthost', 'mcp-notebooklm.log')]);
  });

  it('returns nothing rather than throwing when the tree is absent', async () => {
    expect(await findPaths(path.join(root, 'no-such-dir', '*'))).toEqual([]);
  });
});
