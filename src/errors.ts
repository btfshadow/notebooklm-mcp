/**
 * Custom Error Types for NotebookLM MCP Server
 */

/**
 * Error thrown when NotebookLM rate limit is exceeded
 *
 * Usage is compute-based since 2 September 2026: the allowance refreshes
 * every 5 hours up to a weekly ceiling, and there is no query count.
 * This error indicates the user should:
 * - Use re_auth tool to switch Google accounts
 * - Wait until tomorrow for quota reset
 * - Upgrade to Google AI Pro/Ultra for higher limits
 */
export class RateLimitError extends Error {
  constructor(
    message: string = 'NotebookLM usage limit reached. The allowance is compute-based and refreshes every 5 hours; check Settings > Usage in NotebookLM for the reset time.'
  ) {
    super(message);
    this.name = 'RateLimitError';

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

/**
 * Error thrown when authentication fails
 *
 * This error can suggest cleanup workflow for persistent issues.
 * Especially useful when upgrading from old installation (notebooklm-mcp-nodejs).
 */
export class AuthenticationError extends Error {
  readonly suggestCleanup: boolean;

  constructor(message: string, suggestCleanup: boolean = false) {
    super(message);
    this.name = 'AuthenticationError';
    this.suggestCleanup = suggestCleanup;

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthenticationError);
    }
  }
}
