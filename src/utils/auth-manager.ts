import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AuthData {
  github_token?: string;
  copilot_token?: string;
  copilot_expires_at?: number;
  mcp_tokens?: Record<
    string,
    {
      access_token: string;
      expires_at?: number;
      refresh_token?: string;
    }
  >;
}

export const COPILOT_HEADERS = {
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.23.1',
  'User-Agent': 'GithubCopilot/1.255.0',
};

const GITHUB_CLIENT_ID = '013444988716b5155f4c'; // GitHub CLI Client ID

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
    writeFileSync(path, JSON.stringify({ ...current, ...data }, null, 2));
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

  static async pollGitHubDeviceLogin(deviceCode: string): Promise<string> {
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

      throw new Error(data.error_description || data.error || 'Failed to get access token');
    };

    // Poll every 5 seconds (GitHub's default interval is usually 5)
    // In a real implementation, we should use the interval from initGitHubDeviceLogin
    while (true) {
      const token = await poll();
      if (token) return token;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  static async getCopilotToken(): Promise<string | undefined> {
    const auth = AuthManager.load();

    // Check if we have a valid cached token
    if (
      auth.copilot_token &&
      auth.copilot_expires_at &&
      auth.copilot_expires_at > Date.now() / 1000 + 300
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
      console.error('Error refreshing Copilot token:', error);
      return undefined;
    }
  }
}
