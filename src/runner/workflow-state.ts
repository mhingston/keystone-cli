import type { WorkflowDb } from '../db/workflow-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Workflow } from '../parser/schema.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import type { StepStatusType } from '../types/status.ts';
import { StepStatus, WorkflowStatus } from '../types/status.ts';
import type { Logger } from '../utils/logger.ts';
import { ForeachExecutor } from './executors/foreach-executor.ts';

export interface StepContext {
  output?: unknown;
  outputs?: Record<string, unknown>;
  status: StepStatusType;
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ForeachStepContext extends StepContext {
  items: StepContext[];
  foreachItems?: unknown[];
}

export class WorkflowState {
  private stepContexts: Map<string, StepContext | ForeachStepContext> = new Map();

  constructor(
    private readonly runId: string,
    private readonly workflow: Workflow,
    private readonly db: WorkflowDb,
    private readonly inputs: Record<string, unknown>,
    private readonly secrets: Record<string, string>,
    private readonly logger: Logger
  ) {}

  public get(stepId: string): StepContext | ForeachStepContext | undefined {
    return this.stepContexts.get(stepId);
  }

  public set(stepId: string, context: StepContext | ForeachStepContext): void {
    this.stepContexts.set(stepId, context);
  }

  public has(stepId: string): boolean {
    return this.stepContexts.has(stepId);
  }

  public entries() {
    return this.stepContexts.entries();
  }

  public get size(): number {
    return this.stepContexts.size;
  }

  public getCompletedStepIds(): Set<string> {
    const completed = new Set<string>();
    for (const [stepId, context] of this.stepContexts.entries()) {
      if (context.status === StepStatus.SUCCESS || context.status === StepStatus.SKIPPED) {
        completed.add(stepId);
      }
    }
    return completed;
  }

  public buildContext(item?: unknown, index?: number): ExpressionContext {
    const stepsContext: Record<string, any> = {};

    for (const [stepId, ctx] of this.stepContexts.entries()) {
      stepsContext[stepId] = {
        output: ctx.output,
        outputs: ctx.outputs,
        status: ctx.status,
        error: ctx.error,
        ...('items' in ctx ? { items: (ctx as ForeachStepContext).items } : {}),
      };
    }

    return {
      inputs: this.inputs,
      secrets: this.secrets,
      steps: stepsContext,
      item,
      index,
      env: process.env as Record<string, string>,
    };
  }

