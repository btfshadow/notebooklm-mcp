/**
 * Network exposure controls for the HTTP wrapper.
 *
 * Reported through our private disclosure channel on 2026-10-16
 * (GHSA-p69m-c5rf-g2c3): the wrapper bound 0.0.0.0, answered every origin with
 * `Access-Control-Allow-Origin: *`, and asked for no credentials on any of its
 * 45 routes. Any page the user visited could therefore read their whole
 * library through 127.0.0.1 — and on a shared network, so could anyone else.
 *
 * Three controls, each closing one leg of that:
 *  - bind to loopback unless told otherwise, and refuse a wider bind without a token;
 *  - never answer a cross-origin request unless its origin was allow-listed;
 *  - require a bearer token on every route once one is configured.
 *
 * A fourth was added on 2026-10-24 for GHSA-2fgr-6pf3-3hcx, reported by Umar
 * Ahmed (ghostnshells): answer only to the host names we mean to serve, so a
 * rebound hostname cannot pass itself off as a local client.
 */

import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Hosts that only the local machine can reach. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export const DEFAULT_HTTP_HOST = '127.0.0.1';

export type Env = Record<string, string | undefined>;

export function resolveHttpHost(env: Env = process.env): string {
  const host = env.HTTP_HOST?.trim();
  return host ? host : DEFAULT_HTTP_HOST;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function resolveApiToken(env: Env = process.env): string | null {
  const token = env.NOTEBOOKLM_API_KEY?.trim();
  return token ? token : null;
}

export function resolveAllowedOrigins(env: Env = process.env): string[] {
  return (env.NOTEBOOKLM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function resolveAllowedHosts(env: Env = process.env): string[] {
  return (env.NOTEBOOKLM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

/** Addresses that mean "every interface" — they name no host we could match. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*']);

/**
 * The host name a request claims to be addressing, lowercased and without its
 * port. The port is cosmetic here: a caller cannot choose which socket it
 * reaches, only what it writes in the header. `[::1]:3000` keeps its brackets
 * off so it compares against a plain `::1`.
 */
export function hostNameOf(header: string | undefined): string {
  const raw = (header ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
}

/**
 * Host guard — the anti-DNS-rebinding control.
 *
 * Reported through our private disclosure channel on 2026-10-24
 * (GHSA-2fgr-6pf3-3hcx) by Umar Ahmed (ghostnshells): the origin guard below
 * lets an `Origin`-less request through on the assumption that only a direct
 * client omits that header. A browser omits it too, whenever it believes the
 * request is same-origin — which is precisely what a rebound hostname
 * produces. The page then reads the responses, because to the browser they
 * are its own origin's.
 *
 * Checking `Host` is what closes it, and it closes it on every browser and
 * every network: a rebound request still says `Host: attacker.test`, because
 * the hostname in the address bar never changed. Only the DNS answer did.
 *
 * A wildcard bind names no host we could pin, so there the guard stands down
 * unless the operator lists hosts; that posture already refuses to start
 * without a token (see `assertSafeBind`), and a token stops the rebound read
 * on its own.
 */
export function createHostGuard(bindHost: string, extraHosts: string[] = []) {
  const allowed = new Set([...LOOPBACK_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase())]);
  const wildcard = WILDCARD_BINDS.has(bindHost.trim().toLowerCase());
  if (!wildcard) allowed.add(bindHost.trim().toLowerCase());
  const enforcing = !wildcard || extraHosts.length > 0;

  return function hostGuard(req: Request, res: Response, next: NextFunction) {
    if (!enforcing) return next();

    const host = hostNameOf(req.headers.host);
    if (allowed.has(host)) return next();

    return res.status(403).json({
      success: false,
      error:
        `Host ${host || '(missing)'} is not served by this server. Address it as ` +
        `${bindHost}, or add the name to NOTEBOOKLM_ALLOWED_HOSTS (comma-separated).`,
    });
  };
}

/**
 * A bind reachable from outside the machine with no token is the exact shape
 * of the advisory, so it is a startup failure rather than a warning: a warning
 * scrolls past and the server keeps serving the library to the network.
 */
export function assertSafeBind(host: string, token: string | null): void {
  if (isLoopbackHost(host) || token) return;
  throw new Error(
    `Refusing to listen on ${host} without a token.\n\n` +
      `That address is reachable from outside this machine, and every route would be open.\n` +
      `Either:\n` +
      `  - set NOTEBOOKLM_API_KEY=<secret> and send it as "Authorization: Bearer <secret>", or\n` +
      `  - drop HTTP_HOST so the server listens on ${DEFAULT_HTTP_HOST} only.\n\n` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}

/**
 * Cross-origin guard.
 *
 * A browser attaches `Origin` to every cross-site request, so its absence is
 * left alone here. That is NOT a judgement that the caller is a direct client
 * (curl, n8n, our own proxy): a same-origin browser request omits the header
 * too, and GHSA-2fgr-6pf3-3hcx is what happens when this guard is the only
 * one. The host guard above is what decides whether an `Origin`-less request
 * is addressing us legitimately; this one only rules on the origins it sees.
 *
 * When `Origin` is present it must be allow-listed, otherwise the request is refused
 * outright — refusing rather than merely withholding the CORS header also
 * stops the writes that a simple form POST could otherwise trigger blind.
 */
export function createOriginGuard(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);

  return function originGuard(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;

    if (typeof origin === 'string' && origin.length > 0) {
      if (!allowed.has(origin)) {
        return res.status(403).json({
          success: false,
          error:
            `Origin ${origin} is not allowed. Add it to NOTEBOOKLM_ALLOWED_ORIGINS ` +
            `(comma-separated) to let a browser page call this server.`,
        });
      }

      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  };
}

function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return apiKey.trim();
  }
  return null;
}

/** Compare digests so the check cannot be timed to recover the token. */
export function tokensMatch(expected: string, presented: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Bearer-token guard. `/health` stays reachable without one so that monitors
 * and container health checks keep working; it answers them with liveness
 * only, and the full report — which names the active notebook — needs the
 * token like everything else.
 */
export function createTokenGuard(token: string | null, openPaths: string[] = ['/health']) {
  const open = new Set(openPaths);

  return function tokenGuard(req: Request, res: Response, next: NextFunction) {
    if (!token) return next();

    const presented = presentedToken(req);
    if (presented && tokensMatch(token, presented)) {
      req.authenticatedCaller = true;
      return next();
    }

    if (open.has(req.path)) {
      req.authenticatedCaller = false;
      return next();
    }

    return res.status(401).json({
      success: false,
      error:
        'Missing or invalid token. Send the value of NOTEBOOKLM_API_KEY as ' +
        '"Authorization: Bearer <token>" or "X-API-Key: <token>".',
    });
  };
}
