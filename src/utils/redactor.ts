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
  public static readonly REDACTED_PLACEHOLDER = '***REDACTED***';
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
    // ReDoS Safety: We escape all special characters, so the regex consists purely of literal strings (alternations).
    // This avoids backtracking issues common in ReDoS attacks.
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
      // Note: If thousands of secrets are present, this regex compilation might be slow,
      // but it remains safe from catastrophic backtracking due to being a simple alternation of literals.
      this.combinedPattern = new RegExp(parts.join('|'), 'g');
    }

    // Capture the maximum length for buffering purposes
    this.maxSecretLength = uniqueSecrets.reduce((max, s) => Math.max(max, s.length), 0);
  }

  /**
   * Redact all secrets from a string.
   * Returns empty string for null/undefined, converts non-strings to strings.
   * @param text - The value to redact. Non-strings are converted to strings.
   */
  redact(text: unknown): string {
    // Handle null/undefined explicitly
    if (text === null || text === undefined) {
      return '';
    }

    // Handle non-strings by converting them
    const strText = typeof text === 'string' ? text : String(text);

    if (!this.combinedPattern) {
      return strText;
    }

    if (!this.hasShortSecrets && strText.length < 3) {
      return strText;
    }

    return strText.replace(this.combinedPattern, Redactor.REDACTED_PLACEHOLDER);
  }

  /**
   * Redact secrets from any value (string, object, array), preserving the original type.
   *
   * Unlike {@link redact}, this method preserves the structure and type of the input:
   * - Strings are passed through `redact()` and returned as strings
   * - Arrays are recursively processed, maintaining array structure
   * - Objects are recursively processed, maintaining object structure
   * - Primitives (numbers, booleans, null, undefined) are returned unchanged
   *
   * This is the recommended method for redacting complex data structures like
   * step outputs before storage, as it preserves JSON serializability.
   */
  redactValue(value: unknown, visited = new WeakSet<object>()): unknown {
    if (typeof value === 'string') {
      return this.redact(value);
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Handle circular references
    if (visited.has(value)) {
      return '[Circular]';
    }
    visited.add(value);

    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.redactValue(item, visited));
      }

      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        redacted[key] = this.redactValue(val, visited);
      }
      return redacted;
    } finally {
      // Optional: remove from visited if we want to allow the same object
      // in different branches of the tree (DAG), but strictly strictly strictly
      // to prevent infinite recursion, keeping it in visited is safer and faster.
      // However, JSON.stringify behavior is to only block ancestors.
      // For deep recursion protection, consistent with JSON.stringify's cycle detection,
      // we should arguably NOT remove it if we want to blocking *any* recurrence,
      // but to match JSON.stringify "circular" error, strictly it's ancestors.
      // However, for a Redactor, reusing the same object instance in multiple places is fine.
      // The issue is strictly CYCLES.
      // So we should remove it from visited on exit to support DAGs?
      // Actually, JSON.stringify throws on cycles. We want to return "[Circular]".
      // Let's stick to safe cycle detection which requires tracking the current stack.
      // BUT, `visited` is passed down. If we don't remove it, we block non-circular DAGs (diamond problem).
      // e.g. A -> B, A -> C, B -> D, C -> D. D is visited twice.
      // So we SHOULD remove it.
      // wait, WeakSet doesn't have .delete? Yes it does.
      visited.delete(value);
    }
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
