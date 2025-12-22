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
      // biome-ignore lint/suspicious/noExplicitAny: Mocking complex object
    } as any);
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
