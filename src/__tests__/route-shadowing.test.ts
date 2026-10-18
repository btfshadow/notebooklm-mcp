/**
 * Express matches routes in declaration order, so a parameterised route
 * declared before a literal sibling swallows it silently — no error, no log,
 * the wrong handler just answers.
 *
 * It happened: `DELETE /content/:contentId` sat above `DELETE /content/sources`,
 * so deleting a source by name was unreachable and arrived in the artifact
 * handler as an artifact id of "sources". Both calls returned the same
 * DELETE_STUDIO failure, which is what made it invisible.
 *
 * This guard reads the route table out of the source and fails on the whole
 * class, not just that one pair.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'http-wrapper.ts');

interface Route {
  method: string;
  path: string;
  line: number;
}

function declaredRoutes(): Route[] {
  const routes: Route[] = [];
  readFileSync(SOURCE, 'utf-8')
    .split('\n')
    .forEach((text, index) => {
      const match = /^app\.(get|post|put|delete|patch)\('([^']+)'/.exec(text);
      if (match) routes.push({ method: match[1], path: match[2], line: index + 1 });
    });
  return routes;
}

/** Does a request for `literal` match the pattern `candidate`? */
function shadows(candidate: string, literal: string): boolean {
  const a = candidate.split('/');
  const b = literal.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, i) => segment.startsWith(':') || segment === b[i]);
}

describe('route declaration order', () => {
  const routes = declaredRoutes();

  it('finds the route table', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('declares no parameterised route above a literal one it would swallow', () => {
    const shadowed: string[] = [];

    routes.forEach((earlier, i) => {
      if (!earlier.path.includes('/:')) return;
      routes.slice(i + 1).forEach((later) => {
        if (later.method !== earlier.method) return;
        if (later.path.includes('/:')) return;
        if (shadows(earlier.path, later.path)) {
          shadowed.push(
            `${later.method.toUpperCase()} ${later.path} (line ${later.line}) is unreachable: ` +
              `${earlier.method.toUpperCase()} ${earlier.path} (line ${earlier.line}) matches it first`
          );
        }
      });
    });

    expect(shadowed).toEqual([]);
  });

  it('detects shadowing when asked directly', () => {
    expect(shadows('/content/:contentId', '/content/sources')).toBe(true);
    expect(shadows('/content/:contentId', '/content/sources/:id')).toBe(false);
    expect(shadows('/notebooks/:id', '/notebooks')).toBe(false);
  });
});
