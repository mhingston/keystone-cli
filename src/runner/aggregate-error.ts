/**
 * Aggregate workflow error that collects multiple errors from parallel execution.
 *
 * This allows capturing all failures from a foreach loop or parallel workflow
 * execution rather than failing on the first error.
 */
export class AggregateWorkflowError extends Error {
  readonly errors: Error[];
  readonly stepId: string;

  constructor(stepId: string, errors: Error[]) {
    const messages = errors.map((e, i) => `  [${i + 1}] ${e.message}`).join('\n');
    super(`Step ${stepId} failed with ${errors.length} error(s):\n${messages}`);
    this.name = 'AggregateWorkflowError';
    this.stepId = stepId;
    this.errors = errors;
  }

  /**
   * Get the first error in the collection.
   */
  get firstError(): Error | undefined {
    return this.errors[0];
  }

  /**
   * Get the count of errors.
   */
  get count(): number {
    return this.errors.length;
  }

  /**
   * Check if all errors are of a specific type.
   */
  allOfType<T extends Error>(errorClass: new (...args: unknown[]) => T): boolean {
    return this.errors.every((e) => e instanceof errorClass);
  }

  /**
   * Filter errors by type.
   */
  ofType<T extends Error>(errorClass: new (...args: unknown[]) => T): T[] {
    return this.errors.filter((e) => e instanceof errorClass) as T[];
  }
}
