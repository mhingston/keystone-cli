import { RedactionBuffer, Redactor } from '../../utils/redactor';

export class SecretManager {
  private secretValues: string[] = [];
  private redactor: Redactor;

  constructor(private initialSecrets: Record<string, string> = {}) {
    this.redactor = new Redactor(initialSecrets, { forcedSecrets: [] });
  }

  public static collectSecretValues(
    value: unknown,
    sink: Set<string>,
    seen: WeakSet<object> = new WeakSet()
  ): void {
    if (value === null || value === undefined) return;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sink.add(String(value));
      return;
    }

    if (typeof value !== 'object') return;

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        SecretManager.collectSecretValues(item, sink, seen);
      }
      return;
    }

    for (const item of Object.values(value as Record<string, unknown>)) {
      SecretManager.collectSecretValues(item, sink, seen);
    }
  }

  public loadSecrets(optionsSecrets: Record<string, string> = {}): Record<string, string> {
    const secrets: Record<string, string> = { ...this.initialSecrets, ...optionsSecrets };

    // Strict allowlist for safe system environment variables
    const safeSystemVars = ['PATH', 'HOME', 'PWD', 'SHELL', 'LANG', 'TZ'];
    for (const key of safeSystemVars) {
      const value = process.env[key];
      if (value) {
        secrets[key] = value;
      }
    }

    // Include pattern-matched secrets from Bun.env (safe-ish way to get common secrets)
    const secretPatterns = [/token/i, /key/i, /secret/i, /password/i, /auth/i, /api/i];
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value && secretPatterns.some((p) => p.test(key))) {
        // Skip common system non-secret variables that might match patterns
        if (safeSystemVars.includes(key)) continue;
        secrets[key] = value;
      }
    }

    return secrets;
  }

  public getSecrets(optionsSecrets: Record<string, string> = {}): Record<string, string> {
    return this.loadSecrets(optionsSecrets);
  }

  public getRedactor(): Redactor {
    return this.redactor;
  }

  public setSecretValues(values: string[]): void {
    this.secretValues = values;
    this.redactor = new Redactor(this.initialSecrets, { forcedSecrets: this.secretValues });
  }

  public getSecretValues(): string[] {
    return this.secretValues;
  }

  public redact(content: string): string {
    return this.redactor.redact(content);
  }

  public createRedactionBuffer(): RedactionBuffer {
    return new RedactionBuffer(this.redactor);
  }
  public redactAtRest = true;

  /**
   * Redact secrets from a value for storage (if enabled)
   */
  public redactForStorage<T>(value: T): T {
    if (!this.redactAtRest) return value;
    return this.redactor.redactValue(value) as T;
  }

  /**
   * Redact secrets from a value
   */
  public redactValue<T>(value: T): T {
    return this.redactor.redactValue(value) as T;
  }
}
