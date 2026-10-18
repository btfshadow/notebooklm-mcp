/**
 * Account Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Mock the crypto module
jest.unstable_mockModule('../accounts/crypto.js', () => ({
  encrypt: jest.fn(async (data: string) => `encrypted:${data}`),
  decrypt: jest.fn(async (data: string) => data.replace('encrypted:', '')),
  maskEmail: jest.fn((email: string) => email.replace(/(.{2}).*(@.*)/, '$1***$2')),
  verifyEncryption: jest.fn(async () => true),
}));

// Mock logger
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    dim: jest.fn(),
  },
}));

describe('AccountManager', () => {
  let AccountManager: any;
  let testDataDir: string;

  beforeEach(async () => {
    // Create temp directory for tests
    testDataDir = path.join(os.tmpdir(), `account-manager-test-${Date.now()}`);
    await fs.mkdir(testDataDir, { recursive: true });

    // Mock CONFIG
    jest.unstable_mockModule('../config.js', () => ({
      CONFIG: {
        dataDir: testDataDir,
      },
    }));

    // Import fresh module
    const module = await import('../accounts/account-manager.js');
    AccountManager = module.AccountManager;
  });

  afterEach(async () => {
    jest.resetModules();
    // Cleanup temp directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should create manager instance', () => {
      const manager = new AccountManager();
      expect(manager).toBeDefined();
    });

    it('should initialize with empty accounts', async () => {
      const manager = new AccountManager();
      await manager.initialize();
      expect(manager.getAccountCount()).toBe(0);
      expect(manager.hasAccounts()).toBe(false);
    });

    it('should create accounts directory on init', async () => {
      const manager = new AccountManager();
      await manager.initialize();
      const accountsDir = path.join(testDataDir, 'accounts');
      expect(existsSync(accountsDir)).toBe(true);
    });

    it('should create default config file', async () => {
      const manager = new AccountManager();
      await manager.initialize();
      const configPath = path.join(testDataDir, 'accounts.json');
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe('Account Management', () => {
    it('should add an account', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123');
      expect(id).toMatch(/^account-\d+-[0-9a-f]{8}$/);
      expect(manager.getAccountCount()).toBe(1);
      expect(manager.hasAccounts()).toBe(true);
    });

    it('should add account with TOTP', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123', 'TOTP_SECRET');
      const account = manager.getAccount(id);
      expect(account?.config.hasTotp).toBe(true);
    });

    it('should add account with options', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123', undefined, {
        priority: 5,
        notes: 'Test account',
      });
      const account = manager.getAccount(id);
      expect(account?.config.priority).toBe(5);
      expect(account?.config.notes).toBe('Test account');
    });

    it('should list accounts', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      await manager.addAccount('test1@gmail.com', 'pass1');
      await manager.addAccount('test2@gmail.com', 'pass2');

      const accounts = manager.listAccounts();
      expect(accounts.length).toBe(2);
    });

    it('should get account by ID', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123');
      const account = manager.getAccount(id);
      expect(account).toBeDefined();
      expect(account?.config.email).toBe('test@gmail.com');
    });

    it('should return undefined for non-existent account', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const account = manager.getAccount('non-existent');
      expect(account).toBeUndefined();
    });

    it('should remove account', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123');
      expect(manager.getAccountCount()).toBe(1);

      const result = await manager.removeAccount(id);
      expect(result).toBe(true);
      expect(manager.getAccountCount()).toBe(0);
    });

    it('should return false when removing non-existent account', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const result = await manager.removeAccount('non-existent');
      expect(result).toBe(false);
    });

    it('should throw when adding account before init', async () => {
      const manager = new AccountManager();
      await expect(manager.addAccount('test@gmail.com', 'password123')).rejects.toThrow(
        'Account manager not initialized'
      );
    });
  });

  describe('Credentials', () => {
    it('should get credentials for account', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'password123', 'TOTP_SECRET');
      const creds = await manager.getCredentials(id);

      expect(creds).toBeDefined();
      expect(creds?.email).toBe('test@gmail.com');
      expect(creds?.password).toBe('password123');
      expect(creds?.totpSecret).toBe('TOTP_SECRET');
    });

    it('should return null for non-existent account credentials', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const creds = await manager.getCredentials('non-existent');
      expect(creds).toBeNull();
    });
  });

  describe('Rotation Strategies', () => {
    it('should get default rotation strategy', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      expect(manager.getRotationStrategy()).toBe('least_used');
    });

    it('should set rotation strategy', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      await manager.setRotationStrategy('round_robin');
      expect(manager.getRotationStrategy()).toBe('round_robin');
    });

    it('should get best account with least_used strategy', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id1 = await manager.addAccount('test1@gmail.com', 'pass1');
      const id2 = await manager.addAccount('test2@gmail.com', 'pass2');

      // Use first account a bit
      await manager.recordUsage(id1);
      await manager.recordUsage(id1);

      const selection = await manager.getBestAccount();
      expect(selection).toBeDefined();
      expect(selection?.account.config.id).toBe(id2); // id2 has less usage
    });

    it('should return null when no accounts available', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const selection = await manager.getBestAccount();
      expect(selection).toBeNull();
    });

    it('should exclude accounts with exhausted quota', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      const account = manager.getAccount(id);

      // Exhaust quota
      if (account) {
        account.quota.used = account.quota.limit;
      }

      const selection = await manager.getBestAccount();
      expect(selection).toBeNull();
    });

    it('should exclude accounts with too many failures', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      const account = manager.getAccount(id);

      // Add consecutive failures
      if (account) {
        account.state.consecutiveFailures = 3;
      }

      const selection = await manager.getBestAccount();
      expect(selection).toBeNull();
    });
  });

  describe('Usage Recording', () => {
    it('should record usage', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      const accountBefore = manager.getAccount(id);
      const usedBefore = accountBefore?.quota.used || 0;

      await manager.recordUsage(id);

      const accountAfter = manager.getAccount(id);
      expect(accountAfter?.quota.used).toBe(usedBefore + 1);
    });

    it('should update last activity on usage', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      await manager.recordUsage(id);

      const account = manager.getAccount(id);
      expect(account?.state.lastActivity).toBeDefined();
    });
  });

  describe('Login Recording', () => {
    it('should record login failure', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      await manager.recordLoginFailure(id, 'Test error');

      const account = manager.getAccount(id);
      expect(account?.state.loginFailures).toBe(1);
      expect(account?.state.consecutiveFailures).toBe(1);
      expect(account?.state.lastError).toBe('Test error');
      expect(account?.state.sessionStatus).toBe('expired');
    });

    it('should record login success', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');

      // First fail
      await manager.recordLoginFailure(id, 'Test error');

      // Then succeed
      await manager.recordLoginSuccess(id);

      const account = manager.getAccount(id);
      expect(account?.state.consecutiveFailures).toBe(0);
      expect(account?.state.sessionStatus).toBe('valid');
      expect(account?.state.lastError).toBeUndefined();
    });
  });

  describe('Session Status', () => {
    it('should update session status', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      await manager.updateSessionStatus(id, 'expiring');

      const account = manager.getAccount(id);
      expect(account?.state.sessionStatus).toBe('expiring');
    });
  });

  describe('Auto-Login Setting', () => {
    it('should get auto-login status', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      expect(manager.isAutoLoginEnabled()).toBe(true); // Default is true
    });

    it('should set auto-login enabled', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      await manager.setAutoLoginEnabled(false);
      expect(manager.isAutoLoginEnabled()).toBe(false);
    });
  });

  describe('Health Check', () => {
    it('should return health for all accounts', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      await manager.addAccount('test1@gmail.com', 'pass1');
      await manager.addAccount('test2@gmail.com', 'pass2');

      const health = await manager.healthCheck();
      expect(health.length).toBe(2);
    });

    it('keeps both accounts when two are added in the same millisecond', async () => {
      // Regression: ids were `account-${Date.now()}`, so a fast caller lost one.
      const manager = new AccountManager();
      await manager.initialize();

      const [first, second] = await Promise.all([
        manager.addAccount('fast1@gmail.com', 'pass1'),
        manager.addAccount('fast2@gmail.com', 'pass2'),
      ]);

      expect(first).not.toBe(second);
      expect(await manager.healthCheck()).toHaveLength(2);
    });

    it('should report quota issues', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      const id = await manager.addAccount('test@gmail.com', 'pass');
      const account = manager.getAccount(id);

      // Exhaust quota
      if (account) {
        account.quota.used = account.quota.limit;
      }

      const health = await manager.healthCheck();
      expect(health[0].issues).toContain('Quota exhausted');
    });

    it('should report missing state file', async () => {
      const manager = new AccountManager();
      await manager.initialize();

      await manager.addAccount('test@gmail.com', 'pass');

      const health = await manager.healthCheck();
      expect(health[0].issues).toContain('No state file (needs login)');
    });
  });
});
