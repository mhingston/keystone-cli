import { afterEach, describe, expect, it, mock } from 'bun:test';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  describe('basic functionality', () => {
    it('should allow burst requests up to max tokens', () => {
      const limiter = new RateLimiter({
        maxTokens: 5,
        refillRate: 1,
        refillInterval: 1000,
      });

      // All 5 should succeed immediately
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);

      // 6th should fail
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should report available tokens', () => {
      const limiter = new RateLimiter({
        maxTokens: 3,
        refillRate: 1,
        refillInterval: 1000,
      });

      expect(limiter.available).toBe(3);
      limiter.tryAcquire();
      expect(limiter.available).toBe(2);
    });
  });

  describe('acquire', () => {
    it('should resolve immediately when tokens available', async () => {
      const limiter = new RateLimiter({
        maxTokens: 5,
        refillRate: 1,
        refillInterval: 1000,
      });

      await limiter.acquire();
      expect(limiter.available).toBe(4);
    });

    it('should timeout when waiting too long', async () => {
      const limiter = new RateLimiter({
        maxTokens: 1,
        refillRate: 1,
        refillInterval: 10000, // Slow refill
      });

      // Use up the token
      limiter.tryAcquire();

      const promise = limiter.acquire({ timeout: 50 });
      await expect(promise).rejects.toThrow(/timeout/i);
    });

    it('should abort when signal is cancelled', async () => {
      const limiter = new RateLimiter({
        maxTokens: 1,
        refillRate: 1,
        refillInterval: 10000,
      });

      // Use up the token
      limiter.tryAcquire();

      const controller = new AbortController();
      const promise = limiter.acquire({ signal: controller.signal });

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      await expect(promise).rejects.toThrow(/aborted/i);
    });
  });

  describe('factory methods', () => {
    it('should create per-second limiter', () => {
      const limiter = RateLimiter.perSecond(10, 5);

      // Should have burst capacity
      expect(limiter.available).toBe(10);
    });

    it('should create per-minute limiter', () => {
      const limiter = RateLimiter.perMinute(60, 10);

      // Should have burst capacity
      expect(limiter.available).toBeGreaterThanOrEqual(10);
    });
  });

  describe('waiting queue', () => {
    it('should track waiting requests', async () => {
      const limiter = new RateLimiter({
        maxTokens: 1,
        refillRate: 1,
        refillInterval: 50, // Fast refill for test
      });

      limiter.tryAcquire();
      expect(limiter.waiting).toBe(0);

      // Start the refill timer
      limiter.start();

      // Start waiting
      const promise = limiter.acquire({ timeout: 500 });
      expect(limiter.waiting).toBe(1);

      // Wait for refill and resolution
      await promise;
      expect(limiter.waiting).toBe(0);

      limiter.stop();
    });
  });

  describe('cleanup', () => {
    it('should reject pending requests when stopped', async () => {
      const limiter = new RateLimiter({
        maxTokens: 1,
        refillRate: 1,
        refillInterval: 10000,
      });

      limiter.tryAcquire();
      const promise = limiter.acquire();

      expect(limiter.waiting).toBe(1);
      limiter.stop();

      await expect(promise).rejects.toThrow(/stopped/i);
      expect(limiter.waiting).toBe(0);
    });
  });
});
