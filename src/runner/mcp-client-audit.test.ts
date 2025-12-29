import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import { MCPClient } from './mcp-client';

import { Readable, Writable } from 'node:stream';

describe('MCPClient Audit Fixes', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(child_process, 'spawn').mockReturnValue({
      stdout: new Readable({ read() {} }),
      stdin: new Writable({
        write(c, e, cb) {
          cb();
        },
      }),
      kill: () => {},
      on: () => {},
    } as unknown as child_process.ChildProcess);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('should filter sensitive environment variables', async () => {
    // Set temp environment variables
    process.env.TEST_API_KEY_LEAK = 'secret_value';
    process.env.TEST_SAFE_VAR = 'safe_value';
    process.env.TEST_TOKEN_XYZ = 'secret_token';

    try {
      await MCPClient.createLocal('node', [], { EXPLICIT_SECRET: 'allowed' });

      // Assert spawn arguments
      // args: [0]=command, [1]=args, [2]=options
      const call = spawnSpy.mock.lastCall;
      if (!call) throw new Error('spawn not called');

      const envArg = call[2].env;

      // Safe vars should remain
      expect(envArg.TEST_SAFE_VAR).toBe('safe_value');

      // Explicitly passed vars should remain
      expect(envArg.EXPLICIT_SECRET).toBe('allowed');

      // Sensitive vars should be filtered
      expect(envArg.TEST_API_KEY_LEAK).toBeUndefined();
      expect(envArg.TEST_TOKEN_XYZ).toBeUndefined();
    } finally {
      // Cleanup
      process.env.TEST_API_KEY_LEAK = undefined;
      process.env.TEST_SAFE_VAR = undefined;
      process.env.TEST_TOKEN_XYZ = undefined;
    }
  });

  it('should allow whitelisted sensitive vars if explicitly provided', async () => {
    process.env.TEST_API_KEY_LEAK = 'secret_value';

    try {
      // User explicitly asks to pass this env var
      await MCPClient.createLocal('node', [], {
        TEST_API_KEY_LEAK: process.env.TEST_API_KEY_LEAK as string,
      });

      const call = spawnSpy.mock.lastCall;
      if (!call) throw new Error('spawn not called');
      const envArg = call[2].env;

      expect(envArg.TEST_API_KEY_LEAK).toBe('secret_value');
    } finally {
      process.env.TEST_API_KEY_LEAK = undefined;
    }
  });
});

describe('MCPClient SSRF Protection', () => {
  it('should reject localhost URLs without allowInsecure', async () => {
    // HTTP localhost is rejected for not using HTTPS
    await expect(MCPClient.createRemote('http://localhost:8080/sse')).rejects.toThrow(
      /SSRF Protection.*HTTPS/
    );
    // HTTPS localhost is rejected for being localhost
    await expect(MCPClient.createRemote('https://localhost:8080/sse')).rejects.toThrow(
      /SSRF Protection.*localhost/
    );
  });

  it('should reject 127.0.0.1', async () => {
    await expect(MCPClient.createRemote('https://127.0.0.1:8080/sse')).rejects.toThrow(
      /SSRF Protection.*localhost/
    );
  });

  it('should reject private IP ranges (10.x.x.x)', async () => {
    await expect(MCPClient.createRemote('https://10.0.0.1:8080/sse')).rejects.toThrow(
      /SSRF Protection.*private/
    );
  });

  it('should reject private IP ranges (192.168.x.x)', async () => {
    await expect(MCPClient.createRemote('https://192.168.1.1:8080/sse')).rejects.toThrow(
      /SSRF Protection.*private/
    );
  });

  it('should reject private IP ranges (172.16-31.x.x)', async () => {
    await expect(MCPClient.createRemote('https://172.16.0.1:8080/sse')).rejects.toThrow(
      /SSRF Protection.*private/
    );
    await expect(MCPClient.createRemote('https://172.31.255.1:8080/sse')).rejects.toThrow(
      /SSRF Protection.*private/
    );
  });

  it('should reject cloud metadata endpoints', async () => {
    // 169.254.169.254 is caught by link-local IP range check
    await expect(
      MCPClient.createRemote('https://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(/SSRF Protection.*private/);
    // Also test the hostname-based metadata detection
    await expect(MCPClient.createRemote('https://metadata.google.internal/sse')).rejects.toThrow(
      /SSRF Protection.*metadata/
    );
  });

  it('should require HTTPS by default', async () => {
    await expect(MCPClient.createRemote('http://api.example.com/sse')).rejects.toThrow(
      /SSRF Protection.*HTTPS/
    );
  });

  it('should allow HTTP with allowInsecure option', async () => {
    // This will fail due to network issues, not SSRF
    const promise = MCPClient.createRemote(
      'http://api.example.com/sse',
      {},
      100, // short timeout
      { allowInsecure: true }
    );
    // Should NOT throw SSRF error, but will throw timeout/connection error
    await expect(promise).rejects.not.toThrow(/SSRF Protection/);
  });
});
