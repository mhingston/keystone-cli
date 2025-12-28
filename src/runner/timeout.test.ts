import { describe, expect, it } from 'bun:test';
import { TimeoutError, withTimeout } from './timeout';

describe('timeout', () => {
  it('should resolve if the promise completes before the timeout', async () => {
    const promise = Promise.resolve('ok');
    const result = await withTimeout(promise, 100);
    expect(result).toBe('ok');
  });

  it('should reject if the promise takes longer than the timeout', async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve('ok'), 200));
    await expect(withTimeout(promise, 50)).rejects.toThrow(TimeoutError);
  });

  it('should include the operation name in the error message', async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve('ok'), 100));
    await expect(withTimeout(promise, 10, 'MyStep')).rejects.toThrow(/MyStep timed out/);
  });

  it('should abort the controller when the timeout triggers', async () => {
    const controller = new AbortController();
    const promise = new Promise(() => {});

    await expect(
      withTimeout(promise, 10, 'SlowOp', { abortController: controller })
    ).rejects.toThrow(TimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });
});
