/**
 * Session Manager
 *
 * Manages multiple parallel browser sessions for NotebookLM API
 *
 * Features:
 * - Session lifecycle management
 * - Auto-cleanup of inactive sessions
 * - Resource limits (max concurrent sessions)
 * - Shared PERSISTENT browser fingerprint (ONE context for all sessions)
 *
 * Based on the Python implementation from session_manager.py
 */

import { AuthManager } from '../auth/auth-manager.js';
import { BrowserSession } from './browser-session.js';
import { SharedContextManager } from './shared-context-manager.js';
import { CONFIG } from '../config.js';
import { isNotebookHost, NOTEBOOK_HOST_LIST } from '../utils/notebook-domain.js';
import { log } from '../utils/logger.js';
import type { SessionInfo } from '../types.js';
import { randomBytes } from 'crypto';

export class SessionManager {
  private authManager: AuthManager;
  private sharedContextManager: SharedContextManager;
  private sessions: Map<string, BrowserSession> = new Map();
  private pendingSessions: Set<string> = new Set(); // Track sessions being created to prevent race conditions
  private maxSessions: number;
  private sessionTimeout: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
    this.sharedContextManager = new SharedContextManager(authManager);
    this.maxSessions = CONFIG.maxSessions;
    this.sessionTimeout = CONFIG.sessionTimeout;

    log.info('🎯 SessionManager initialized');
    log.info(`  Max sessions: ${this.maxSessions}`);
    log.info(
      `  Timeout: ${this.sessionTimeout}s (${Math.floor(this.sessionTimeout / 60)} minutes)`
    );

