import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TIMEOUTS } from './constants';
import { ConsoleLogger, type Logger } from './logger';

export interface AuthData {
  github_token?: string;
  copilot_token?: string;
  copilot_expires_at?: number;
  openai_api_key?: string;
  anthropic_api_key?: string;
  google_gemini?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    email?: string;
    project_id?: string;
  };
  anthropic_claude?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
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

// OAuth Client IDs - configurable via environment variables for different deployment environments
const GITHUB_CLIENT_ID = process.env.KEYSTONE_GITHUB_CLIENT_ID ?? '013444988716b5155f4c';
const TOKEN_REFRESH_BUFFER_SECONDS = 300;
const OPENAI_CHATGPT_CLIENT_ID =
  process.env.KEYSTONE_OPENAI_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CHATGPT_REDIRECT_URI = 'http://localhost:1455/callback';
const ANTHROPIC_OAUTH_CLIENT_ID =
  process.env.KEYSTONE_ANTHROPIC_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference';
const GOOGLE_GEMINI_OAUTH_CLIENT_ID =
  process.env.KEYSTONE_GOOGLE_CLIENT_ID ??
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
// Redirect URI is dynamically constructed based on the ephemeral port
const GOOGLE_GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];
const GOOGLE_GEMINI_LOAD_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
];
const GOOGLE_GEMINI_METADATA_HEADER =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

export class AuthManager {
  private static logger: Logger = new ConsoleLogger();

