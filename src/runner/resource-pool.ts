import type { Logger } from '../utils/logger.ts';

export type ReleaseFunction = () => void;

export interface PoolMetrics {
  name: string;
  limit: number;
  active: number;
  queued: number;
  totalAcquired: number;
  totalWaitTimeMs: number;
}

interface QueuedRequest {
  resolve: (release: ReleaseFunction) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  priority: number;
  timestamp: number;
}

export class ResourcePoolManager {
  private pools = new Map<
    string,
    {
      limit: number;
      active: number;
      queue: QueuedRequest[];
      totalAcquired: number;
      totalWaitTimeMs: number;
    }
  >();
  private globalLimit: number;

  constructor(
    private logger: Logger,
    options: { defaultLimit?: number; pools?: Record<string, number> } = {}
  ) {
    this.globalLimit = options.defaultLimit || 10;
    if (options.pools) {
      for (const [name, limit] of Object.entries(options.pools)) {
        this.pools.set(name, { limit, active: 0, queue: [], totalAcquired: 0, totalWaitTimeMs: 0 });
      }
    }
  }

  /**
   * Acquire a resource from a pool.
   * If the pool doesn't exist, it uses the global limit.
   */
  async acquire(
    poolName: string,
    options: { priority?: number; signal?: AbortSignal } = {}
  ): Promise<ReleaseFunction> {
    let pool = this.pools.get(poolName);
    if (!pool) {
      // Create a pool for this name if it doesn't exist, using global limit
      pool = {
        limit: this.globalLimit,
        active: 0,
        queue: [],
        totalAcquired: 0,
        totalWaitTimeMs: 0,
      };
      this.pools.set(poolName, pool);
    }

    if (pool.active < pool.limit && pool.queue.length === 0) {
      pool.active++;
      pool.totalAcquired++;
      return this.createReleaseFn(poolName);
    }

    // Queue the request
    const timestamp = Date.now();
    const poolRef = pool;
    return new Promise<ReleaseFunction>((resolve, reject) => {
      const request: QueuedRequest = {
        resolve,
        reject,
        signal: options.signal,
        priority: options.priority || 0,
        timestamp,
      };

      // Add to queue and sort by priority (desc) then timestamp (asc)
      poolRef.queue.push(request);
      poolRef.queue.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.timestamp - b.timestamp;
      });

      // Handle abort signal
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const index = poolRef.queue.indexOf(request);
          if (index !== -1) {
            poolRef.queue.splice(index, 1);
            reject(new Error('Acquisition aborted'));
          }
        });
      }
    });
  }

  private createReleaseFn(poolName: string): ReleaseFunction {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(poolName);
    };
  }

  private release(poolName: string) {
    const pool = this.pools.get(poolName);
    if (!pool) return;

    pool.active--;

    // Process queue
    while (pool.active < pool.limit && pool.queue.length > 0) {
      const request = pool.queue.shift();
      if (!request) break;

      // Skip if signal already aborted
      if (request.signal?.aborted) continue;

      pool.active++;
      pool.totalAcquired++;
      pool.totalWaitTimeMs += Date.now() - request.timestamp;
      request.resolve(this.createReleaseFn(poolName));
    }
  }

  getMetrics(poolName: string): PoolMetrics | undefined {
    const pool = this.pools.get(poolName);
    if (!pool) return undefined;

    return {
      name: poolName,
      limit: pool.limit,
      active: pool.active,
      queued: pool.queue.length,
      totalAcquired: pool.totalAcquired,
      totalWaitTimeMs: pool.totalWaitTimeMs,
    };
  }

  getAllMetrics(): PoolMetrics[] {
    return Array.from(this.pools.entries()).map(([name, pool]) => ({
      name,
      limit: pool.limit,
      active: pool.active,
      queued: pool.queue.length,
      totalAcquired: pool.totalAcquired,
      totalWaitTimeMs: pool.totalWaitTimeMs,
    }));
  }
}
