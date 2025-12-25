import { describe, expect, it, mock } from 'bun:test';
import { ConsoleLogger } from '../utils/logger';
import { ResourcePoolManager } from './resource-pool';

describe('ResourcePoolManager', () => {
  const logger = new ConsoleLogger();

  it('should respect pool limits', async () => {
    const manager = new ResourcePoolManager(logger, {
      pools: { test: 2 },
    });

    let activeCount = 0;
    const run = async () => {
      const release = await manager.acquire('test');
      activeCount++;
      expect(activeCount).toBeLessThanOrEqual(2);
      await Bun.sleep(50);
      activeCount--;
      release();
    };

    await Promise.all([run(), run(), run(), run()]);
  });

  it('should use default limit for unknown pools', async () => {
    const manager = new ResourcePoolManager(logger, {
      defaultLimit: 3,
    });

    let activeCount = 0;
    const run = async () => {
      const release = await manager.acquire('unknown');
      activeCount++;
      expect(activeCount).toBeLessThanOrEqual(3);
      await Bun.sleep(50);
      activeCount--;
      release();
    };

    await Promise.all([run(), run(), run(), run(), run()]);
  });

  it('should handle cancellation via AbortSignal', async () => {
    const manager = new ResourcePoolManager(logger, {
      pools: { test: 1 },
    });

    // Acquire the only slot
    const release1 = await manager.acquire('test');

    const controller = new AbortController();
    const pendingAcquisition = manager.acquire('test', { signal: controller.signal });

    // Cancel after a bit
    setTimeout(() => controller.abort(), 10);

    await expect(pendingAcquisition).rejects.toThrow('Acquisition aborted');
    release1();
  });

  it('should respect priority in queue', async () => {
    const manager = new ResourcePoolManager(logger, {
      pools: { test: 1 },
    });

    const results: number[] = [];
    const release1 = await manager.acquire('test');

    const p1 = manager.acquire('test', { priority: 1 }).then((r) => {
      results.push(1);
      r();
    });
    const p2 = manager.acquire('test', { priority: 10 }).then((r) => {
      results.push(10);
      r();
    });
    const p3 = manager.acquire('test', { priority: 5 }).then((r) => {
      results.push(5);
      r();
    });

    release1();
    await Promise.all([p1, p2, p3]);

    // Priority 10 should run first, then 5, then 1
    expect(results).toEqual([10, 5, 1]);
  });

  it('should provide metrics', async () => {
    const manager = new ResourcePoolManager(logger, {
      pools: { test: 2 },
    });

    const release1 = await manager.acquire('test');
    const release2 = await manager.acquire('test');

    const metrics = manager.getMetrics('test');
    expect(metrics?.active).toBe(2);
    expect(metrics?.queued).toBe(0);

    const p3 = manager.acquire('test');
    const metrics2 = manager.getMetrics('test');
    expect(metrics2?.queued).toBe(1);

    release1();
    release2();
    await p3.then((r) => r());

    const metrics3 = manager.getMetrics('test');
    expect(metrics3?.totalAcquired).toBe(3);
  });
});
