/**
 * Redactor for masking secrets in output strings
 *
 * This utility helps prevent secret leakage by replacing secret values
 * with masked strings before they are logged or stored in the database.
 */

export class Redactor {
  private patterns: RegExp[] = [];

  constructor(secrets: Record<string, string>) {
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

    // Extract all secret values
    // We filter based on:
    // 1. Value must be a string and not empty
    // 2. Either the key indicates high sensitivity OR length >= 3
    const secretsToRedact = new Set<string>();

    for (const [key, value] of Object.entries(secrets)) {
      if (!value) continue;

      const lowerKey = key.toLowerCase();
      // Check if key contains any sensitive term
      const isSensitiveKey = Array.from(sensitiveKeys).some((k) => lowerKey.includes(k));

      if (isSensitiveKey || value.length >= 3) {
        secretsToRedact.add(value);
      }
    }

    const uniqueSecrets = Array.from(secretsToRedact).sort((a, b) => b.length - a.length);

    for (const secret of uniqueSecrets) {
      // Escape special regex characters in the secret
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Use word boundaries if the secret starts/ends with an alphanumeric character
      // to avoid partial matches (e.g. redacting 'mark' in 'marketplace')
      // BUT only if length is small (< 5), otherwise matching inside strings is desirable
      let pattern: RegExp;
      if (secret.length < 5) {
        const startBoundary = /^\w/.test(secret) ? '\\b' : '';
        const endBoundary = /\w$/.test(secret) ? '\\b' : '';
        pattern = new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'g');
      } else {
        pattern = new RegExp(escaped, 'g');
      }

      this.patterns.push(pattern);
    }

    // Capture the maximum length for buffering purposes
    this.maxSecretLength = uniqueSecrets.reduce((max, s) => Math.max(max, s.length), 0);
  }

  public readonly maxSecretLength: number;

  /**
   * Redact all secrets from a string
   */
  redact(text: string): string {
    if (!text || typeof text !== 'string' || text.length < 3) {
      return text;
    }

    let redacted = text;
    for (const pattern of this.patterns) {
      redacted = redacted.replace(pattern, '***REDACTED***');
    }
    return redacted;
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
