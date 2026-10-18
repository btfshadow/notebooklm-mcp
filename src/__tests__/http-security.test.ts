/**
 * Network exposure controls — GHSA-p69m-c5rf-g2c3.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_HTTP_HOST,
  assertSafeBind,
  createOriginGuard,
  createTokenGuard,
  isLoopbackHost,
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
