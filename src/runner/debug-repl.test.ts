import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ExpressionContext } from '../expression/evaluator.ts';
import type { Step } from '../parser/schema.ts';
import type { Logger } from '../utils/logger.ts';
import { DebugRepl } from './debug-repl.ts';

describe('DebugRepl', () => {
  const mockContext: ExpressionContext = { inputs: { foo: 'bar' } };
  // mock step typing
  const mockStep: Step = { id: 'test-step', type: 'shell', run: 'echo "fail"' } as unknown as Step;
  const mockError = new Error('Test Error');

  test('should resolve with "skip" when user types "skip"', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    const promise = repl.start();

    // Wait a tick for prompt
    await new Promise((r) => setTimeout(r, 10));

    input.write('skip\n');

    const result = await promise;
    expect(result).toEqual({ type: 'skip' });
  });

  test('should resolve with "retry" when user types "retry"', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    const promise = repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('retry\n');

    const result = await promise;
    expect(result.type).toBe('retry');
    if (result.type === 'retry') {
      expect(result.modifiedStep).toBe(mockStep);
    }
  });

  test('should resolve with "continue_failure" when user types "exit"', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    const promise = repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('exit\n');

    const result = await promise;
    expect(result).toEqual({ type: 'continue_failure' });
  });

  test('should handle "context" command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('context\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.log).toHaveBeenCalled();
    const lastCall = (
      (mockLogger.log as unknown as { mock: { calls: any[][] } }).mock.calls as any[][]
    ).find((call: any[]) => String(call[0]).includes('foo'));
    expect(lastCall?.[0]).toContain('bar');
    input.write('exit\n');
  });

  test('should handle "eval" command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('eval inputs.foo\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.log).toHaveBeenCalledWith('bar');
    input.write('exit\n');
  });

  test('should handle "eval" command with error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('eval nonExistent.bar\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.error).toHaveBeenCalled();
    input.write('exit\n');
  });

  test('should handle "eval" command without arguments', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('eval\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.log).toHaveBeenCalledWith('Usage: eval <expression>');
    input.write('exit\n');
  });

  test('should handle unknown command', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('unknown_cmd\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.log).toHaveBeenCalledWith('Unknown command: unknown_cmd');
    input.write('exit\n');
  });

  test('should handle empty input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    repl.start();

    await new Promise((r) => setTimeout(r, 10));
    input.write('\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.log).not.toHaveBeenCalledWith('Unknown command: ');
    input.write('exit\n');
  });

  test('should parse shell commands correctly', () => {
    // We import the function dynamically to test it, or we assume it's exported
    const { parseShellCommand } = require('./debug-repl.ts');

    expect(parseShellCommand('code')).toEqual(['code']);
    expect(parseShellCommand('code --wait')).toEqual(['code', '--wait']);
    expect(parseShellCommand('code --wait "some file"')).toEqual(['code', '--wait', 'some file']);
    expect(parseShellCommand("vim 'my file'")).toEqual(['vim', 'my file']);
    expect(parseShellCommand('editor -a -b -c')).toEqual(['editor', '-a', '-b', '-c']);
    expect(parseShellCommand('  spaced   command  ')).toEqual(['spaced', 'command']);
  });

  test('should handle "edit" command and update step', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    const spySpawnSync = spyOn(cp, 'spawnSync').mockImplementation(
      () => ({ error: null, status: 0 }) as unknown as cp.SpawnSyncReturns<Buffer>
    );
    const spyWriteFileSync = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const updatedStep = { ...mockStep, run: 'echo "fixed"' };
    const spyReadFileSync = spyOn(fs, 'readFileSync').mockImplementation((() =>
      JSON.stringify(updatedStep)) as unknown as typeof fs.readFileSync);
    const spyExistsSync = spyOn(fs, 'existsSync').mockImplementation(() => true);
    const spyUnlinkSync = spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    try {
      repl.start();
      await new Promise((r) => setTimeout(r, 50));
      input.write('edit\n');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Step definition updated')
      );

      input.write('retry\n');
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      spySpawnSync.mockRestore();
      spyWriteFileSync.mockRestore();
      spyReadFileSync.mockRestore();
      spyExistsSync.mockRestore();
      spyUnlinkSync.mockRestore();
    }
  });

  test('should handle "edit" command with parse error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mockLogger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const repl = new DebugRepl(mockContext, mockStep, mockError, mockLogger, input, output);

    const spySpawnSync = spyOn(cp, 'spawnSync').mockImplementation(
      () => ({ error: null, status: 0 }) as unknown as cp.SpawnSyncReturns<Buffer>
    );
    const spyWriteFileSync = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const spyReadFileSync = spyOn(fs, 'readFileSync').mockImplementation(
      (() => 'invalid json') as unknown as typeof fs.readFileSync
    );
    const spyExistsSync = spyOn(fs, 'existsSync').mockImplementation(() => true);
    const spyUnlinkSync = spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    try {
      repl.start();
      await new Promise((r) => setTimeout(r, 50));
      input.write('edit\n');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse JSON')
      );
      input.write('exit\n');
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      spySpawnSync.mockRestore();
      spyWriteFileSync.mockRestore();
      spyReadFileSync.mockRestore();
      spyExistsSync.mockRestore();
      spyUnlinkSync.mockRestore();
    }
  });
});