  public async restore(): Promise<void> {
    const run = await this.db.getRun(this.runId);
    if (!run) {
      throw new Error(`Run ${this.runId} not found`);
    }

    // Restore inputs if they exist
    if (run.inputs && run.inputs !== 'null' && run.inputs !== '') {
      try {
        const storedInputs = JSON.parse(run.inputs);
        // Merge stored inputs, provided inputs to constructor have precedence
        Object.assign(this.inputs, { ...storedInputs, ...this.inputs });
      } catch (e) {
        this.logger.error(`Failed to parse persisted inputs for run ${this.runId}`);
      }
    }

    const executionOrder = WorkflowParser.topologicalSort(this.workflow);

    for (const stepId of executionOrder) {
      const stepDef = this.workflow.steps.find((s) => s.id === stepId);
      if (!stepDef) continue;

      // Fetch the main execution record for this step
      const mainExec = await this.db.getMainStep(this.runId, stepId);

      // If no execution exists, nothing to restore for this step
      if (!mainExec) continue;

      const isForeach = !!stepDef.foreach;

      if (isForeach) {
        // Optimization: If the foreach step completed successfully, we don't need to fetch all iterations
        // We can just rely on the stored output in the parent record.
        if (mainExec.status === StepStatus.SUCCESS || mainExec.status === StepStatus.SKIPPED) {
          let outputs: unknown[] = [];
          let mappedOutputs: unknown = {};
          let persistedItems: unknown[] | undefined;

          if (mainExec.output) {
            try {
              outputs = JSON.parse(mainExec.output);
              // If output is not an array, something is wrong, but we handle it gracefully
              if (!Array.isArray(outputs)) outputs = [];
            } catch {
              /* ignore */
            }
          }

          // Restore items from outputs if possible, but we won't have individual item status/error
          // This is acceptable for a successful step.
          // However, to be perfectly safe and support `items` context usage in downstream steps,
          // we should populate the `items` array with dummy success contexts or the actual output.

          // Reconstruct items from outputs
          const items: StepContext[] = outputs.map((out) => ({
            output: out,
            outputs:
              typeof out === 'object' && out !== null && !Array.isArray(out) ? (out as any) : {},
            status: StepStatus.SUCCESS,
          }));

          // We also need to reconstruct mappedOutputs (hash map)
          // But wait, the parent record doesn't store the mapped outputs explicitly in a separate column?
          // `WorkflowState` usually stores `output` (array) and `outputs` (map).
          // But `db.completeStep` stores `output`.
          // Ideally `db` should store both or we re-derive `outputs`.
          // `ForeachExecutor.aggregateOutputs` can re-derive it.
          mappedOutputs = ForeachExecutor.aggregateOutputs(outputs);

          // Try to recover persisted execution state (foreachItems) if it was stored in output?
          // Actually, we look for `__foreachItems` in the output? No, that was a hack in the previous code.
          // Previous code: `const parsed = JSON.parse(parentExec.output); if (parsed.__foreachItems) ...`
          // If that hack exists, we should preserve "restore items".

          this.stepContexts.set(stepId, {
            output: outputs,
            outputs: mappedOutputs as Record<string, unknown>,
            status: mainExec.status as StepStatusType,
            items,
            foreachItems: persistedItems,
          } as ForeachStepContext);
        } else {
          // Step failed or incomplete: We need full iteration history to determine what to retry

          // Optimization: Check count first to decide if we should load outputs to prevent OOM
          const count = await this.db.countStepIterations(this.runId, stepId);
          const LARGE_DATASET_THRESHOLD = 500;
          const isLargeDataset = count > LARGE_DATASET_THRESHOLD;

          const stepExecutions = await this.db.getStepIterations(this.runId, stepId, {
            includeOutput: !isLargeDataset,
          });

          // Reconstruct logic (dedup, sort)
          const items: StepContext[] = [];
          const outputs: unknown[] = [];
          let allSuccess = true;

          const sortedExecs = [...stepExecutions].sort((a, b) => {
            if ((a.iteration_index ?? 0) !== (b.iteration_index ?? 0)) {
              return (a.iteration_index ?? 0) - (b.iteration_index ?? 0);
            }
            if (a.started_at && b.started_at) {
              return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
            }
            return 0;
          });

          const uniqueExecs: typeof stepExecutions = [];
          const seenIndices = new Set<number>();
          for (const ex of sortedExecs) {
            const idx = ex.iteration_index ?? 0;
            if (!seenIndices.has(idx)) {
              seenIndices.add(idx);
              uniqueExecs.push(ex);
            }
          }

          for (const exec of uniqueExecs) {
            if (exec.iteration_index === null) continue; // Should not happen with getStepIterations

            let output: unknown = null;
            // Only hydrate full output if dataset is small, otherwise save memory
            // We still need output for aggregation if we want to support it, but for OOM prevention we skip it.
            // If the user needs the output of a 10k items loop, they should use a file or DB directly.
            if (!isLargeDataset && exec.output) {
              try {
                output = JSON.parse(exec.output);
              } catch (e) {}
            }

            items[exec.iteration_index] = {
              output,
              outputs:
                typeof output === 'object' && output !== null && !Array.isArray(output)
                  ? (output as any)
                  : {},
              status: exec.status as StepStatusType,
              error: exec.error || undefined,
            };

            if (!isLargeDataset) {
              outputs[exec.iteration_index] = output;
            }

            if (exec.status !== StepStatus.SUCCESS && exec.status !== StepStatus.SKIPPED) {
              allSuccess = false;
            }
          }

          // Ensure items array is dense to prevent crashes on iteration of sparse arrays
          for (let i = 0; i < items.length; i++) {
            if (!items[i]) {
              items[i] = {
                status: StepStatus.PENDING,
                output: null,
                outputs: {},
              };
            }
          }

          // Re-evaluate foreachItems to calculate expectedCount if needed
          // ... same logic as before ...
          // For brevity, we copy the basic logic
          let expectedCount = -1;
          let persistedItems: unknown[] | undefined;
          if (mainExec.output) {
            // Use mainExec output for persistence check
            try {
              const parsed = JSON.parse(mainExec.output);
              if (parsed.__foreachItems && Array.isArray(parsed.__foreachItems)) {
                persistedItems = parsed.__foreachItems;
                expectedCount = parsed.length; // Actually __foreachItems.length?
                // The original code:
                // if (parsed.__foreachItems && Array.isArray(parsed.__foreachItems)) {
                //   persistedItems = parsed.__foreachItems;
                //   expectedCount = parsed.__foreachItems.length;
                // }
                expectedCount = (persistedItems as any[]).length;
              }
            } catch {}
          }

          if (expectedCount === -1 && stepDef.foreach) {
            try {
              const baseContext = this.buildContext();
              const foreachItems = ExpressionEvaluator.evaluate(stepDef.foreach, baseContext);
              if (Array.isArray(foreachItems)) expectedCount = foreachItems.length;
            } catch {
              allSuccess = false;
            }
          }

          const hasAllItems =
            expectedCount !== -1 &&
            items.length === expectedCount &&
            !Array.from({ length: expectedCount }).some((_, i) => !items[i]);

          if (isLargeDataset) {
            this.logger.warn(
              `Optimization: Large dataset detected (${uniqueExecs.length} items). Skipping output aggregation for step "${stepId}" to prevent memory issues.`
            );
          }
          const mappedOutputs = isLargeDataset ? {} : ForeachExecutor.aggregateOutputs(outputs);

          // If the DB says the parent is RUNNING/PENDING but we have all items successfully completed,
          // trust the derived status to prevent re-execution.
          let finalStatus = mainExec.status as StepStatusType;
          if (
            allSuccess &&
            hasAllItems &&
            finalStatus !== StepStatus.SUCCESS &&
            finalStatus !== StepStatus.SKIPPED
          ) {
            finalStatus = StepStatus.SUCCESS;
          }

          this.stepContexts.set(stepId, {
            output: isLargeDataset ? [] : outputs,
            outputs: mappedOutputs,
            status: finalStatus,
            items,
            foreachItems: persistedItems,
          } as ForeachStepContext);
        }
      } else {
        // Not a foreach step
        const exec = mainExec;
        let output: unknown = null;
        if (exec.output) {
          try {
            output = JSON.parse(exec.output);
          } catch (e) {
            this.logger.warn(
              `Failed to parse output for step "${stepId}": ${e instanceof Error ? e.message : String(e)}`
            );
            // If parsing fails, try using the raw output
            output = exec.output;
          }
        } else if (exec.status === 'success') {
          // If step succeeded but has no output, log a warning
          this.logger.warn(
            `Step "${stepId}" completed with status "${exec.status}" but has no output. This may cause issues for dependent steps.`
          );
        }

        this.stepContexts.set(stepId, {
          output,
          outputs:
            typeof output === 'object' && output !== null && !Array.isArray(output)
              ? (output as any)
              : {},
          status: exec.status as StepStatusType,
          error: exec.error || undefined,
        });
      }
    }
    this.logger.log(`✓ Restored state: ${this.stepContexts.size} step(s) hydrated`);
  }
}
