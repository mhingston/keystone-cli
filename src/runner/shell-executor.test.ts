import { describe, expect, it } from 'bun:test';
import type { ExpressionContext } from '../expression/evaluator';
import type { ShellStep } from '../parser/schema';
import { escapeShellArg, executeShell } from './executors/shell-executor.ts';

describe('shell-executor', () => {
  describe('escapeShellArg', () => {
    it('should wrap in single quotes', () => {
      expect(escapeShellArg('hello')).toBe("'hello'");
    });

    it('should escape single quotes', () => {
      expect(escapeShellArg("don't")).toBe("'don'\\''t'");
    });
  });

  describe('executeShell', () => {
    const context: ExpressionContext = {
      inputs: {},
      steps: {},
      env: {},
    };

    it('should execute a simple command', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo "hello world"',
      };

      const result = await executeShell(step, context);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('should evaluate expressions in the command', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo "${{ inputs.name }}"',
      };
      const customContext: ExpressionContext = {
        ...context,
        inputs: { name: 'world' },
      };

      const result = await executeShell(step, customContext);
      expect(result.stdout.trim()).toBe('world');
    });

    it('should handle environment variables', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo $TEST_VAR',
        env: {
          TEST_VAR: 'env-value',
        },
      };

      const result = await executeShell(step, context);
      expect(result.stdout.trim()).toBe('env-value');
    });

    it('should handle working directory', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'pwd',
        dir: '/tmp',
      };

      const result = await executeShell(step, context);
      expect(result.stdout.trim()).toMatch(/\/tmp$/);
    });

    it('should capture stderr', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo "error" >&2',
      };

      const result = await executeShell(step, context);
      expect(result.stderr.trim()).toBe('error');
    });

    it('should handle non-zero exit codes', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'exit 1',
      };

      const result = await executeShell(step, context);
      expect(result.exitCode).toBe(1);
    });

    it('should throw error on shell injection risk', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo "hello" ; rm -rf /tmp/foo',
      };

      await expect(executeShell(step, context)).rejects.toThrow(/Security Error/);
    });

    it('should allow legitimate shell variable expansion like ${HOME}', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo ${HOME}',
      };

      // Should NOT throw - ${HOME} is legitimate
      const result = await executeShell(step, context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(Bun.env.HOME || '');
    });

    it('should still block dangerous parameter expansion like ${IFS}', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'echo ${IFS}',
      };

      await expect(executeShell(step, context)).rejects.toThrow(/Security Error/);
    });
    it('should allow flow control with semicolons', async () => {
      const step: ShellStep = {
        id: 'test',
        type: 'shell',
        needs: [],
        run: 'if [ "1" = "1" ]; then echo "match"; fi',
      };

      const result = await executeShell(step, context);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('match');
    });
  });
});
