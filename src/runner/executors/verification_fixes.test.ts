import { describe, expect, test } from 'bun:test';
import { validateRemoteUrl } from '../mcp-client';
import { executeShell } from './shell-executor';

describe('Verification Fixes', () => {
  describe('SSRF Protection (mcp-client)', () => {
    test('validateRemoteUrl should throw on 127.0.0.1', async () => {
      expect(validateRemoteUrl('https://127.0.0.1')).rejects.toThrow('SSRF Protection');
    });

    test('validateRemoteUrl should throw on localhost', async () => {
      expect(validateRemoteUrl('https://localhost')).rejects.toThrow('SSRF Protection');
    });

    test('validateRemoteUrl should throw on metadata IP', async () => {
      expect(validateRemoteUrl('https://169.254.169.254')).rejects.toThrow('SSRF Protection');
    });
  });

  describe('Shell Path Traversal (shell-executor)', () => {
    const mockContext = { env: {}, steps: {}, inputs: {}, envOverrides: {}, secrets: {} };

    test('should block command with ".." and "/" in secure mode', async () => {
      const step = {
        id: 'test',
        type: 'shell' as const,
        run: 'cat ../secret.txt',
        allowInsecure: false,
      };
      // It should throw BEFORE spawning
      // The error message I added was "Directory Traversal" or similar
      // Let's check the implementation: "Command blocked due to potential directory traversal"
      await expect(executeShell(step, mockContext)).rejects.toThrow('Command blocked');
    });

    test('should block absolute path with ".." in secure mode', async () => {
      const step = {
        id: 'test',
        type: 'shell' as const,
        run: '/bin/ls ../',
        allowInsecure: false,
      };
      await expect(executeShell(step, mockContext)).rejects.toThrow('Command blocked');
    });
  });
});
