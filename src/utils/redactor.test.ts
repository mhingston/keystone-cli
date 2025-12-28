import { describe, expect, it } from 'bun:test';
import { Redactor, RedactionBuffer } from './redactor';

describe('Redactor', () => {
  const secrets = {
    API_KEY: 'sk-123456789',
    PASSWORD: 'p4ssw0rd-unique',
    TOKEN: 'tkn-abc-123',
  };

  const redactor = new Redactor(secrets);

  it('should redact secrets from a string', () => {
    const text = 'Your API key is sk-123456789 and your password is p4ssw0rd-unique.';
    const redacted = redactor.redact(text);
    expect(redacted).toBe('Your API key is ***REDACTED*** and your password is ***REDACTED***.');
  });

  it('should handle special regex characters in secrets', () => {
    const specialRedactor = new Redactor({ S1: 'secret.with*special+chars' });
    const text = 'My secret is secret.with*special+chars';
    expect(specialRedactor.redact(text)).toBe('My secret is ***REDACTED***');
  });

  it('should redact longer secrets first', () => {
    // If we have 'abc' and 'abc-longer' as secrets
    const redactor2 = new Redactor({ S1: 'abc', S2: 'abc-longer' });
    const text = 'Value: abc-longer';
    expect(redactor2.redact(text)).toBe('Value: ***REDACTED***');
  });

  it('should redact complex values recursively', () => {
    const value = {
      nested: {
        key: 'sk-123456789',
        list: ['p4ssw0rd-unique', 'safe'],
      },
      array: ['tkn-abc-123', 'def'],
    };
    const redacted = redactor.redactValue(value);
    expect(redacted).toEqual({
      nested: {
        key: '***REDACTED***',
        list: ['***REDACTED***', 'safe'],
      },
      array: ['***REDACTED***', 'def'],
    });
  });

  it('should handle non-string values gracefully', () => {
    expect(redactor.redactValue(123)).toBe(123);
    expect(redactor.redactValue(true)).toBe(true);
    expect(redactor.redactValue(null)).toBe(null);
  });

  it('should return input as is if not a string for redact', () => {
    // @ts-ignore
    expect(redactor.redact(123)).toBe(123);
  });

  it('should ignore secrets shorter than 6 characters for sensitive keys', () => {
    // Minimum secret length for sensitive keys is 6 to reduce false positives
    const shortRedactor = new Redactor({ S1: 'a', S2: '12', TOKEN: 'abc', SECRET: 'secret' });
    const text = 'a and 12 and abc are safe, but secret is redacted';
    expect(shortRedactor.redact(text)).toBe(
      'a and 12 and abc are safe, but ***REDACTED*** is redacted'
    );
  });

  it('should not redact substrings of larger words when using alphanumeric secrets', () => {
    const wordRedactor = new Redactor({ USER: 'mark-long-enough' });
    const text = 'mark-long-enough went to the marketplace';
    expect(wordRedactor.redact(text)).toBe('***REDACTED*** went to the marketplace');
  });

  it('should NOT redact common words in the blocklist', () => {
    const blocklistRedactor = new Redactor({
      STATUS: 'success',
      DEBUG: 'true',
      LEVEL: 'info',
    });
    const text = 'Operation was a success with info level and true flag';
    expect(blocklistRedactor.redact(text)).toBe(text);
  });

  it('should redact forced secrets regardless of length or blocklist', () => {
    const forcedRedactor = new Redactor({}, { forcedSecrets: ['ok', 'true'] });
    expect(forcedRedactor.redact('ok')).toBe('***REDACTED***');
    expect(forcedRedactor.redact('true')).toBe('***REDACTED***');
  });

  it('should redact values >= 6 chars for sensitive keys, >= 10 for others', () => {
    const mixedRedactor = new Redactor({
      PASSWORD: 'secret', // sensitive key, 6 chars - should be redacted
      TOKEN: 'abc', // sensitive key, 3 chars - too short, not redacted
      OTHER: 'def', // non-sensitive key, short value
      LONG: 'this-is-long-enough', // non-sensitive, long value
    });
    const text = 'pwd: secret, token: abc, other: def, long: this-is-long-enough';
    expect(mixedRedactor.redact(text)).toBe(
      'pwd: ***REDACTED***, token: abc, other: def, long: ***REDACTED***'
    );
  });

  it('should ignore non-sensitive values shorter than 10 characters', () => {
    const thresholdRedactor = new Redactor({
      S1: '123456789', // 9 chars
      S2: '1234567890', // 10 chars
    });
    const text = 'S1 is 123456789 and S2 is 1234567890';
    expect(thresholdRedactor.redact(text)).toBe('S1 is 123456789 and S2 is ***REDACTED***');
  });

  it('should respect word boundaries for short-ish secrets >= 6 chars', () => {
    // Secrets 6+ chars with sensitive key should be redacted, word boundaries apply for < 5 chars
    const shortRedactor = new Redactor({ TOKEN: 'keeper' }); // 'keeper' is 6 chars, TOKEN is sensitive
    const text = 'The keeper of the keys is here.';
    expect(shortRedactor.redact(text)).toBe('The ***REDACTED*** of the keys is here.');
  });
});

describe('RedactionBuffer', () => {
  const redactor = new Redactor({ SECRET: 'super-secret-value' });

  it(' should redact secrets across chunks', () => {
    const buffer = new RedactionBuffer(redactor);
    const chunk1 = 'This is sup';
    const chunk2 = 'er-secret-value in parts.';

    const out1 = buffer.process(chunk1);
    const out2 = buffer.process(chunk2);
    const out3 = buffer.flush();

    expect(out1 + out2 + out3).toContain('***REDACTED***');
    expect(out1 + out2 + out3).not.toContain('super-secret-value');
  });

  it('should not leak partial secrets in process()', () => {
    const buffer = new RedactionBuffer(redactor);
    // Secret is 18 chars long.
    // 'super-s' is 7 chars.
    const chunk = 'super-s';
    const output = buffer.process(chunk);

    // Should not output anything if it could be the start of a secret
    expect(output).toBe('');
    expect(buffer.flush()).toBe('super-s');
  });

  it('should handle multiple secrets in stream', () => {
    const multiRedactor = new Redactor({ S1: 'secret-one', S2: 'secret-two' });
    const buffer = new RedactionBuffer(multiRedactor);

    const text = 'S1: secret-one, S2: secret-two';
    const out1 = buffer.process(text.substring(0, 15));
    const out2 = buffer.process(text.substring(15));
    const out3 = buffer.flush();

    const full = out1 + out2 + out3;
    expect(full).toBe('S1: ***REDACTED***, S2: ***REDACTED***');
  });
});
