/**
 * Redactor for masking secrets in output strings
 *
 * This utility helps prevent secret leakage by replacing secret values
 * with masked strings before they are logged or stored in the database.
 */

export class Redactor {
  private secrets: string[];

  constructor(secrets: Record<string, string>) {
    // Extract all secret values (not keys) and sort by length descending
    // to ensure longer secrets are matched first.
    // Filter out very short secrets (length < 3) to avoid redacting common words/numbers.
    this.secrets = Object.values(secrets)
      .filter((value) => value && value.length >= 3)
      .sort((a, b) => b.length - a.length);
  }

  /**
   * Redact all secrets from a string
   */
  redact(text: string): string {
    if (!text || typeof text !== 'string') {
      return text;
    }

    let redacted = text;
    for (const secret of this.secrets) {
      // Use a global replace to handle multiple occurrences
      // Escape special regex characters in the secret
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Use word boundaries if the secret starts/ends with an alphanumeric character
      // to avoid partial matches (e.g. redacting 'mark' in 'marketplace')
      const startBoundary = /^\w/.test(secret) ? '\\b' : '';
      const endBoundary = /\w$/.test(secret) ? '\\b' : '';

      redacted = redacted.replace(
        new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'g'),
        '***REDACTED***'
      );
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
