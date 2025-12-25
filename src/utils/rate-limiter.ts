/**
 * Token bucket rate limiter for controlling request rates.
 *
 * Uses a token bucket algorithm where tokens are added at a fixed rate
 * and requests consume tokens. Supports bursting up to max tokens.
 */
export interface RateLimiterOptions {
  /** Maximum number of tokens in the bucket (burst capacity) */
  maxTokens: number;
  /** Number of tokens to add per interval */
  refillRate: number;
  /** Interval in milliseconds for token refill */
  refillInterval: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private waitQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RateLimiterOptions) {
    this.maxTokens = options.maxTokens;
    this.refillRate = options.refillRate;
    this.refillInterval = options.refillInterval;
    this.tokens = options.maxTokens; // Start with full bucket
    this.lastRefill = Date.now();
  }

  /**
   * Create a rate limiter with requests per second limit.
   */
  static perSecond(requestsPerSecond: number, burst = 1): RateLimiter {
    return new RateLimiter({
      maxTokens: Math.max(burst, requestsPerSecond),
      refillRate: requestsPerSecond,
      refillInterval: 1000,
    });
  }

  /**
   * Create a rate limiter with requests per minute limit.
   */
  static perMinute(requestsPerMinute: number, burst = 1): RateLimiter {
    return new RateLimiter({
      maxTokens: Math.max(burst, Math.ceil(requestsPerMinute / 60)),
      refillRate: requestsPerMinute,
      refillInterval: 60000,
    });
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.refillInterval) * this.refillRate);

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;

      // Process waiting requests
      this.processQueue();
    }
  }

  /**
   * Process the wait queue when tokens become available.
   */
  private processQueue(): void {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      const waiter = this.waitQueue.shift();
      if (waiter) {
        this.tokens -= 1;
        waiter.resolve();
      }
    }
  }

  /**
   * Start an automatic refill timer.
   * Call stop() to clean up when done.
   */
  start(): void {
    if (this.refillTimer) return;
    this.refillTimer = setInterval(() => this.refill(), this.refillInterval);
  }

  /**
   * Stop the automatic refill timer.
   */
  stop(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // Reject all pending waiters
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error('Rate limiter stopped'));
    }
    this.waitQueue = [];
  }

  /**
   * Acquire a token, waiting if necessary.
   *
   * @param options.timeout Optional timeout in ms
   * @param options.signal Optional AbortSignal for cancellation
   * @returns Promise that resolves when a token is acquired
   */
  async acquire(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<void> {
    // Refill before checking
    this.refill();

    // If we have tokens, consume one immediately
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Otherwise wait for a token
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waitQueue.push(waiter);

      // Handle timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (options.timeout) {
        timeoutId = setTimeout(() => {
          const index = this.waitQueue.indexOf(waiter);
          if (index >= 0) {
            this.waitQueue.splice(index, 1);
            reject(new Error(`Rate limit acquire timeout after ${options.timeout}ms`));
          }
        }, options.timeout);
      }

      // Handle abort signal
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          if (timeoutId) clearTimeout(timeoutId);
          const index = this.waitQueue.indexOf(waiter);
          if (index >= 0) {
            this.waitQueue.splice(index, 1);
            reject(new Error('Rate limit acquire aborted'));
          }
        });
      }

      // Clean up timeout on resolve
      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        if (timeoutId) clearTimeout(timeoutId);
        originalResolve();
      };
    });
  }

  /**
   * Try to acquire a token without waiting.
   *
   * @returns true if a token was acquired, false otherwise
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Get the current number of available tokens.
   */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Get the number of requests waiting for tokens.
   */
  get waiting(): number {
    return this.waitQueue.length;
  }
}
