import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ConfigSchema } from '../../src/parser/config-schema';
import { executeShellStep } from '../../src/runner/executors/shell-executor';
import { ConfigLoader } from '../../src/utils/config-loader';
import { ConsoleLogger } from '../../src/utils/logger';

describe('ShellExecutor Security Fixes', () => {
  const logger = new ConsoleLogger();
  const context = {
    inputs: {},
    secrets: {},
    env: {},
    steps: {},
  };

  beforeEach(() => {
    // Reset config before each test
    ConfigLoader.clear();
  });

  afterEach(() => {
    ConfigLoader.clear();
  });

  test('should block commands in the denylist', async () => {
    // Mock config with denylist
    ConfigLoader.setConfig(
      ConfigSchema.parse({
        engines: {
          denylist: ['rm', 'forbidden_cmd'],
        },
      })
    );

    const step = {
      id: 'test',
      type: 'shell' as const,
      run: 'rm -rf /tmp/test',
    };

    try {
      await executeShellStep(step, context, logger);
      throw new Error('Should have thrown security error');
    } catch (err: any) {
      expect(err.message).toContain('Security Error');
      expect(err.message).toContain('denylist');
      expect(err.message).toContain('rm');
    }
  });

  test('should allow listed commands if not in denylist', async () => {
    // Mock config
    ConfigLoader.setConfig(
      ConfigSchema.parse({
        engines: {
          denylist: ['forbidden'],
        },
      })
    );

    const step = {
      id: 'test',
      type: 'shell' as const,
      run: 'echo "hello"',
    };

    const result = await executeShellStep(step, context, logger);
    expect(result.status).toBe('success');
  });
});
