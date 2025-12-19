import { describe, expect, it } from 'bun:test';
import { Redactor } from './redactor';

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

  it('should ignore secrets shorter than 3 characters', () => {
    const shortRedactor = new Redactor({ S1: 'a', S2: '12', S3: 'abc' });
    const text = 'a and 12 are safe, but abc is a secret';
    expect(shortRedactor.redact(text)).toBe('a and 12 are safe, but ***REDACTED*** is a secret');
  });

  it('should not redact substrings of larger words when using alphanumeric secrets', () => {
    const wordRedactor = new Redactor({ USER: 'mark' });
    const text = 'mark went to the marketplace';
    expect(wordRedactor.redact(text)).toBe('***REDACTED*** went to the marketplace');
  });
});
