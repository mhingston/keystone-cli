import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { AuthManager } from './auth-manager.ts';

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
      } catch (e) {}
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
      fs.writeFileSync(TEMP_AUTH_FILE, JSON.stringify({ github_token: 'test-token' }));

      const data = AuthManager.load();
      expect(data).toEqual({ github_token: 'test-token' });
    });

    it('should return empty object if JSON parsing fails', () => {
      fs.writeFileSync(TEMP_AUTH_FILE, 'invalid-json');

      const data = AuthManager.load();
      expect(data).toEqual({});
    });
  });

  describe('save()', () => {
    it('should save data merged with current data', () => {
      fs.writeFileSync(TEMP_AUTH_FILE, JSON.stringify({ github_token: 'old-token' }));

      AuthManager.save({ copilot_token: 'new-copilot-token' });

      const content = fs.readFileSync(TEMP_AUTH_FILE, 'utf8');
      expect(JSON.parse(content)).toEqual({
        github_token: 'old-token',
        copilot_token: 'new-copilot-token',
      });
    });
  });

  describe('getCopilotToken()', () => {
    it('should return undefined if no github_token', async () => {
      fs.writeFileSync(TEMP_AUTH_FILE, JSON.stringify({}));
      const token = await AuthManager.getCopilotToken();
      expect(token).toBeUndefined();
    });

    it('should return cached token if valid', async () => {
      const expires = Math.floor(Date.now() / 1000) + 1000;
      fs.writeFileSync(
        TEMP_AUTH_FILE,
        JSON.stringify({
          github_token: 'gh-token',
          copilot_token: 'cached-token',
          copilot_expires_at: expires,
        })
      );

      const token = await AuthManager.getCopilotToken();
      expect(token).toBe('cached-token');
    });

    it('should refresh token if expired', async () => {
      fs.writeFileSync(
        TEMP_AUTH_FILE,
        JSON.stringify({
          github_token: 'gh-token',
          copilot_token: 'expired-token',
          copilot_expires_at: Math.floor(Date.now() / 1000) - 1000,
        })
      );

      // Mock fetch
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'new-token',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
            { status: 200 }
          )
        )
      );
      // @ts-ignore
      global.fetch = mockFetch;

      const token = await AuthManager.getCopilotToken();
      expect(token).toBe('new-token');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should return undefined and log error if refresh fails', async () => {
      fs.writeFileSync(
        TEMP_AUTH_FILE,
        JSON.stringify({
          github_token: 'gh-token',
        })
      );

      // Mock fetch failure
      // @ts-ignore
      global.fetch = mock(() =>
        Promise.resolve(
          new Response('Unauthorized', {
            status: 401,
            statusText: 'Unauthorized',
          })
        )
      );

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
      const token = await AuthManager.getCopilotToken();

      expect(token).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('Device Login', () => {
    it('initGitHubDeviceLogin should return device code data', async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: 'dev_code',
              user_code: 'USER-CODE',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 5,
            }),
            { status: 200 }
          )
        )
      );
      // @ts-ignore
      global.fetch = mockFetch;

      const result = await AuthManager.initGitHubDeviceLogin();
      expect(result.device_code).toBe('dev_code');
      expect(result.user_code).toBe('USER-CODE');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('pollGitHubDeviceLogin should return token when successful', async () => {
      let callCount = 0;
      const mockFetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: 'authorization_pending',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'gh_access_token',
            }),
            { status: 200 }
          )
        );
      });
      // @ts-ignore
      global.fetch = mockFetch;

      // Mock setTimeout to resolve immediately
      const originalTimeout = global.setTimeout;
      // @ts-ignore
      global.setTimeout = (fn) => fn();

      try {
        const token = await AuthManager.pollGitHubDeviceLogin('dev_code');
        expect(token).toBe('gh_access_token');
        expect(callCount).toBe(2);
      } finally {
        global.setTimeout = originalTimeout;
      }
    });

    it('pollGitHubDeviceLogin should throw on other errors', async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'expired_token',
              error_description: 'The device code has expired',
            }),
            { status: 200 }
          )
        )
      );
      // @ts-ignore
      global.fetch = mockFetch;

      await expect(AuthManager.pollGitHubDeviceLogin('dev_code')).rejects.toThrow(
        'The device code has expired'
      );
    });
  });
});
