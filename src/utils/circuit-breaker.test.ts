import { describe, expect, it, mock } from 'bun:test';
import { CircuitBreaker, CircuitState } from './circuit-breaker';

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('should start in closed state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      expect(breaker.currentState).toBe(CircuitState.CLOSED);
      expect(breaker.isAllowed).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('should open after failure threshold', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.CLOSED);

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.CLOSED);

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.OPEN);
      expect(breaker.isAllowed).toBe(false);
    });

    it('should transition to half-open after reset timeout', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 50,
      });

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.OPEN);
      expect(breaker.isAllowed).toBe(false);

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      expect(breaker.isAllowed).toBe(true);
      expect(breaker.currentState).toBe(CircuitState.HALF_OPEN);
    });

    it('should close after success in half-open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 50,
        successThreshold: 2,
      });

      breaker.onFailure();
      await new Promise((r) => setTimeout(r, 60));

      // Trigger transition to half-open
      breaker.isAllowed;
      expect(breaker.currentState).toBe(CircuitState.HALF_OPEN);

      breaker.onSuccess();
      expect(breaker.currentState).toBe(CircuitState.HALF_OPEN);

      breaker.onSuccess();
      expect(breaker.currentState).toBe(CircuitState.CLOSED);
    });

    it('should re-open on failure in half-open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 50,
      });

      breaker.onFailure();
      await new Promise((r) => setTimeout(r, 60));

      // Trigger transition to half-open
      breaker.isAllowed;
      expect(breaker.currentState).toBe(CircuitState.HALF_OPEN);

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.OPEN);
    });
  });

  describe('execute', () => {
    it('should execute and return result when closed', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);
    });

    it('should throw when circuit is open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 10000,
      });

      breaker.onFailure();

      await expect(breaker.execute(async () => 42)).rejects.toThrow(/OPEN/);
    });

    it('should record failure on thrown error', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 1000,
      });

      await expect(
        breaker.execute(async () => {
          throw new Error('test');
        })
      ).rejects.toThrow('test');

      await expect(
        breaker.execute(async () => {
          throw new Error('test2');
        })
      ).rejects.toThrow('test2');

      expect(breaker.currentState).toBe(CircuitState.OPEN);
    });
  });

  describe('manual controls', () => {
    it('should reset to closed state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
      });

      breaker.onFailure();
      expect(breaker.currentState).toBe(CircuitState.OPEN);

      breaker.reset();
      expect(breaker.currentState).toBe(CircuitState.CLOSED);
    });

    it('should trip to open state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 1000,
      });

      expect(breaker.currentState).toBe(CircuitState.CLOSED);

      breaker.trip();
      expect(breaker.currentState).toBe(CircuitState.OPEN);
    });
  });

  describe('callbacks', () => {
    it('should call onStateChange when transitioning', () => {
      const onStateChange = mock(() => {});

      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        onStateChange,
      });

      breaker.onFailure();

      expect(onStateChange).toHaveBeenCalledWith(CircuitState.CLOSED, CircuitState.OPEN);
    });
  });
});
