import { randomUUID } from 'node:crypto';
import type { WorkflowDb } from '../db/workflow-db.ts';
import { type ExpressionContext, ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Step } from '../parser/schema.ts';
import { StepStatus, WorkflowStatus } from '../types/status.ts';
import type { Logger } from '../utils/logger.ts';
import { WorkflowSuspendedError } from './step-executor.ts';
import { ResourcePoolManager } from './resource-pool.ts';
import type { ForeachStepContext, StepContext } from './workflow-runner.ts';

export type ExecuteStepCallback = (
  step: Step,
  context: ExpressionContext,
  stepExecId: string
) => Promise<StepContext>;

export class ForeachExecutor {
  private static readonly MEMORY_WARNING_THRESHOLD = 1000;
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

    const items = ExpressionEvaluator.evaluate(step.foreach, baseContext);
    if (!Array.isArray(items)) {
      throw new Error(`foreach expression must evaluate to an array: ${step.foreach}`);
    }

    this.logger.log(`  ⤷ Executing step ${step.id} for ${items.length} items`);

    if (items.length > ForeachExecutor.MEMORY_WARNING_THRESHOLD && !this.hasWarnedMemory) {
      this.logger.warn(
        `  ⚠️  Warning: Large foreach loop detected (${items.length} items). This may consume significant memory and lead to instability.`
      );
      this.hasWarnedMemory = true;
    }

    // Evaluate concurrency
    let concurrencyLimit = items.length;
    if (step.concurrency !== undefined) {
      if (typeof step.concurrency === 'string') {
        concurrencyLimit = Number(ExpressionEvaluator.evaluate(step.concurrency, baseContext));
        if (!Number.isInteger(concurrencyLimit) || concurrencyLimit <= 0) {
          throw new Error(
            `concurrency must evaluate to a positive integer, got: ${concurrencyLimit}`
          );
        }
      } else {
        concurrencyLimit = step.concurrency;
        if (!Number.isInteger(concurrencyLimit) || concurrencyLimit <= 0) {
          throw new Error(`concurrency must be a positive integer, got: ${concurrencyLimit}`);
        }
      }
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

      // Ensure array is correct length
      if (itemResults.length !== items.length) {
        itemResults.length = items.length;
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

            // Skip if already successful or skipped
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

            // Check DB again for robustness (resume flows only)
            const existingExec = shouldCheckDb
              ? await this.db.getStepByIteration(runId, step.id, i)
              : undefined;
            if (
              existingExec &&
              (existingExec.status === StepStatus.SUCCESS ||
                existingExec.status === StepStatus.SKIPPED)
            ) {
              let output: unknown = null;
              let itemStatus = existingExec.status as
                | typeof StepStatus.SUCCESS
                | typeof StepStatus.SKIPPED
                | typeof StepStatus.FAILED;
              let itemError: string | undefined = existingExec.error || undefined;

              try {
                output = existingExec.output ? JSON.parse(existingExec.output) : null;
              } catch (error) {
                this.logger.warn(
                  `Failed to parse output for step ${step.id} iteration ${i}: ${error}`
                );
                output = { error: 'Failed to parse output' };
                itemStatus = StepStatus.FAILED;
                itemError = 'Failed to parse output';
                aborted = true; // Fail fast if we find corrupted data
                try {
                  await this.db.completeStep(
                    existingExec.id,
                    StepStatus.FAILED,
                    output,
                    'Failed to parse output'
                  );
                } catch (dbError) {
                  this.logger.warn(
                    `Failed to update DB for corrupted output on step ${step.id} iteration ${i}: ${dbError}`
                  );
                }
              }
              itemResults[i] = {
                output,
                outputs:
                  typeof output === 'object' && output !== null && !Array.isArray(output)
                    ? (output as Record<string, unknown>)
                    : {},
                status: itemStatus,
                error: itemError,
              } as StepContext;
              continue;
            }

            if (aborted || this.abortSignal?.aborted) break;

            const stepExecId = randomUUID();
            await this.db.createStep(stepExecId, runId, step.id, i);

            // Execute and store result
            try {
              if (aborted || this.abortSignal?.aborted) break;

              const poolName = step.pool || step.type;
              let release: (() => void) | undefined;

              try {
                if (this.resourcePool) {
                  release = await this.resourcePool.acquire(poolName, { signal: this.abortSignal });
                }

                this.logger.log(`  ⤷ [${i + 1}/${items.length}] Executing iteration...`);
                itemResults[i] = await this.executeStepFn(step, itemContext, stepExecId);
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
      if (firstError) {
        throw firstError.reason;
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
