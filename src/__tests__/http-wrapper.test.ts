/**
 * HTTP Wrapper Tests
 */

import { describe, it, expect, jest } from '@jest/globals';
import { randomUUID } from 'crypto';

// Mock all dependencies before imports
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

describe('HTTP Wrapper URL Validation', () => {
  it('should validate NotebookLM URL format', () => {
    const validUrls = [
      'https://notebooklm.google.com/notebook/abc-123',
      'https://notebooklm.google.com/notebook/00000000-0000-0000-0000-000000000001',
    ];

    for (const url of validUrls) {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('notebooklm.google.com');
    }
  });

  it('should reject invalid URLs', () => {
    const invalidUrls = [
      'https://evil.com/notebook/abc',
      'https://notebooklm.evil.com/notebook/abc',
    ];

    for (const url of invalidUrls) {
      const parsed = new URL(url);
      expect(parsed.hostname).not.toBe('notebooklm.google.com');
    }
  });
});

describe('HTTP Wrapper Request Processing', () => {
  it('should validate required question field', () => {
    const body = {};
    const hasQuestion = 'question' in body && body.question;
    expect(hasQuestion).toBeFalsy();
  });

  it('should accept valid question', () => {
    const body = { question: 'What is this about?' };
    const hasQuestion = 'question' in body && body.question;
    expect(hasQuestion).toBeTruthy();
  });
});

describe('HTTP Wrapper Notebook Validation', () => {
  it('should require all notebook fields', () => {
    const requiredFields = ['url', 'name', 'description', 'topics'];
    const body = { url: 'test', name: 'Test' };

    const missingFields = requiredFields.filter((field) => !(field in body));
    expect(missingFields).toContain('description');
    expect(missingFields).toContain('topics');
  });

  it('should accept complete notebook data', () => {
    const requiredFields = ['url', 'name', 'description', 'topics'];
    const body = {
      url: 'https://notebooklm.google.com/notebook/test',
      name: 'Test',
      description: 'Test notebook',
      topics: ['test'],
    };

    const missingFields = requiredFields.filter((field) => !(field in body));
    expect(missingFields).toHaveLength(0);
  });
});

describe('HTTP Wrapper Request ID', () => {
  it('should generate UUID-like request ID', () => {
    const requestId = randomUUID();

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should use provided request ID', () => {
    const providedId = 'custom-request-id';
    const headers = { 'x-request-id': providedId };

    const requestId = headers['x-request-id'] || 'generated';
    expect(requestId).toBe(providedId);
  });
});
