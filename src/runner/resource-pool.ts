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

/** Default maximum queue size to prevent unbounded memory growth */
const DEFAULT_MAX_QUEUE_SIZE = 1000;

/** Default resource pool limit */
const DEFAULT_POOL_LIMIT = 10;

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
  private maxQueueSize: number;

  constructor(
    private logger: Logger,
    options: { defaultLimit?: number; maxQueueSize?: number; pools?: Record<string, number> } = {}
  ) {
    this.globalLimit = options.defaultLimit || DEFAULT_POOL_LIMIT;
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    if (options.pools) {
      for (const [name, limit] of Object.entries(options.pools)) {
        this.pools.set(name, { limit, active: 0, queue: [], totalAcquired: 0, totalWaitTimeMs: 0 });
      }
    }
  }

  /**
   * Acquire a resource from a pool.
   * If the pool doesn't exist, it uses the global limit.
   * 
   * @param poolName - Name of the pool to acquire from
   * @param options.priority - Higher priority requests are processed first (default: 0)
   * @param options.signal - AbortSignal for cancellation
   * @param options.timeout - Maximum time to wait for a slot (ms), rejects with timeout error if exceeded
   */
  async acquire(
    poolName: string,
    options: { priority?: number; signal?: AbortSignal; timeout?: number } = {}
  ): Promise<ReleaseFunction> {
    // Validate timeout parameter
    if (options.timeout !== undefined) {
      if (typeof options.timeout !== 'number' || !Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw new Error(
          `Invalid timeout value: ${options.timeout}. Timeout must be a positive finite number.`
        );
      }
    }

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

    // Check queue size limit
    if (pool.queue.length >= this.maxQueueSize) {
      throw new Error(
        `Resource pool "${poolName}" queue is full (${this.maxQueueSize}). ` +
        `Consider increasing concurrency limits or reducing parallel work.`
      );
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

      // Handle timeout
      let timeoutId: Timer | undefined;
      if (options.timeout && options.timeout > 0) {
        timeoutId = setTimeout(() => {
          const index = poolRef.queue.indexOf(request);
          if (index !== -1) {
            poolRef.queue.splice(index, 1);
            reject(new Error(`Resource pool "${poolName}" acquire timeout after ${options.timeout}ms`));
          }
        }, options.timeout);
      }

      // Handle abort signal
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      if (options.signal) {
        const onAbort = () => {
          cleanup();
          const index = poolRef.queue.indexOf(request);
          if (index !== -1) {
            poolRef.queue.splice(index, 1);
            reject(new Error('Acquisition aborted'));
          }
        };
        options.signal.addEventListener('abort', onAbort, { once: true });

        // Wrap accessors to remove listener
        const originalResolve = resolve;
        const originalReject = reject;

        request.resolve = (release) => {
          cleanup();
          options.signal?.removeEventListener('abort', onAbort);
          originalResolve(release);
        };
        request.reject = (err) => {
          cleanup();
          options.signal?.removeEventListener('abort', onAbort);
          originalReject(err);
        };
      } else {
        // Still need to wrap for timeout cleanup
        const originalResolve = resolve;
        const originalReject = reject;

        request.resolve = (release) => {
          cleanup();
          originalResolve(release);
        };
        request.reject = (err) => {
          cleanup();
          originalReject(err);
        };
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

  /**
   * Check if a pool has capacity for another task.
   */
  hasCapacity(poolName: string): boolean {
    const pool = this.pools.get(poolName);
    if (!pool) return true; // Global limit will be checked on acquire
    return pool.active < pool.limit;
  }
}
