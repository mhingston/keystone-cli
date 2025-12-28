import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineStep } from '../parser/schema';
import { executeEngineStep } from './executors/engine-executor.ts';

// Helper to create a minimal valid EngineStep for testing
const createStep = (overrides: Partial<EngineStep>): EngineStep =>
  ({
    id: 'test',
    type: 'engine',
    command: 'echo',
    args: [],
    cwd: '/tmp',
    env: { PATH: '/usr/bin' },
    needs: [],
    ...overrides,
  }) as EngineStep;

describe('engine-executor', () => {
  const tempDir = join(tmpdir(), `engine-test-${Date.now()}`);

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('executeEngineStep', () => {
    it('should reject if aborted before execution', async () => {
      const controller = new AbortController();
      controller.abort();

      const step = createStep({
        cwd: '.',
        env: { PATH: '/usr/bin' },
      });

      await expect(
        executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          {
            abortSignal: controller.signal,
          }
        )
      ).rejects.toThrow('Step canceled');
    });

    it('should reject if cwd is not provided', async () => {
      const step = createStep({
        cwd: '',
        env: { PATH: '/usr/bin' },
      });

      await expect(
        executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
      ).rejects.toThrow('requires an explicit cwd');
    });

    it('should reject if env is not provided', async () => {
      const step = createStep({
        cwd: '/tmp',
        env: undefined as unknown as Record<string, string>,
      });

      await expect(
        executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
      ).rejects.toThrow('requires an explicit env');
    });

    it('should reject if PATH is not in env for non-absolute command', async () => {
      const step = createStep({
        cwd: '/tmp',
        env: { HOME: '/home' },
      });

      await expect(
        executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
      ).rejects.toThrow('requires env.PATH');
    });

    it('should reject if command is denied', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: ['rm', 'dd'],
          allowlist: {},
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        const step = createStep({
          command: 'rm',
          args: ['-rf', '/'],
          cwd: '/tmp',
          env: { PATH: '/usr/bin' },
        });

        await expect(
          executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
        ).rejects.toThrow('denied by engines.denylist');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should reject if command is not in allowlist', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            python: { command: 'python3', version: '3.11', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        const step = createStep({
          command: 'node',
          cwd: '/tmp',
          env: { PATH: '/usr/bin' },
        });

        await expect(
          executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
        ).rejects.toThrow('not in the allowlist');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should match allowlist by basename', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['hello'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should reject on version mismatch', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '999.0.0', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['hello'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        await expect(
          executeEngineStep(
            step,
            { inputs: {}, secrets: {}, env: {}, steps: {} },
            { artifactRoot: tempDir }
          )
        ).rejects.toThrow('version mismatch');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should parse JSON summary from stdout', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['{"result": "success"}'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.summary).toEqual({ result: 'success' });
        expect(result.summarySource).toBe('stdout');
        expect(result.summaryFormat).toBe('json');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should parse YAML summary from stdout', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            sh: { command: 'sh', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/sh',
          args: ['-c', 'echo "result: success"; echo "count: 42"'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.summary).toEqual({ result: 'success', count: 42 });
        expect(result.summaryFormat).toBe('yaml');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should handle summary file over stdout', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            sh: { command: 'sh', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/sh',
          args: [
            '-c',
            'echo \'{"from": "file"}\' > $KEYSTONE_ENGINE_SUMMARY_PATH && echo \'{"from": "stdout"}\'',
          ],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.summary).toEqual({ from: 'file' });
        expect(result.summarySource).toBe('file');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should handle invalid summary gracefully', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['not valid json or yaml :: %%'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.summary).toBeNull();
        expect(result.summaryError).toBeDefined();
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should apply redactForStorage to summary', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['{"secret": "password123"}'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const redactForStorage = mock((value: unknown) => {
          if (typeof value === 'object' && value !== null) {
            return { ...(value as object), secret: '[REDACTED]' };
          }
          return value;
        });

        await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir, redactForStorage }
        );

        expect(redactForStorage).toHaveBeenCalled();
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should evaluate expressions in command args', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: '', versionArgs: [], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['${{ inputs.message }}'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: { message: 'Hello, World!' }, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.stdout).toContain('Hello, World!');
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should use custom versionArgs from allowlist', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: [],
          allowlist: {
            echo: { command: 'echo', version: 'test', versionArgs: ['test'], args: [] },
          },
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        mkdirSync(tempDir, { recursive: true });
        const step = createStep({
          command: '/bin/echo',
          args: ['hello'],
          cwd: tempDir,
          env: { PATH: '/bin:/usr/bin' },
        });

        const result = await executeEngineStep(
          step,
          { inputs: {}, secrets: {}, env: {}, steps: {} },
          { artifactRoot: tempDir }
        );

        expect(result.exitCode).toBe(0);
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('should handle wildcard patterns in denylist', async () => {
      const ConfigLoader = await import('../utils/config-loader');
      const loadSpy = spyOn(ConfigLoader.ConfigLoader, 'load').mockReturnValue({
        engines: {
          denylist: ['rm*', '*/rm'],
          allowlist: {},
        },
      } as ReturnType<typeof ConfigLoader.ConfigLoader.load>);

      try {
        const step = createStep({
          command: 'rmdir',
          cwd: '/tmp',
          env: { PATH: '/usr/bin' },
        });

        await expect(
          executeEngineStep(step, { inputs: {}, secrets: {}, env: {}, steps: {} })
        ).rejects.toThrow('denied by engines.denylist');
      } finally {
        loadSpy.mockRestore();
      }
    });
  });
});