  private static getAuthPath(): string {
    if (process.env.KEYSTONE_AUTH_PATH) {
      return process.env.KEYSTONE_AUTH_PATH;
    }
    const dir = join(homedir(), '.keystone');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Ensure dir perms are correct even if it exists
    try {
      const fs = require('node:fs');
      fs.chmodSync(dir, 0o700);
    } catch {}

    const authPath = join(dir, 'auth.json');
    if (existsSync(authPath)) {
      try {
        require('node:fs').chmodSync(authPath, 0o600);
      } catch {}
    }
    return authPath;
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

  private static sanitizeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    // Limit message length to prevent DoS with very long inputs
    const MAX_SANITIZE_LENGTH = 10_000;
    if (message.length > MAX_SANITIZE_LENGTH) {
      message = `${message.substring(0, MAX_SANITIZE_LENGTH)}... [truncated]`;
    }

    // Simple token-based redaction (avoids ReDoS-prone regex)
    const sensitiveKeywords = [
      'token',
      'key',
      'secret',
      'password',
      'credential',
      'auth',
      'private',
      'cookie',
      'session',
      'signature',
    ];

    // Split on common delimiters preserving them
    const parts = message.split(/([:\s="']+)/);
    let prevWasSensitive = false;

    return parts
      .map((part) => {
        const lower = part.toLowerCase();

        // Check if current part is a sensitive keyword
        if (sensitiveKeywords.some((kw) => lower.includes(kw))) {
          prevWasSensitive = true;
          return part;
        }

        // If previous part was sensitive and this looks like a value, redact it
        if (prevWasSensitive && /^[a-zA-Z0-9._~%=-]+$/.test(part) && part.length > 3) {
          prevWasSensitive = false;
          return '***REDACTED***';
        }

        // Delimiter parts reset the flag
        if (/^[:\s="']+$/.test(part)) {
          // Keep prevWasSensitive as is - it's just a delimiter
          return part;
        }

        prevWasSensitive = false;
        return part;
      })
      .join('');
  }

  static save(data: AuthData): void {
    const path = AuthManager.getAuthPath();
    const current = AuthManager.load();
    try {
      writeFileSync(path, JSON.stringify({ ...current, ...data }, null, 2), { mode: 0o600 });
    } catch (error) {
      AuthManager.logger.error(`Failed to save auth data: ${AuthManager.sanitizeError(error)}`);
    }
  }

  static setLogger(logger: Logger): void {
    AuthManager.logger = logger;
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
      AuthManager.logger.error(
        `Error refreshing Copilot token: ${AuthManager.sanitizeError(error)}`
      );
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

  private static getGoogleGeminiClientSecret(): string {
    const secret =
      process.env.GOOGLE_GEMINI_OAUTH_CLIENT_SECRET || process.env.KEYSTONE_GEMINI_CLIENT_SECRET;
    if (!secret) {
      throw new Error(
        'Missing Google Gemini OAuth client secret. Set GOOGLE_GEMINI_OAUTH_CLIENT_SECRET or KEYSTONE_GEMINI_CLIENT_SECRET.'
      );
    }
    return secret;
  }

  static createAnthropicClaudeAuth(): { url: string; verifier: string } {
    const verifier = AuthManager.generateCodeVerifier();
    const challenge = AuthManager.createCodeChallenge(verifier);

    const authUrl = `https://claude.ai/oauth/authorize?${new URLSearchParams({
      code: 'true',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      scope: ANTHROPIC_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: verifier,
    }).toString()}`;

    return { url: authUrl, verifier };
  }

  static async exchangeAnthropicClaudeCode(
    code: string,
    verifier: string
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const [authCode, stateFromCode] = code.split('#');
    if (stateFromCode && stateFromCode !== verifier) {
      throw new Error('Invalid OAuth state');
    }
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: authCode,
        state: stateFromCode || verifier,
        grant_type: 'authorization_code',
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange Claude auth code: ${response.status} - ${error}`);
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
  }

  private static async fetchGoogleGeminiProjectId(
    accessToken: string
  ): Promise<string | undefined> {
    const loadHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': GOOGLE_GEMINI_METADATA_HEADER,
    };

    for (const baseEndpoint of GOOGLE_GEMINI_LOAD_ENDPOINTS) {
      try {
        const response = await fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers: loadHeaders,
          body: JSON.stringify({
            metadata: {
              ideType: 'IDE_UNSPECIFIED',
              platform: 'PLATFORM_UNSPECIFIED',
              pluginType: 'GEMINI',
            },
          }),
        });

        if (!response.ok) {
          continue;
        }

        const data = (await response.json()) as {
          cloudaicompanionProject?: string | { id?: string };
        };

        if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
          return data.cloudaicompanionProject;
        }
        if (
          data.cloudaicompanionProject &&
          typeof data.cloudaicompanionProject === 'object' &&
          typeof data.cloudaicompanionProject.id === 'string' &&
          data.cloudaicompanionProject.id
        ) {
          return data.cloudaicompanionProject.id;
        }
      } catch {}
    }

    return undefined;
  }

  static async loginGoogleGemini(projectId?: string): Promise<void> {
    const verifier = AuthManager.generateCodeVerifier();
    const challenge = AuthManager.createCodeChallenge(verifier);
    const state = randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      const serverRef: { current?: ReturnType<typeof Bun.serve> } = {};
      const stopServer = () => {
        serverRef.current?.stop();
      };
      const timeout = setTimeout(() => {
        stopServer();
        reject(new Error('Login timed out after 5 minutes'));
      }, TIMEOUTS.OAUTH_LOGIN_TIMEOUT_MS);

      serverRef.current = Bun.serve({
        port: 0, // Use ephemeral port to avoid conflicts
        async fetch(req, server) {
          const url = new URL(req.url);
          const redirectUri = `http://localhost:${server.port}/oauth-callback`;

          if (url.pathname === '/oauth-callback') {
            const error = url.searchParams.get('error');
            if (error) {
              clearTimeout(timeout);
              setTimeout(stopServer, 100);
              reject(new Error(`Authorization error: ${error}`));
              return new Response(`Error: ${error}`, { status: 400 });
            }

            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            if (!code) {
              return new Response('Missing code parameter', { status: 400 });
            }
            if (returnedState && returnedState !== state) {
              clearTimeout(timeout);
              setTimeout(stopServer, 100);
              reject(new Error('Invalid OAuth state'));
              return new Response('Invalid state parameter', { status: 400 });
            }

            try {
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  client_id: GOOGLE_GEMINI_OAUTH_CLIENT_ID,
                  client_secret: AuthManager.getGoogleGeminiClientSecret(),
                  code,
                  grant_type: 'authorization_code',
                  redirect_uri: redirectUri,
                  code_verifier: verifier,
                }),
                signal: AbortSignal.timeout(30000),
              });

              if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to exchange code: ${response.status} - ${errorText}`);
              }

              const data = (await response.json()) as {
                access_token: string;
                refresh_token?: string;
                expires_in: number;
              };

              if (!data.refresh_token) {
                throw new Error('Missing refresh token in response. Try re-authenticating.');
              }

              let email: string | undefined;
              try {
                const userInfoResponse = await fetch(
                  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
                  { headers: { Authorization: `Bearer ${data.access_token}` } }
                );
                if (userInfoResponse.ok) {
                  const userInfo = (await userInfoResponse.json()) as { email?: string };
                  email = userInfo.email;
                }
              } catch {
                // Ignore user info lookup failures
              }

              let resolvedProjectId =
                projectId ||
                process.env.GOOGLE_GEMINI_PROJECT_ID ||
                process.env.KEYSTONE_GEMINI_PROJECT_ID;
              if (!resolvedProjectId) {
                resolvedProjectId = await AuthManager.fetchGoogleGeminiProjectId(data.access_token);
              }

              AuthManager.save({
                google_gemini: {
                  access_token: data.access_token,
                  refresh_token: data.refresh_token,
                  expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
                  email,
                  project_id: resolvedProjectId,
                },
              });

              clearTimeout(timeout);
              setTimeout(stopServer, 100);
              resolve();
              return new Response(
                '<h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            } catch (err) {
              clearTimeout(timeout);
              setTimeout(stopServer, 100);
              reject(err);
              return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, {
                status: 500,
              });
            }
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      // serverRef.current is set by Bun.serve but might not be immediately available if we accessed it too early
      // typically Bun.serve returns the server instance synchronously
      const port = serverRef.current?.port;
      if (!port) {
        reject(new Error('Failed to start local server for OAuth'));
        return;
      }
      const redirectUri = `http://localhost:${port}/oauth-callback`;

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: GOOGLE_GEMINI_OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: GOOGLE_GEMINI_OAUTH_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()}`;

      AuthManager.logger.log('\nTo login with Google Gemini (OAuth):');
      AuthManager.logger.log('1. Visit the following URL in your browser:');
      AuthManager.logger.log(`   ${authUrl}\n`);
      AuthManager.logger.log('Waiting for authorization...');

      try {
        const { platform } = process;
        const command =
          platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
        const { spawn } = require('node:child_process');
        spawn(command, [authUrl]);
      } catch {
        // Ignore if we can't open the browser automatically
      }
    });
  }

  static async loginOpenAIChatGPT(): Promise<void> {
    const verifier = AuthManager.generateCodeVerifier();
    const challenge = AuthManager.createCodeChallenge(verifier);
    const state = randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      const serverRef: { current?: ReturnType<typeof Bun.serve> } = {};
      const stopServer = () => {
        serverRef.current?.stop();
      };
      const timeout = setTimeout(() => {
        stopServer();
        reject(new Error('Login timed out after 5 minutes'));
      }, TIMEOUTS.OAUTH_LOGIN_TIMEOUT_MS);

      serverRef.current = Bun.serve({
        port: 1455,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            if (!returnedState || returnedState !== state) {
              clearTimeout(timeout);
              setTimeout(stopServer, 100);
              reject(new Error('Invalid OAuth state'));
              return new Response('Invalid state parameter', { status: 400 });
            }
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
                  signal: AbortSignal.timeout(30000),
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
                setTimeout(stopServer, 100);
                resolve();
                return new Response(
                  '<h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p>',
                  { headers: { 'Content-Type': 'text/html' } }
                );
              } catch (err) {
                clearTimeout(timeout);
                setTimeout(stopServer, 100);
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

      const authUrl = `https://chatgpt.com/oauth/authorize?${new URLSearchParams({
        client_id: OPENAI_CHATGPT_CLIENT_ID,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: OPENAI_CHATGPT_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid profile email offline_access',
        state,
      }).toString()}`;

      AuthManager.logger.log('\nTo login with OpenAI ChatGPT:');
      AuthManager.logger.log('1. Visit the following URL in your browser:');
      AuthManager.logger.log(`   ${authUrl}\n`);
      AuthManager.logger.log('Waiting for authorization...');

      // Attempt to open the browser
      try {
        const { platform } = process;
        const command =
          platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
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
        signal: AbortSignal.timeout(30000),
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
      AuthManager.logger.error(
        `Error refreshing OpenAI ChatGPT token: ${AuthManager.sanitizeError(error)}`
      );
      return undefined;
    }
  }

  static async getGoogleGeminiToken(): Promise<string | undefined> {
    const auth = AuthManager.load();
    if (!auth.google_gemini) return undefined;

    const { access_token, refresh_token, expires_at } = auth.google_gemini;

    if (expires_at > Date.now() / 1000 + TOKEN_REFRESH_BUFFER_SECONDS) {
      return access_token;
    }

    if (!refresh_token) {
      return undefined;
    }

    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_GEMINI_OAUTH_CLIENT_ID,
          client_secret: AuthManager.getGoogleGeminiClientSecret(),
          grant_type: 'refresh_token',
          refresh_token,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Failed to refresh token: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      AuthManager.save({
        google_gemini: {
          ...auth.google_gemini,
          access_token: data.access_token,
          refresh_token: data.refresh_token || refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        },
      });

      return data.access_token;
    } catch (error) {
      AuthManager.logger.error(
        `Error refreshing Google Gemini token: ${AuthManager.sanitizeError(error)}`
      );
      return undefined;
    }
  }

  static async getAnthropicClaudeToken(): Promise<string | undefined> {
    const auth = AuthManager.load();
    if (!auth.anthropic_claude) return undefined;

    const { access_token, refresh_token, expires_at } = auth.anthropic_claude;

    if (expires_at > Date.now() / 1000 + TOKEN_REFRESH_BUFFER_SECONDS) {
      return access_token;
    }

    try {
      const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token,
          client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30000),
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
        anthropic_claude: {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
        },
      });

      return data.access_token;
    } catch (error) {
      AuthManager.logger.error(
        `Error refreshing Anthropic Claude token: ${AuthManager.sanitizeError(error)}`
      );
      return undefined;
    }
  }
}
