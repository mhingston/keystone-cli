/**
 * Circuit breaker for protecting against cascading failures.
 *
 * The circuit breaker has three states:
 * - CLOSED: Normal operation, requests are allowed through
 * - OPEN: The circuit is tripped, requests fail immediately
 * - HALF_OPEN: Testing if the service has recovered
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to close the circuit (default: 30000) */
  resetTimeout: number;
  /** Number of successful requests in half-open to close (default: 1) */
  successThreshold?: number;
  /** Optional callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      successThreshold: 1,
      onStateChange: () => {},
      ...options,
    };
  }

  /**
   * Get the current circuit state.
   */
  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Check if the circuit allows requests.
   */
  get isAllowed(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if we should transition to half-open
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.options.resetTimeout) {
        this.transitionTo(CircuitState.HALF_OPEN);
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow limited requests
    return true;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @param fn The async function to execute
   * @returns The result of the function
   * @throws Error if circuit is open, or the function throws
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isAllowed) {
      throw new Error('Circuit breaker is OPEN - request rejected');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Record a successful operation.
   */
  onSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount += 1;
      if (this.successCount >= this.options.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }

  /**
   * Record a failed operation.
   */
  onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      // Immediately trip back to open
      this.transitionTo(CircuitState.OPEN);
    } else if (
      this.state === CircuitState.CLOSED &&
      this.failureCount >= this.options.failureThreshold
    ) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  /**
   * Manually reset the circuit to closed state.
   */
  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    if (this.state !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED);
    }
  }

  /**
   * Manually trip the circuit to open state.
   */
  trip(): void {
    this.lastFailureTime = Date.now();
    if (this.state !== CircuitState.OPEN) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === CircuitState.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;
    }

    this.options.onStateChange(oldState, newState);
  }
}
