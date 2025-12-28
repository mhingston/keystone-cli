/**
 * Execute a promise with a timeout
 * Throws a TimeoutError if the operation exceeds the timeout
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface TimeoutOptions {
  abortController?: AbortController;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = 'Operation',
  options: TimeoutOptions = {}
): Promise<T> {
  let timeoutId: Timer | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new TimeoutError(`${operation} timed out after ${timeoutMs}ms`);
      if (options.abortController && !options.abortController.signal.aborted) {
        options.abortController.abort(timeoutError);
      }
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
