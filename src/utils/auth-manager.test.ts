import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { AuthManager } from './auth-manager.ts';
import { ConsoleLogger } from './logger';

describe('AuthManager', () => {
  const originalFetch = global.fetch;
  const TEMP_AUTH_DIR = join(
    process.cwd(),
    `temp-auth-test-${Math.random().toString(36).substring(7)}`
  );
  const TEMP_AUTH_FILE = join(TEMP_AUTH_DIR, 'auth.json');

  beforeAll(() => {
    if (!fs.existsSync(TEMP_AUTH_DIR)) {
      fs.mkdirSync(TEMP_AUTH_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (fs.existsSync(TEMP_AUTH_DIR)) {
      fs.rmSync(TEMP_AUTH_DIR, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    if (fs.existsSync(TEMP_AUTH_FILE)) {
      try {
        fs.rmSync(TEMP_AUTH_FILE);
      } catch (e) {
        // Ignore likely missing file error
      }
    }
    global.fetch = originalFetch;
    // Set environment variable for EACH test to be safe
    process.env.KEYSTONE_AUTH_PATH = TEMP_AUTH_FILE;
  });

  describe('load()', () => {
    it('should return empty object if auth file does not exist', () => {
      const data = AuthManager.load();
      expect(data).toEqual({});
    });

    it('should load and parse auth data if file exists', () => {
      const authData = { mcp_tokens: { test: { access_token: 'test-token' } } };
      fs.writeFileSync(TEMP_AUTH_FILE, JSON.stringify(authData));

      const data = AuthManager.load();
      expect(data).toEqual(authData);
    });

    it('should return empty object if JSON parsing fails', () => {
      fs.writeFileSync(TEMP_AUTH_FILE, 'invalid-json');

      const data = AuthManager.load();
      expect(data).toEqual({});
    });
  });

  describe('save()', () => {
    it('should save data merged with current data', () => {
      fs.writeFileSync(
        TEMP_AUTH_FILE,
        JSON.stringify({ mcp_tokens: { s1: { access_token: 't1' } } })
      );

      AuthManager.save({ mcp_tokens: { s2: { access_token: 't2' } } });

      const content = fs.readFileSync(TEMP_AUTH_FILE, 'utf8');
      expect(JSON.parse(content)).toEqual({
        mcp_tokens: { s2: { access_token: 't2' } },
      });
    });
  });

  describe('setLogger()', () => {
    it('should set the static logger', () => {
      const mockLogger = {
        log: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        info: mock(() => {}),
        debug: mock(() => {}),
      };
      AuthManager.setLogger(mockLogger);
      // Trigger a log through save failure to verify
      process.env.KEYSTONE_AUTH_PATH = '/non/existent/path/auth.json';
      AuthManager.save({ mcp_tokens: { test: { access_token: 'test' } } });
      expect(mockLogger.error).toHaveBeenCalled();
      process.env.KEYSTONE_AUTH_PATH = TEMP_AUTH_FILE;
      // Reset logger
      AuthManager.setLogger(new ConsoleLogger());
    });
  });
});
