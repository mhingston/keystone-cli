import { describe, expect, it, mock, spyOn } from 'bun:test';
import { Redactor } from '../utils/redactor';
import { SafeSandbox } from '../utils/sandbox';
import { MCPManager } from './mcp-manager';

// Type for accessing private methods in tests
type MCPManagerPrivate = {
  getServerKey(config: {
    name: string;
    type?: 'local' | 'remote';
    command?: string;
    args?: string[];
    url?: string;
  }): string;
};

describe('Audit Fixes Verification', () => {
  describe('Secret Redaction', () => {
    it('should redact secrets in text', () => {
      const secrets = { MY_SECRET: 'super-secret-value' };
      const redactor = new Redactor(secrets);

      const input = 'This contains super-secret-value in the text.';
      const result = redactor.redact(input);

      expect(result).toContain('***REDACTED***');
      expect(result).not.toContain('super-secret-value');
    });

    it('should handle partial matches correctly', () => {
      const secrets = { MY_SECRET: 'abc123' };
      const redactor = new Redactor(secrets);

      const input = 'The value abc123 should be redacted.';
      const result = redactor.redact(input);

      expect(result).toContain('***REDACTED***');
      expect(result).not.toContain('abc123');
    });
  });

  describe('Sandbox Security', () => {
    it('should throw by default if isolated-vm is missing and insecure fallback is disabled', async () => {
      const code = '1 + 1';
      expect(SafeSandbox.execute(code, {}, { allowInsecureFallback: false })).rejects.toThrow(
        /secure sandbox failed/
      );
    });

    it('should allow execution if allowInsecureFallback is true', async () => {
      const code = '1 + 1';
      const result = await SafeSandbox.execute(code, {}, { allowInsecureFallback: true });
      expect(result).toBe(2);
    });
  });

  describe('MCP Client Uniqueness', () => {
    it('should generate unique keys for different ad-hoc configs with same name', async () => {
      const manager = new MCPManager();

      const config1 = {
        name: 'test-server',
        type: 'local' as const,
        command: 'echo',
        args: ['hello'],
      };

      const config2 = {
        name: 'test-server',
        type: 'local' as const,
        command: 'echo',
        args: ['world'],
      };

      const key1 = (manager as unknown as MCPManagerPrivate).getServerKey(config1);
      const key2 = (manager as unknown as MCPManagerPrivate).getServerKey(config2);

      expect(key1).not.toBe(key2);
      expect(key1).toContain('hello');
      expect(key2).toContain('world');
    });

    it('should generate unique keys for remote servers', async () => {
      const manager = new MCPManager();

      const config1 = {
        name: 'remote-server',
        type: 'remote' as const,
        url: 'https://api1.example.com',
      };

      const config2 = {
        name: 'remote-server',
        type: 'remote' as const,
        url: 'https://api2.example.com',
      };

      const key1 = (manager as unknown as MCPManagerPrivate).getServerKey(config1);
      const key2 = (manager as unknown as MCPManagerPrivate).getServerKey(config2);

      expect(key1).not.toBe(key2);
      expect(key1).toContain('api1');
      expect(key2).toContain('api2');
    });
  });
});
