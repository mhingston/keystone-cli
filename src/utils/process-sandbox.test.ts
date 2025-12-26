import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';
import { ProcessSandbox } from './process-sandbox';

describe('ProcessSandbox', () => {
  it('should execute basic arithmetic', async () => {
    const result = await ProcessSandbox.execute('return 1 + 2', {});
    expect(result).toBe(3);
  });

  it('should have access to context variables', async () => {
    const result = await ProcessSandbox.execute('return a + b', { a: 10, b: 20 });
    expect(result).toBe(30);
  });

  it('should handle object results', async () => {
    const result = await ProcessSandbox.execute('return { x: 1, y: 2 }', {});
    expect(result).toEqual({ x: 1, y: 2 });
  });

  it('should handle array results', async () => {
    const result = await ProcessSandbox.execute('return [1, 2, 3]', {});
    expect(result).toEqual([1, 2, 3]);
  });

  it('should handle async code', async () => {
    const result = await ProcessSandbox.execute('return await Promise.resolve(42)', {});
    expect(result).toBe(42);
  });

  it('should respect timeouts', async () => {
    const promise = ProcessSandbox.execute('while(true) {}', {}, { timeout: 100 });
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it('should handle script errors gracefully', async () => {
    const promise = ProcessSandbox.execute('throw new Error("test error")', {});
    await expect(promise).rejects.toThrow(/test error/);
  });

  it('should handle undefined variables', async () => {
    const promise = ProcessSandbox.execute('return undefinedVar', {});
    await expect(promise).rejects.toThrow();
  });

  it('should isolate process globals', async () => {
    // In the subprocess, process should be deleted
    const result = await ProcessSandbox.execute('return typeof process', {});
    expect(result).toBe('undefined');
  });

  it('should handle complex context objects', async () => {
    const context = {
      data: { nested: { value: 42 } },
      items: [1, 2, 3],
    };
    const result = await ProcessSandbox.execute('return data.nested.value + items[2]', context);
    expect(result).toBe(45);
  });

  it('should clean up temp files after execution', async () => {
    const mkdirSpy = spyOn(fs, 'mkdir');
    const rmSpy = spyOn(fs, 'rm');

    await ProcessSandbox.execute('return 1', {});

    expect(mkdirSpy).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalled();

    mkdirSpy.mockRestore();
    rmSpy.mockRestore();
  });

  // Security tests
  it('should sanitize context to prevent prototype pollution', async () => {
    // Attempt to pass a context with __proto__ manipulation
    const context: Record<string, unknown> = { normal: 'value' };
    // biome-ignore lint/complexity/useLiteralKeys: intentionally testing prototype pollution
    context['__proto__'] = { polluted: true };

    const result = await ProcessSandbox.execute(
      'return { hasNormal: typeof normal !== "undefined", hasPolluted: typeof polluted !== "undefined" }',
      context
    );

    expect(result).toEqual({ hasNormal: true, hasPolluted: false });
  });

  it('should handle null results', async () => {
    const result = await ProcessSandbox.execute('return null', {});
    expect(result).toBeNull();
  });

  it('should handle string results', async () => {
    const result = await ProcessSandbox.execute('return "hello world"', {});
    expect(result).toBe('hello world');
  });

  it('should use custom cwd if provided', async () => {
    const result = await ProcessSandbox.execute('return true', {}, { cwd: '/tmp' });
    expect(result).toBe(true);
  });

  it('should fail gracefully on syntax error', async () => {
    const promise = ProcessSandbox.execute('return {{{invalid}}}', {});
    await expect(promise).rejects.toThrow();
  });

  it('should redirect console.log to provided logger', async () => {
    const logs: string[] = [];
    const logger = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      info: (msg: string) => logs.push(`INFO: ${msg}`),
    };

    await ProcessSandbox.execute(
      'console.log("hello from sandbox"); console.warn("warning here"); return 42;',
      {},
      { logger }
    );

    expect(logs).toContain('hello from sandbox');
    expect(logs).toContain('WARN: warning here');
  });
});
