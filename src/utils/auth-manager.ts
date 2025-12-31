import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConsoleLogger, type Logger } from './logger';

export interface AuthData {
  mcp_tokens?: Record<
    string,
    {
      access_token: string;
      expires_at?: number;
      refresh_token?: string;
    }
  >;
}

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
    } catch (e) {
      AuthManager.logger.debug?.(`Failed to set directory permissions: ${e}`);
    }

    const authPath = join(dir, 'auth.json');
    if (existsSync(authPath)) {
      try {
        require('node:fs').chmodSync(authPath, 0o600);
      } catch (e) {
        AuthManager.logger.debug?.(`Failed to set auth file permissions: ${e}`);
      }
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
}