    const cleanupIntervalSeconds = Math.max(60, Math.min(Math.floor(this.sessionTimeout / 2), 300));
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions().catch((error) => {
        log.warning(`⚠️  Error during automatic session cleanup: ${error}`);
      });
    }, cleanupIntervalSeconds * 1000);
    this.cleanupInterval.unref();
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return randomBytes(4).toString('hex');
  }

  /**
   * Get existing session or create a new one
   *
   * @param sessionId Optional session ID to reuse existing session
   * @param notebookUrl Notebook URL for the session
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  async getOrCreateSession(
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean
  ): Promise<BrowserSession> {
    // Determine target notebook URL
    const targetUrl = (notebookUrl || CONFIG.notebookUrl || '').trim();
    if (!targetUrl) {
      throw new Error('Notebook URL is required to create a session');
    }
    if (!targetUrl.startsWith('http')) {
      throw new Error('Notebook URL must be an absolute URL');
    }
    // The host check belongs HERE and not on the routes. Reported through our
    // private disclosure channel on 2026-10-24 (GHSA-q565-44p7-45pv) by Umar
    // Ahmed (ghostnshells): one route validated the host and eleven others
    // plus an MCP tool did not, so a caller-chosen URL reached `page.goto` on
    // the browser that holds the user's Google session — cloud metadata,
    // intranet pages, other loopback ports. Every one of those routes funnels
    // through this method, so validating at the chokepoint covers the callers
    // that exist today and the ones nobody has written yet.
    let targetHost: string;
    try {
      targetHost = new URL(targetUrl).hostname;
    } catch {
      throw new Error('Notebook URL must be an absolute URL');
    }
    if (!isNotebookHost(targetHost)) {
      throw new Error(
        `Notebook URL must be a notebook address (${NOTEBOOK_HOST_LIST}), not ${targetHost}`
      );
    }

    // Generate ID if not provided
    if (!sessionId) {
      sessionId = this.generateSessionId();
      log.info(`🆕 Auto-generated session ID: ${sessionId}`);
    }

    // Check if browser visibility mode needs to change
    if (overrideHeadless !== undefined) {
      if (this.sharedContextManager.needsHeadlessModeChange(overrideHeadless)) {
        log.warning(
          `🔄 Browser visibility changed - closing all sessions to recreate browser context...`
        );
        const currentMode = this.sharedContextManager.getCurrentHeadlessMode();
        // Fix: overrideHeadless=true means headless, false means visible
        log.info(
          `  Switching from ${currentMode ? 'HEADLESS' : 'VISIBLE'} to ${overrideHeadless ? 'HEADLESS' : 'VISIBLE'}`
        );

        // Close all sessions (they all use the same context)
        await this.closeAllSessions();
        log.success(`  ✅ All sessions closed, browser context will be recreated with new mode`);
      }
    }

    // Return existing session if found
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (session.notebookUrl !== targetUrl) {
        log.warning(`♻️  Replacing session ${sessionId} with new notebook URL`);
        await session.close();
        this.sessions.delete(sessionId);
      } else {
        session.updateActivity();
        log.success(`♻️  Reusing existing session ${sessionId}`);
        return session;
      }
    }

    // Check if session is being created by another concurrent request (race condition prevention)
    if (this.pendingSessions.has(sessionId)) {
      log.warning(`⏳ Session ${sessionId} is being created, waiting...`);
      // Wait up to 30 seconds for the session to be created
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.sessions.has(sessionId)) {
          const session = this.sessions.get(sessionId)!;
          session.updateActivity();
          log.success(`♻️  Reusing session ${sessionId} after wait`);
          return session;
        }
        if (!this.pendingSessions.has(sessionId)) {
          break; // Session creation failed, try again
        }
      }
    }

    // Mark session as pending to prevent concurrent creation
    this.pendingSessions.add(sessionId);

    try {
      // Check if we need to free up space
      if (this.sessions.size >= this.maxSessions) {
        log.warning(`⚠️  Max sessions (${this.maxSessions}) reached, cleaning up...`);
        const freed = await this.cleanupOldestSession();
        if (!freed) {
          throw new Error(
            `Max sessions (${this.maxSessions}) reached and no inactive sessions to clean up`
          );
        }
      }

      // Create new session
      log.info(`🆕 Creating new session ${sessionId}...`);
      if (overrideHeadless !== undefined) {
        // overrideHeadless=false means visible browser, true means headless
        log.info(`  Browser mode: ${overrideHeadless ? 'headless' : 'visible'}`);
      }

      // Ensure the shared context exists (ONE fingerprint for all sessions!)
      await this.sharedContextManager.getOrCreateContext(overrideHeadless);

      // Create and initialize session (pass overrideHeadless so init() uses the same mode)
      const session = new BrowserSession(
        sessionId,
        this.sharedContextManager,
        this.authManager,
        targetUrl,
        overrideHeadless
      );
      await session.init();

      this.sessions.set(sessionId, session);
      log.success(
        `✅ Session ${sessionId} created (${this.sessions.size}/${this.maxSessions} active)`
      );
      return session;
    } catch (error) {
      log.error(`❌ Failed to create session: ${error}`);
      throw error;
    } finally {
      // Always remove from pending, whether success or failure
      this.pendingSessions.delete(sessionId);
    }
  }

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: string): BrowserSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Close and remove a specific session
   */
  async closeSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) {
      log.warning(`⚠️  Session ${sessionId} not found`);
      return false;
    }

    const session = this.sessions.get(sessionId)!;
    await session.close();
    this.sessions.delete(sessionId);

    log.success(
      `✅ Session ${sessionId} closed (${this.sessions.size}/${this.maxSessions} active)`
    );
    return true;
  }

  /**
   * Close all sessions that are using the provided notebook URL
   */
  async closeSessionsForNotebook(url: string): Promise<number> {
    let closed = 0;

    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (session.notebookUrl === url) {
        try {
          await session.close();
        } catch (error) {
          log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
        } finally {
          this.sessions.delete(sessionId);
          closed++;
        }
      }
    }

    if (closed > 0) {
      log.warning(
        `🧹 Closed ${closed} session(s) using removed notebook (${this.sessions.size}/${this.maxSessions} active)`
      );
    }

    return closed;
  }

  /**
   * Clean up all inactive sessions
   */
  async cleanupInactiveSessions(): Promise<number> {
    const inactiveSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isExpired(this.sessionTimeout)) {
        inactiveSessions.push(sessionId);
      }
    }

    if (inactiveSessions.length === 0) {
      return 0;
    }

    log.warning(`🧹 Cleaning up ${inactiveSessions.length} inactive sessions...`);

    for (const sessionId of inactiveSessions) {
      try {
        const session = this.sessions.get(sessionId)!;
        const age = (Date.now() - session.createdAt) / 1000;
        const inactive = (Date.now() - session.lastActivity) / 1000;

        log.warning(
          `  🗑️  ${sessionId}: age=${age.toFixed(0)}s, inactive=${inactive.toFixed(0)}s, messages=${session.messageCount}`
        );

        await session.close();
        this.sessions.delete(sessionId);
      } catch (error) {
        log.warning(`  ⚠️  Error cleaning up ${sessionId}: ${error}`);
      }
    }

    log.success(
      `✅ Cleaned up ${inactiveSessions.length} sessions (${this.sessions.size}/${this.maxSessions} active)`
    );
    return inactiveSessions.length;
  }

  /**
   * Clean up the oldest session to make space
   */
  private async cleanupOldestSession(): Promise<boolean> {
    if (this.sessions.size === 0) {
      return false;
    }

    // Find oldest session
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestId = sessionId;
      }
    }

    if (!oldestId) {
      return false;
    }

    const oldestSession = this.sessions.get(oldestId)!;
    const age = (Date.now() - oldestSession.createdAt) / 1000;

    log.warning(`🗑️  Removing oldest session ${oldestId} (age: ${age.toFixed(0)}s)`);

    await oldestSession.close();
    this.sessions.delete(oldestId);

    return true;
  }

  /**
   * Close all sessions (used during shutdown)
   */
  async closeAllSessions(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    if (this.sessions.size === 0) {
      log.warning('🛑 Closing shared context (no active sessions)...');
      await this.sharedContextManager.closeContext();
      log.success('✅ All sessions closed');
      return;
    }

    log.warning(`🛑 Closing all ${this.sessions.size} sessions...`);

    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        const session = this.sessions.get(sessionId)!;
        await session.close();
        this.sessions.delete(sessionId);
      } catch (error) {
        log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
      }
    }

    // Close the shared context
    await this.sharedContextManager.closeContext();

    log.success('✅ All sessions closed');
  }

  /**
   * Get all sessions info
   */
  getAllSessionsInfo(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => session.getInfo());
  }

  /**
   * Get the shared context manager (for direct browser access)
   */
  getSharedContextManager(): SharedContextManager {
    return this.sharedContextManager;
  }

  /**
   * Get aggregate stats
   */
  getStats(): {
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    oldest_session_seconds: number;
    total_messages: number;
  } {
    const sessionsInfo = this.getAllSessionsInfo();

    const totalMessages = sessionsInfo.reduce((sum, info) => sum + info.message_count, 0);
    const oldestSessionSeconds = Math.max(...sessionsInfo.map((info) => info.age_seconds), 0);

    return {
      active_sessions: sessionsInfo.length,
      max_sessions: this.maxSessions,
      session_timeout: this.sessionTimeout,
      oldest_session_seconds: oldestSessionSeconds,
      total_messages: totalMessages,
    };
  }
}
