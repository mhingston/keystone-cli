import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface AuthData {
  github_token?: string;
  copilot_token?: string;
  copilot_expires_at?: number;
  openai_api_key?: string;
  anthropic_api_key?: string;
  mcp_tokens?: Record<
    string,
    {
      access_token: string;
      expires_at?: number;
      refresh_token?: string;
    }
  >;
  openai_chatgpt?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    account_id?: string;
  };
}

export const COPILOT_HEADERS = {
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.23.1',
  'User-Agent': 'GithubCopilot/1.255.0',
};

const GITHUB_CLIENT_ID = '013444988716b5155f4c'; // GitHub CLI Client ID
const TOKEN_REFRESH_BUFFER_SECONDS = 300;
const OPENAI_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CHATGPT_REDIRECT_URI = 'http://localhost:1455/callback';

export class AuthManager {
  private static getAuthPath(): string {
    if (process.env.KEYSTONE_AUTH_PATH) {
      return process.env.KEYSTONE_AUTH_PATH;
    }
    const dir = join(homedir(), '.keystone');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return join(dir, 'auth.json');
  }

  static load(): AuthData {
    const path = AuthManager.getAuthPath();
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  static save(data: AuthData): void {
    const path = AuthManager.getAuthPath();
    const current = AuthManager.load();
    try {
      writeFileSync(path, JSON.stringify({ ...current, ...data }, null, 2), { mode: 0o600 });
    } catch (error) {
      // Use ConsoleLogger as a safe fallback for top-level utility
      console.error(
        'Failed to save auth data:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  static async initGitHubDeviceLogin(): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }> {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'read:user workflow repo',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to initialize device login: ${response.statusText}`);
    }

    return response.json() as Promise<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>;
  }

  static async pollGitHubDeviceLogin(
    deviceCode: string,
    intervalSeconds = 5,
    expiresInSeconds = 900
  ): Promise<string> {
    let currentInterval = intervalSeconds;
    const poll = async (): Promise<string> => {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to poll device login: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (data.access_token) {
        return data.access_token;
      }

      if (data.error === 'authorization_pending') {
        return ''; // Continue polling
      }

      if (data.error === 'slow_down') {
        // According to GitHub docs, "slow_down" means wait 5 seconds more
        currentInterval += 5;
        return '';
      }

      throw new Error(data.error_description || data.error || 'Failed to get access token');
    };

    // Use interval and expiration from parameters
    const startTime = Date.now();
    const timeout = expiresInSeconds * 1000;

    while (Date.now() - startTime < timeout) {
      const token = await poll();
      if (token) return token;
      // Convert seconds to milliseconds
      await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));
    }

    throw new Error('Device login timed out');
  }

  static async getCopilotToken(): Promise<string | undefined> {
    const auth = AuthManager.load();

    // Check if we have a valid cached token
    if (
      auth.copilot_token &&
      auth.copilot_expires_at &&
      auth.copilot_expires_at > Date.now() / 1000 + TOKEN_REFRESH_BUFFER_SECONDS
    ) {
      return auth.copilot_token;
    }

    if (!auth.github_token) {
      return undefined;
    }

    // Exchange GitHub token for Copilot token
    try {
      const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
          Authorization: `token ${auth.github_token}`,
          ...COPILOT_HEADERS,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get Copilot token: ${response.statusText}`);
      }

      const data = (await response.json()) as { token: string; expires_at: number };
      AuthManager.save({
        copilot_token: data.token,
        copilot_expires_at: data.expires_at,
      });

      return data.token;
    } catch (error) {
      // Use ConsoleLogger as a safe fallback for top-level utility
      console.error('Error refreshing Copilot token:', error);
      return undefined;
    }
  }

  private static generateCodeVerifier(): string {
    return randomBytes(32).toString('hex');
  }

  private static createCodeChallenge(verifier: string): string {
    const hash = createHash('sha256').update(verifier).digest();
    return hash.toString('base64url');
  }

  static async loginOpenAIChatGPT(): Promise<void> {
    const verifier = AuthManager.generateCodeVerifier();
    const challenge = AuthManager.createCodeChallenge(verifier);

    return new Promise((resolve, reject) => {
      let server: any;
      const timeout = setTimeout(() => {
        if (server) server.stop();
        reject(new Error('Login timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      server = Bun.serve({
        port: 1455,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            if (code) {
              try {
                const response = await fetch('https://chatgpt.com/oauth/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    client_id: OPENAI_CHATGPT_CLIENT_ID,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: OPENAI_CHATGPT_REDIRECT_URI,
                    code_verifier: verifier,
                  }),
                });

                if (!response.ok) {
                  const error = await response.text();
                  throw new Error(`Failed to exchange code: ${response.status} - ${error}`);
                }

                const data = (await response.json()) as {
                  access_token: string;
                  refresh_token: string;
                  expires_in: number;
                };

                AuthManager.save({
                  openai_chatgpt: {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
                  },
                });

                clearTimeout(timeout);
                setTimeout(() => server.stop(), 100);
                resolve();
                return new Response(
                  '<h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p>',
                  { headers: { 'Content-Type': 'text/html' } }
                );
              } catch (err) {
                clearTimeout(timeout);
                setTimeout(() => server.stop(), 100);
                reject(err);
                return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, {
                  status: 500,
                });
              }
            } else {
              return new Response('Missing code parameter', { status: 400 });
            }
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const authUrl =
        `https://chatgpt.com/oauth/authorize?` +
        new URLSearchParams({
          client_id: OPENAI_CHATGPT_CLIENT_ID,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          redirect_uri: OPENAI_CHATGPT_REDIRECT_URI,
          response_type: 'code',
          scope: 'openid profile email offline_access',
        }).toString();

      console.log('\nTo login with OpenAI ChatGPT:');
      console.log('1. Visit the following URL in your browser:');
      console.log(`   ${authUrl}\n`);
      console.log('Waiting for authorization...');

      // Attempt to open the browser
      try {
        const { platform } = process;
        const command = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
        const { spawn } = require('node:child_process');
        spawn(command, [authUrl]);
      } catch (e) {
        // Ignore if we can't open the browser automatically
      }
    });
  }

  static async getOpenAIChatGPTToken(): Promise<string | undefined> {
    const auth = AuthManager.load();
    if (!auth.openai_chatgpt) return undefined;

    const { access_token, refresh_token, expires_at } = auth.openai_chatgpt;

    // Check if valid
    if (expires_at > Date.now() / 1000 + TOKEN_REFRESH_BUFFER_SECONDS) {
      return access_token;
    }

    // Refresh
    try {
      const response = await fetch('https://chatgpt.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: OPENAI_CHATGPT_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to refresh token: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      AuthManager.save({
        openai_chatgpt: {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        },
      });

      return data.access_token;
    } catch (error) {
      console.error('Error refreshing OpenAI ChatGPT token:', error);
      return undefined;
    }
  }
}
