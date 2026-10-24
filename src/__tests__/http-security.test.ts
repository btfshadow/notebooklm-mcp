/**
 * Network exposure controls — GHSA-p69m-c5rf-g2c3.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_HTTP_HOST,
  assertSafeBind,
  createHostGuard,
  createOriginGuard,
  createTokenGuard,
  hostNameOf,
  isLoopbackHost,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiToken,
  resolveHttpHost,
  tokensMatch,
} from '../http-security.js';

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; headers: Record<string, string> };
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/notebooks',
    headers: {},
    ...overrides,
  } as Request;
}

describe('bind host', () => {
  it('defaults to loopback so the network cannot reach the API', () => {
    expect(resolveHttpHost({})).toBe(DEFAULT_HTTP_HOST);
    expect(isLoopbackHost(DEFAULT_HTTP_HOST)).toBe(true);
  });

  it('still honours an explicit host', () => {
    expect(resolveHttpHost({ HTTP_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveHttpHost({ HTTP_HOST: '   ' })).toBe(DEFAULT_HTTP_HOST);
  });

  it('refuses a network-reachable bind with no token', () => {
    expect(() => assertSafeBind('0.0.0.0', null)).toThrow(/Refusing to listen/);
    expect(() => assertSafeBind('192.168.1.20', null)).toThrow(/NOTEBOOKLM_API_KEY/);
  });

  it('allows a wide bind once a token is configured, and loopback always', () => {
    expect(() => assertSafeBind('0.0.0.0', 'secret')).not.toThrow();
    expect(() => assertSafeBind('127.0.0.1', null)).not.toThrow();
    expect(() => assertSafeBind('::1', null)).not.toThrow();
  });
});

describe('origin guard', () => {
  it('refuses a page from an origin that was not allow-listed', () => {
    const guard = createOriginGuard([]);
    const res = mockRes();
    const next = jest.fn();

    guard(mockReq({ headers: { origin: 'https://evil.example' } }), res, next as NextFunction);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('never answers with a wildcard origin', () => {
    const guard = createOriginGuard(['https://app.example']);
    const res = mockRes();

    guard(mockReq({ headers: { origin: 'https://app.example' } }), res, jest.fn() as NextFunction);

    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(res.headers['Vary']).toBe('Origin');
  });

  it('leaves direct clients alone — no Origin header means no browser', () => {
    const guard = createOriginGuard([]);
    const res = mockRes();
    const next = jest.fn();

    guard(mockReq(), res, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('refuses a preflight from a foreign origin instead of approving it', () => {
    const guard = createOriginGuard(['https://app.example']);
    const res = mockRes();

    guard(
      mockReq({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
      res,
      jest.fn() as NextFunction
    );

    expect(res.statusCode).toBe(403);
  });

  it('reads the allow-list from the environment', () => {
    expect(
      resolveAllowedOrigins({ NOTEBOOKLM_ALLOWED_ORIGINS: 'https://a.example, https://b.example' })
    ).toEqual(['https://a.example', 'https://b.example']);
    expect(resolveAllowedOrigins({})).toEqual([]);
  });
});

describe('token guard', () => {
  const token = 'a'.repeat(64);

  it('is inert when no token is configured', () => {
    const next = jest.fn();
    createTokenGuard(null)(mockReq(), mockRes(), next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('rejects a request with no token', () => {
    const res = mockRes();
    const next = jest.fn();
    createTokenGuard(token)(mockReq(), res, next as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong token', () => {
    const res = mockRes();
    createTokenGuard(token)(
      mockReq({ headers: { authorization: `Bearer ${'b'.repeat(64)}` } }),
      res,
      jest.fn() as NextFunction
    );
    expect(res.statusCode).toBe(401);
  });

  it('accepts the token as a bearer header or an API-key header', () => {
    for (const headers of [{ authorization: `Bearer ${token}` }, { 'x-api-key': token }]) {
      const next = jest.fn();
      const req = mockReq({ headers });
      createTokenGuard(token)(req, mockRes(), next as NextFunction);
      expect(next).toHaveBeenCalled();
      expect(req.authenticatedCaller).toBe(true);
    }
  });

  it('lets /health through unauthenticated, marked as such', () => {
    const next = jest.fn();
    const req = mockReq({ path: '/health' });
    createTokenGuard(token)(req, mockRes(), next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(req.authenticatedCaller).toBe(false);
  });

  it('compares tokens of differing length without throwing', () => {
    expect(tokensMatch(token, 'short')).toBe(false);
    expect(tokensMatch(token, token)).toBe(true);
  });
});

/**
 * Host guard — GHSA-2fgr-6pf3-3hcx, reported by Umar Ahmed (ghostnshells).
 *
 * The shape that mattered in the report is a request with NO `Origin` and an
 * attacker-chosen `Host`: the origin guard waves it through, and before this
 * guard existed so did everything else. These lock the three cases the fix
 * has to separate — the rebound request, the legitimate local client that
 * also sends no `Origin`, and the deliberate non-loopback bind.
 */
describe('host guard', () => {
  const run = (guard: ReturnType<typeof createHostGuard>, host?: string) => {
    const req = mockReq({ headers: host === undefined ? {} : { host } });
    const res = mockRes();
    const next = jest.fn();
    guard(req, res, next as unknown as NextFunction);
    return { res, next };
  };

  it('refuses a rebound hostname even though it carries no Origin', () => {
    const { res, next } = run(createHostGuard('127.0.0.1'), 'attacker.test:3999');
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('still serves the local clients that legitimately send no Origin', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', 'LOCALHOST:3000']) {
      const { res, next } = run(createHostGuard('127.0.0.1'), host);
      expect([host, res.statusCode]).toEqual([host, 0]);
      expect(next).toHaveBeenCalled();
    }
  });

  it('refuses a request that sends no Host at all', () => {
    // HTTP/1.1 requires one; something that omits it is not a client we serve.
    const { res, next } = run(createHostGuard('127.0.0.1'));
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('serves the address an operator deliberately bound to', () => {
    const { next } = run(createHostGuard('10.0.0.5'), '10.0.0.5:3000');
    expect(next).toHaveBeenCalled();
  });

  it('serves a name the operator listed, and nothing else', () => {
    const guard = createHostGuard('0.0.0.0', ['notebooks.example.com']);
    expect(run(guard, 'notebooks.example.com').next).toHaveBeenCalled();
    expect(run(guard, 'attacker.test').res.statusCode).toBe(403);
  });

  it('stands down on a wildcard bind with no list, where no host can be pinned', () => {
    // That posture already refuses to start without a token (assertSafeBind),
    // and the token is what stops the rebound read there.
    const { next } = run(createHostGuard('0.0.0.0'), 'anything.test');
    expect(next).toHaveBeenCalled();
  });

  it('reads the host name out of the header the same way a browser writes it', () => {
    expect(hostNameOf('127.0.0.1:3000')).toBe('127.0.0.1');
    expect(hostNameOf('[::1]:3000')).toBe('::1');
    expect(hostNameOf('Example.COM')).toBe('example.com');
    expect(hostNameOf(undefined)).toBe('');
  });

  it('collects allowed host names from the environment', () => {
    expect(resolveAllowedHosts({ NOTEBOOKLM_ALLOWED_HOSTS: ' a.test , b.test ,, ' })).toEqual([
      'a.test',
      'b.test',
    ]);
    expect(resolveAllowedHosts({})).toEqual([]);
  });
});
