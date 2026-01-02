import { randomUUID } from 'node:crypto';
import type { WorkflowDb } from '../../db/workflow-db.ts';
import { type ExpressionContext, ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { Step } from '../../parser/schema.ts';
import { StepStatus, type StepStatusType, WorkflowStatus } from '../../types/status.ts';
import { LIMITS } from '../../utils/constants.ts';
import { ConfigLoader } from '../../utils/config-loader.ts';
import type { Logger } from '../../utils/logger.ts';
import type { ResourcePoolManager } from '../resource-pool.ts';
import type { ForeachStepContext, StepContext } from '../workflow-state.ts';
import { WorkflowSuspendedError } from './types.ts';

export type ExecuteStepCallback = (
  step: Step,
  context: ExpressionContext,
  stepExecId: string
) => Promise<StepContext>;

export class ForeachExecutor {
  private hasWarnedMemory = false;

  constructor(
    private db: WorkflowDb,
    private logger: Logger,
    private executeStepFn: ExecuteStepCallback,
    private abortSignal?: AbortSignal,
    private resourcePool?: ResourcePoolManager
  ) { }

  /**
   * Aggregate outputs from multiple iterations of a foreach step
   */
  public static aggregateOutputs(outputs: unknown[]): Record<string, unknown> {
    const parentOutputs: Record<string, unknown> = {};

    const validOutputs = outputs.filter((o) => o !== undefined);
    if (validOutputs.length === 0) return parentOutputs;

    // We can only aggregate objects, and we assume all outputs have similar shape
    const firstOutput = validOutputs[0];
    if (typeof firstOutput !== 'object' || firstOutput === null) {
      return parentOutputs;
    }

    // Collect all keys from all outputs
    const keys = new Set<string>();
    for (const output of validOutputs) {
      if (typeof output === 'object' && output !== null) {
        for (const key of Object.keys(output)) {
          keys.add(key);
        }
      }
    }

    // For each key, create an array of values
    for (const key of keys) {
      parentOutputs[key] = outputs.map((output) => {
        if (typeof output === 'object' && output !== null) {
          return (output as Record<string, unknown>)[key];
        }
        return undefined;
      });
    }

    return parentOutputs;
  }

  /**
   * Execute a step with foreach logic
   */
  async execute(
    step: Step,
    baseContext: ExpressionContext,
    runId: string,
    existingContext?: ForeachStepContext
  ): Promise<ForeachStepContext> {
    if (!step.foreach) {
      throw new Error('Step is not a foreach step');
    }

    let items: unknown[];
    const persistedItems = existingContext?.foreachItems;
    if (Array.isArray(persistedItems)) {
      items = persistedItems;
    } else {
      if (persistedItems !== undefined) {
        this.logger.warn(
          `  ⚠️  Warning: Persisted foreach items for step ${step.id} are invalid. Re-evaluating expression.`
        );
      }
      const evaluatedItems = ExpressionEvaluator.evaluate(step.foreach, baseContext);
      if (!Array.isArray(evaluatedItems)) {
        throw new Error(`foreach expression must evaluate to an array: ${step.foreach}`);
      }
      items = evaluatedItems;
    }

    // Validate iteration count to prevent memory exhaustion
    if (items.length > LIMITS.MAX_FOREACH_ITERATIONS) {
      throw new Error(
        `Foreach step "${step.id}" exceeds maximum iteration limit of ${LIMITS.MAX_FOREACH_ITERATIONS}. ` +
        `Got ${items.length} items. Consider batching or reducing the dataset.`
      );
    }

    this.logger.log(`  ⤷ Executing step ${step.id} for ${items.length} items`);

    if (items.length > LIMITS.FOREACH_MEMORY_WARNING_THRESHOLD && !this.hasWarnedMemory) {
      this.logger.warn(
        `  ⚠️  Warning: Large foreach loop detected (${items.length} items). This may consume significant memory and lead to instability.`
      );
      this.hasWarnedMemory = true;
    }

    // Evaluate concurrency
    // Default to a safe limit (50) to prevent resource exhaustion/DoS, unless explicitly overridden.
    const config = ConfigLoader.load();
    const DEFAULT_MAX_CONCURRENCY = config.concurrency?.default ?? 50;
    let concurrencyLimit = Math.min(items.length, DEFAULT_MAX_CONCURRENCY);

    if (step.concurrency !== undefined) {
      let explicitConcurrency: number;

      if (typeof step.concurrency === 'string') {
        explicitConcurrency = Number(ExpressionEvaluator.evaluate(step.concurrency, baseContext));
      } else {
        explicitConcurrency = step.concurrency;
      }

      if (!Number.isInteger(explicitConcurrency) || explicitConcurrency <= 0) {
        throw new Error(
          `concurrency must evaluate to a positive integer, got: ${explicitConcurrency}`
        );
      }

      // If user explicitly sets a higher concurrency, we respect it but log a debug message
      if (explicitConcurrency > DEFAULT_MAX_CONCURRENCY) {
        this.logger.debug(
          `Step ${step.id} has explicit concurrency ${explicitConcurrency} > default ${DEFAULT_MAX_CONCURRENCY}. Proceeding.`
        );
      }
      concurrencyLimit = explicitConcurrency;
    }

    // Create parent step record in DB
    const parentStepExecId = randomUUID();
    await this.db.createStep(parentStepExecId, runId, step.id);
    await this.db.startStep(parentStepExecId);

    // Persist the foreach items
    await this.db.completeStep(parentStepExecId, StepStatus.PENDING, { __foreachItems: items });

    try {
      // Initialize results array
      const itemResults: StepContext[] = existingContext?.items || new Array(items.length);
      const shouldCheckDb = !!existingContext;
      // Track estimated result size to prevent memory exhaustion
      let estimatedResultsBytes = 0;

      // Ensure array is correct length
      if (itemResults.length !== items.length) {
        itemResults.length = items.length;
      }

      // Optimization: Fetch all existing iterations in one query
      // This avoids N queries in the loop
      const existingIterations = new Map<number, any>();
      if (shouldCheckDb) {
        try {
          // Use getStepIterations(runId, stepId) for optimized fetch
          const iterations = await this.db.getStepIterations(runId, step.id);
          for (const s of iterations) {
            if (typeof s.iteration_index === 'number') {
              existingIterations.set(s.iteration_index, s);
            }
          }
        } catch (e) {
          /* ignore */
        }
      }

      // Pre-generate IDs and batch-create step records for all pending iterations
      const iterationIds = new Map<number, string>();
      const toCreate: Array<{
        id: string;
        runId: string;
        stepId: string;
        iterationIndex: number;
      }> = [];

      for (let i = 0; i < items.length; i++) {
        // Skip if already in results (from existingContext)
        if (
          itemResults[i] &&
          (itemResults[i].status === StepStatus.SUCCESS ||
            itemResults[i].status === StepStatus.SKIPPED)
        ) {
          continue;
        }

        // Check DB for resume if needed
        if (shouldCheckDb) {
          const existingExec = existingIterations.get(i);
          if (
            existingExec &&
            (existingExec.status === StepStatus.SUCCESS ||
              existingExec.status === StepStatus.SKIPPED)
          ) {
            // Hydrate result from DB
            let output: unknown = null;
            try {
              output = existingExec.output ? JSON.parse(existingExec.output) : null;
            } catch (error) {
              this.logger.warn(
                `Failed to parse output for step ${step.id} iteration ${i}: ${error}`
              );
            }
            itemResults[i] = {
              output,
              outputs:
                typeof output === 'object' && output !== null && !Array.isArray(output)
                  ? (output as Record<string, unknown>)
                  : {},
              status: existingExec.status as StepStatusType,
              error: existingExec.error || undefined,
            } as StepContext;
            continue;
          }
        }

        // Needs execution
        const id = randomUUID();
        iterationIds.set(i, id);
        toCreate.push({ id, runId, stepId: step.id, iterationIndex: i });
      }

      // Batch create all pending iterations
      if (toCreate.length > 0) {
        await this.db.batchCreateSteps(toCreate);
      }

      // Worker pool implementation
      let currentIndex = 0;
      let aborted = false;
      const workers = new Array(Math.min(concurrencyLimit, items.length))
        .fill(null)
        .map(async () => {
          const nextIndex = () => {
            if (aborted || this.abortSignal?.aborted) return null;
            if (currentIndex >= items.length) return null;
            const i = currentIndex;
            currentIndex += 1;
            return i;
          };

          while (true) {
            const i = nextIndex();
            if (i === null) break;

            if (aborted || this.abortSignal?.aborted) break;

            const item = items[i];

            // Skip if already successful or skipped (either from memory or just hydrated above)
            if (
              itemResults[i] &&
              (itemResults[i].status === StepStatus.SUCCESS ||
                itemResults[i].status === StepStatus.SKIPPED)
            ) {
              continue;
            }

            // Build item-specific context
            const itemContext = {
              ...baseContext,
              item,
              index: i,
            };

            if (aborted || this.abortSignal?.aborted) break;

            const stepExecId = iterationIds.get(i);
            if (!stepExecId) continue; // Should not happen

            // Execute and store result
            try {
              if (aborted || this.abortSignal?.aborted) break;

              const poolName = step.pool || step.type;
              let release: (() => void) | undefined;

              try {
                if (this.resourcePool) {
                  release = await this.resourcePool.acquire(poolName, { signal: this.abortSignal });
                }

                this.logger.debug(`  ⤷ [${i + 1}/${items.length}] Processing iteration...`);

                // Execute step
                itemResults[i] = await this.executeStepFn(step, itemContext, stepExecId);

                // Track result size to prevent memory exhaustion
                if (itemResults[i]?.output !== undefined) {
                  try {
                    estimatedResultsBytes += JSON.stringify(itemResults[i].output).length;
                  } catch {
                    // If serialization fails, estimate based on type
                    estimatedResultsBytes += 1024;
                  }
                  if (estimatedResultsBytes > LIMITS.MAX_FOREACH_RESULTS_BYTES) {
                    throw new Error(
                      `Foreach step "${step.id}" accumulated results exceed maximum size of ` +
                      `${LIMITS.MAX_FOREACH_RESULTS_BYTES} bytes. Consider reducing output size or batching.`
                    );
                  }
                }

                if (
                  itemResults[i].status === StepStatus.FAILED ||
                  itemResults[i].status === StepStatus.SUSPENDED
                ) {
                  aborted = true;
                }
              } finally {
                release?.();
              }
            } catch (error) {
              if (error instanceof WorkflowSuspendedError) {
                itemResults[i] = {
                  status: StepStatus.SUSPENDED,
                  output: null,
                  outputs: {},
                  error: error.message,
                };
                aborted = true;
                return;
              }
              aborted = true;
              throw error;
            }
          }
        });

      const workerResults = await Promise.allSettled(workers);

      // Check if any worker rejected (this would be due to an unexpected throw)
      const firstError = workerResults.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      const error = firstError?.reason;

      if (error && !(error instanceof WorkflowSuspendedError)) {
        throw error;
      }

      // Aggregate results
      const outputs = itemResults.map((r) => r?.output);
      const allSuccess = itemResults.every((r) => r?.status === StepStatus.SUCCESS);
      const anyFailed = itemResults.some((r) => r?.status === StepStatus.FAILED);
      const anySuspended = itemResults.some((r) => r?.status === StepStatus.SUSPENDED);

      // Aggregate usage
      const aggregatedUsage = itemResults.reduce(
        (acc, r) => {
          if (r?.usage) {
            acc.prompt_tokens += r.usage.prompt_tokens;
            acc.completion_tokens += r.usage.completion_tokens;
            acc.total_tokens += r.usage.total_tokens;
          }
          return acc;
        },
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      );

      // Map child properties
      const mappedOutputs = ForeachExecutor.aggregateOutputs(outputs);

      // Determine final status
      let finalStatus: (typeof StepStatus)[keyof typeof StepStatus] = StepStatus.FAILED;
      if (allSuccess) {
        finalStatus = StepStatus.SUCCESS;
      } else if (anyFailed) {
        finalStatus = StepStatus.FAILED;
      } else if (anySuspended) {
        finalStatus = StepStatus.SUSPENDED;
      }

      const aggregatedContext: ForeachStepContext = {
        output: outputs,
        outputs: mappedOutputs,
        status: finalStatus,
        items: itemResults,
        usage: aggregatedUsage,
      };

      const persistedContext = {
        ...aggregatedContext,
        __foreachItems: items,
      };

      // Update parent step record
      await this.db.completeStep(
        parentStepExecId,
        finalStatus,
        persistedContext,
        finalStatus === StepStatus.FAILED ? 'One or more iterations failed' : undefined
      );

      if (finalStatus === StepStatus.SUSPENDED) {
        const suspendedItem = itemResults.find((r) => r.status === StepStatus.SUSPENDED);
        throw new WorkflowSuspendedError(
          suspendedItem?.error || 'Iteration suspended',
          step.id,
          'text'
        );
      }

      if (finalStatus === StepStatus.FAILED) {
        throw new Error(`Step ${step.id} failed: one or more iterations failed`);
      }

      return aggregatedContext;
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        throw error;
      }
      // Mark parent step as failed (if not already handled)
      const errorMsg = error instanceof Error ? error.message : String(error);
      try {
        await this.db.completeStep(parentStepExecId, StepStatus.FAILED, null, errorMsg);
      } catch (dbError) {
        this.logger.error(`Failed to update DB on foreach error: ${dbError}`);
      }
      throw error;
    }
  }
}
