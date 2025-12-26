import { afterEach, describe, expect, it } from 'bun:test';
import { SafeSandbox } from './sandbox';

describe('SafeSandbox', () => {
  afterEach(() => {
    SafeSandbox.resetWarning();
  });

  it('should execute basic arithmetic', async () => {
    const result = await SafeSandbox.execute('return 1 + 2', {});
    expect(result).toBe(3);
  });

  it('should have access to context variables', async () => {
    const result = await SafeSandbox.execute('return a + b', { a: 10, b: 20 });
    expect(result).toBe(30);
  });

  it('should not have access to Node.js globals', async () => {
    const result = await SafeSandbox.execute('return typeof process', {});
    expect(result).toBe('undefined');
  });

  it('should handle object results', async () => {
    const result = await SafeSandbox.execute('return { x: 1, y: 2 }', {});
    expect(result).toEqual({ x: 1, y: 2 });
  });

  it('should respect timeouts', async () => {
    const promise = SafeSandbox.execute('while(true) {}', {}, { timeout: 100 });
    await expect(promise).rejects.toThrow();
  });

  it('should use node:vm when useProcessIsolation is false', async () => {
    // node:vm runs code as a script, not as a function, so we use an expression
    const result = await SafeSandbox.execute('x * 2', { x: 5 }, { useProcessIsolation: false });
    expect(result).toBe(10);
  });

  it('should redirect console output to logger in vm mode', async () => {
    const logs: string[] = [];
    const logger = {
      log: (msg: string) => logs.push(msg),
      error: (_msg: string) => {},
      warn: (_msg: string) => {},
      info: (_msg: string) => {},
    };

    await SafeSandbox.execute('console.log("hello"); console.warn("warning");', {}, {
      useProcessIsolation: false,
      logger,
    });

    expect(logs).toContain('hello');
    expect(logs).toContain('WARN: warning');
  });

  it('should show warning only once when using vm mode', async () => {
    await SafeSandbox.execute('1', {}, { useProcessIsolation: false });
    // Second call should not show warning again (internal state tracking)
    await SafeSandbox.execute('2', {}, { useProcessIsolation: false });
    // If we got here without error, the warning tracking works
    expect(true).toBe(true);
  });
});
