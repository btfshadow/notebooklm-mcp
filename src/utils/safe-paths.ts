/**
 * One containment check for every caller-supplied filesystem path.
 *
 * Three tools take a path from the caller: `add_source` reads one, and
 * `download_content` and the vault writer create one. An agent driving this
 * server acts on text it was given, so those paths are attacker-reachable:
 * a poisoned document can ask the agent to add `accounts.json` as a source,
 * and `share_notebook` can then make the notebook public. The session store
 * holds a live Google login, so that is an account takeover, not a file leak.
 *
 * Three rules, applied in order:
 *
 *  1. Resolve first, check second. A check against the raw string is a check
 *     against something that is not what gets opened.
 *  2. Follow symlinks on the deepest part of the path that exists. Otherwise a
 *     link inside an allowed directory walks straight out of it.
 *  3. Compare whole path segments. `startsWith` on strings lets `/data-evil`
 *     pass a check for `/data`.
 *
 * The session store is refused whatever the allowed roots say, because it is
 * reachable from the default roots by design — downloads land next to it.
 */

import { realpathSync } from 'fs';
import path from 'path';

import { CONFIG } from '../config.js';

/** Never readable and never writable, whatever the roots allow. */
function sessionStorePaths(): string[] {
  return [
    CONFIG.browserStateDir,
    CONFIG.chromeProfileDir,
    CONFIG.chromeInstancesDir,
    path.join(CONFIG.dataDir, 'accounts.json'),
  ]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p));
}

/** Is `child` the same as `parent`, or inside it? Segment-aware. */
function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve symlinks as far as the path exists, then re-attach the part that
 * does not. A path being created cannot be realpath'd, but its parent can.
 */
function resolveSymlinks(absolute: string): string {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ConfineOptions {
  /**
   * Directories the path must stay inside. The first is what a relative path
   * resolves against. `null` means no containment — used by the vault, whose
   * whole purpose is to write somewhere the operator chose — but the session
   * store is still refused.
   */
  roots: string[] | null;
  /** The parameter name, so the error names what the caller actually passed. */
  what: string;
}

/**
 * Resolve a caller-supplied path and refuse it if it escapes.
 *
 * Returns the resolved path. Callers must use the returned value, not the
 * string they passed in — checking one path and opening another is the bug
 * this exists to prevent.
 */
export function confinePath(
  input: string | undefined | null,
  { roots, what }: ConfineOptions
): string {
  if (!input || typeof input !== 'string') {
    throw new Error(`${what} is required`);
  }

  const allowed =
    roots
      ?.filter((r): r is string => typeof r === 'string' && r.length > 0)
      .map((r) => resolveSymlinks(path.resolve(r))) ?? null;
  if (allowed && allowed.length === 0) {
    // Fail closed: a root list that resolved to nothing is a misconfiguration,
    // not permission to write anywhere.
    throw new Error(`${what} cannot be used: no allowed directory is configured`);
  }
  const base = allowed?.[0] ?? process.cwd();
  const resolved = resolveSymlinks(
    path.isAbsolute(input) ? path.resolve(input) : path.resolve(base, input)
  );

  for (const secret of sessionStorePaths()) {
    if (contains(resolveSymlinks(secret), resolved)) {
      throw new Error(
        `${what} "${input}" resolves inside the NotebookLM session store ` +
          `(${secret}). That directory holds the live Google login and is never ` +
          `readable or writable through the API.`
      );
    }
  }

  if (allowed && !allowed.some((root) => contains(root, resolved))) {
    throw new Error(
      `${what} "${input}" escapes the allowed directories (${allowed.join(', ')}); ` +
        `refusing to use a path outside them`
    );
  }

  return resolved;
}

/** Where `add_source` may read a file from. */
export function uploadRoots(): string[] {
  const configured = process.env.NOTEBOOKLM_UPLOAD_ROOT?.trim();
  return configured ? [configured] : [process.cwd(), CONFIG.dataDir];
}

/** Where `download_content` may write a file to. */
export function downloadRoots(): string[] {
  const configured = process.env.NOTEBOOKLM_DOWNLOAD_ROOT?.trim();
  return configured ? [configured] : [process.cwd(), CONFIG.dataDir];
}
