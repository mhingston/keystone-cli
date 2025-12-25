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
    const context = { normal: 'value' };
    // @ts-ignore - intentionally testing prototype pollution
    context['__proto__'] = { polluted: true };

    const result = await ProcessSandbox.execute(
      'return { hasNormal: typeof normal !== "undefined", hasPolluted: typeof polluted !== "undefined" }',
      context
    );

    expect(result).toEqual({ hasNormal: true, hasPolluted: false });
  });
});
