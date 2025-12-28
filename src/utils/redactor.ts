/**
 * Redactor for masking secrets in output strings
 *
 * This utility helps prevent secret leakage by replacing secret values
 * with masked strings before they are logged or stored in the database.
 */

export interface RedactorOptions {
  forcedSecrets?: string[];
  /** Additional words to skip (add to default blocklist) */
  additionalBlocklist?: string[];
  /** Replace default blocklist entirely */
  customBlocklist?: string[];
  /** Warn when a potentially sensitive key's value matches blocklist */
  onBlocklistMatch?: (key: string, value: string) => void;
}

export class Redactor {
  private patterns: RegExp[] = [];
  private combinedPattern: RegExp | null = null;
  public readonly maxSecretLength: number;
  private hasShortSecrets: boolean;

  constructor(secrets: Record<string, string>, options: RedactorOptions = {}) {
    // Keys that indicate high sensitivity - always redact their values regardless of length
    const sensitiveKeys = new Set([
      'api_key',
      'apikey',
      'token',
      'secret',
      'password',
      'pswd',
      'passwd',
      'pwd',
      'auth',
      'credential',
      'access_key',
      'private_key',
    ]);

    // Build blocklist - allow customization via options
    const valueBlocklist = new Set(
      options.customBlocklist ?? [
        'true',
        'false',
        'null',
        'undefined',
        'info',
        'warn',
        'error',
        'debug',
        'success',
        'pending',
        'failed',
        'skipped',
        'suspended',
        'default',
        'public',
        'private',
        'protected',
      ]
    );

    // Add any additional blocklist items
    if (options.additionalBlocklist) {
      for (const item of options.additionalBlocklist) {
        valueBlocklist.add(item.toLowerCase());
      }
    }

    // Extract all secret values
    // We filter based on:
    // 1. Value must be a string and not empty
    // 2. Value must not be in the blocklist of common words
    // 3. Either the key indicates high sensitivity OR length >= 10 (conservative limit for unknown values)
    const secretsToRedact = new Set<string>();

    for (const forced of options.forcedSecrets || []) {
      if (typeof forced === 'string' && forced.length > 0) {
        secretsToRedact.add(forced);
      }
    }

    for (const [key, value] of Object.entries(secrets)) {
      if (!value || typeof value !== 'string') continue;

      const lowerValue = value.toLowerCase();
      if (valueBlocklist.has(lowerValue)) {
        // Warn if this is a sensitive key whose value matches blocklist
        const lowerKey = key.toLowerCase();
        const isSensitiveKey = Array.from(sensitiveKeys).some((k) => lowerKey.includes(k));
        if (isSensitiveKey && options.onBlocklistMatch) {
          options.onBlocklistMatch(key, value);
        }
        continue;
      }

      const lowerKey = key.toLowerCase();
      // Check if key contains any sensitive term
      const isSensitiveKey = Array.from(sensitiveKeys).some((k) => lowerKey.includes(k));

      // If it's a sensitive key, redact values >= 6 chars to avoid false positives on short common values
      // For non-sensitive keys, only redact if >= 10 chars (likely a real secret)
      if (isSensitiveKey) {
        if (value.length >= 6) {
          secretsToRedact.add(value);
        }
      } else if (value.length >= 10) {
        secretsToRedact.add(value);
      }
    }

    const uniqueSecrets = Array.from(secretsToRedact).sort((a, b) => b.length - a.length);
    this.hasShortSecrets = uniqueSecrets.some((s) => s.length < 3);

    // Build regex patterns
    // Optimization: Group secrets into a single combined regex where possible
    const parts: string[] = [];

    for (const secret of uniqueSecrets) {
      // Escape special regex characters in the secret
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Use word boundaries if the secret starts/ends with an alphanumeric character
      // to avoid partial matches (e.g. redacting 'mark' in 'marketplace')
      // BUT only if length is small (< 5), otherwise matching inside strings is desirable
      if (secret.length < 5) {
        const startBoundary = /^\w/.test(secret) ? '\\b' : '';
        const endBoundary = /\w$/.test(secret) ? '\\b' : '';
        parts.push(`${startBoundary}${escaped}${endBoundary}`);
      } else {
        parts.push(escaped);
      }
    }

    if (parts.length > 0) {
      this.combinedPattern = new RegExp(parts.join('|'), 'g');
    }

    // Capture the maximum length for buffering purposes
    this.maxSecretLength = uniqueSecrets.reduce((max, s) => Math.max(max, s.length), 0);
  }

  /**
   * Redact all secrets from a string.
   * Returns empty string for null/undefined, converts non-strings to strings.
   */
  redact(text: string): string {
    // Handle null/undefined explicitly
    if (text === null || text === undefined) {
      return '';
    }

    // Handle non-strings by converting them
    if (typeof text !== 'string') {
      text = String(text);
    }

    if (!this.combinedPattern) {
      return text;
    }

    if (!this.hasShortSecrets && text.length < 3) {
      return text;
    }

    return text.replace(this.combinedPattern, '***REDACTED***');
  }

  /**
   * Redact secrets from any value (string, object, array)
   */
  redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redact(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }

    if (value !== null && typeof value === 'object') {
      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        redacted[key] = this.redactValue(val);
      }
      return redacted;
    }

    return value;
  }
}

/**
 * Buffer for streaming redaction
 * Ensures secrets split across chunks are properly masked
 */
export class RedactionBuffer {
  private buffer = '';
  private redactor: Redactor;

  constructor(redactor: Redactor) {
    this.redactor = redactor;
  }

  /**
   * Process a chunk of text and return the safe-to-print portion
   */
  process(chunk: string): string {
    // Append new chunk to buffer
    this.buffer += chunk;

    // Redact the entire buffer
    // This allows us to catch secrets that were completed by the new chunk
    const redactedBuffer = this.redactor.redact(this.buffer);

    // If buffer is smaller than max secret length, we can't be sure it's safe to output yet
    // (it might be the start of a secret)
    if (redactedBuffer.length < this.redactor.maxSecretLength) {
      this.buffer = redactedBuffer;
      return '';
    }

    // Keep the tail of the buffer (max secret length) to handle potential split secrets
    // Output everything before the tail
    const safeLength = redactedBuffer.length - this.redactor.maxSecretLength;
    const output = redactedBuffer.substring(0, safeLength);

    // Update buffer to just the tail
    this.buffer = redactedBuffer.substring(safeLength);

    return output;
  }

  /**
   * Flush any remaining content in the buffer
   * Call this when the stream ends
   */
  flush(): string {
    const final = this.redactor.redact(this.buffer);
    this.buffer = '';
    return final;
  }
}
