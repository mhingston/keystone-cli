import type { WorkflowDb } from '../db/workflow-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import type { StepStatusType } from '../types/status.ts';
import type { Logger } from '../utils/logger.ts';
import { WorkflowStatus, StepStatus } from '../types/status.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { ForeachExecutor } from './foreach-executor.ts';
import type { Workflow } from '../parser/schema.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';

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
    ) { }

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
                ...('items' in ctx ? { items: (ctx as ForeachStepContext).items } : {})
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

        // Load all step executions for this run
        const steps = await this.db.getStepsByRun(this.runId);

        // Group steps by step_id
        const stepExecutionsByStepId = new Map<string, typeof steps>();
        for (const step of steps) {
            if (!stepExecutionsByStepId.has(step.step_id)) {
                stepExecutionsByStepId.set(step.step_id, []);
            }
            stepExecutionsByStepId.get(step.step_id)?.push(step);
        }

        const executionOrder = WorkflowParser.topologicalSort(this.workflow);

        for (const stepId of executionOrder) {
            const stepExecutions = stepExecutionsByStepId.get(stepId);
            if (!stepExecutions || stepExecutions.length === 0) continue;

            const stepDef = this.workflow.steps.find((s) => s.id === stepId);
            if (!stepDef) continue;

            const isForeach = !!stepDef.foreach;

            if (isForeach) {
                const items: StepContext[] = [];
                const outputs: unknown[] = [];
                let allSuccess = true;

                const sortedExecs = [...stepExecutions].sort((a, b) => {
                    // Sort by iteration_index asc, then by created_at desc (newest first)
                    if ((a.iteration_index ?? 0) !== (b.iteration_index ?? 0)) {
                        return (a.iteration_index ?? 0) - (b.iteration_index ?? 0);
                    }
                    // If started_at is available, use it (newest first).
                    // Fallback to stable sort if nothing else.
                    if (a.started_at && b.started_at) {
                        return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
                    }
                    if (a.step_id && b.step_id) return 0; // Stability
                    return 0;
                });

                // Dedup by iteration_index, keeping the first (newest)
                const uniqueExecs: typeof steps = [];
                const seenIndices = new Set<number>();
                for (const ex of sortedExecs) {
                    const idx = ex.iteration_index ?? 0;
                    if (!seenIndices.has(idx)) {
                        seenIndices.add(idx);
                        uniqueExecs.push(ex);
                    }
                }

                for (const exec of uniqueExecs) {
                    if (exec.iteration_index === null) continue;

                    let output: unknown = null;
                    if (exec.output) {
                        try { output = JSON.parse(exec.output); } catch (e) { /* ignore */ }
                    }

                    items[exec.iteration_index] = {
                        output,
                        outputs: typeof output === 'object' && output !== null && !Array.isArray(output) ? (output as any) : {},
                        status: exec.status as StepStatusType,
                        error: exec.error || undefined,
                    };
                    outputs[exec.iteration_index] = output;
                    if (exec.status !== StepStatus.SUCCESS && exec.status !== StepStatus.SKIPPED) {
                        allSuccess = false;
                    }
                }

                // deterministic resume support
                let expectedCount = -1;
                let persistedItems: unknown[] | undefined;
                const parentExec = stepExecutions.find(e => e.iteration_index === null);
                if (parentExec?.output) {
                    try {
                        const parsed = JSON.parse(parentExec.output);
                        if (parsed.__foreachItems && Array.isArray(parsed.__foreachItems)) {
                            persistedItems = parsed.__foreachItems;
                            expectedCount = parsed.__foreachItems.length;
                        }
                    } catch { /* ignore */ }
                }

                if (expectedCount === -1 && stepDef.foreach) {
                    try {
                        const baseContext = this.buildContext();
                        const foreachItems = ExpressionEvaluator.evaluate(stepDef.foreach, baseContext);
                        if (Array.isArray(foreachItems)) expectedCount = foreachItems.length;
                    } catch { allSuccess = false; }
                }

                const hasAllItems = expectedCount !== -1 && items.length === expectedCount && !Array.from({ length: expectedCount }).some((_, i) => !items[i]);

                let status: StepStatusType = StepStatus.SUCCESS;
                if (allSuccess && hasAllItems) {
                    status = StepStatus.SUCCESS;
                } else if (items.some(i => i?.status === StepStatus.SUSPENDED)) {
                    status = StepStatus.SUSPENDED;
                } else {
                    status = StepStatus.FAILED;
                }

                const mappedOutputs = ForeachExecutor.aggregateOutputs(outputs);
                this.stepContexts.set(stepId, {
                    output: outputs,
                    outputs: mappedOutputs,
                    status,
                    items,
                    foreachItems: persistedItems,
                } as ForeachStepContext);
            } else {
                // Fix: Sort by started_at desc (newest first) to avoid restoring stale retries
                const sorted = [...stepExecutions].sort((a, b) => {
                    if (a.started_at && b.started_at) {
                        return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
                    }
                    return 0;
                });
                const exec = sorted[0];
                let output: unknown = null;
                if (exec.output) {
                    try { output = JSON.parse(exec.output); } catch (e) { /* ignore */ }
                }

                this.stepContexts.set(stepId, {
                    output,
                    outputs: typeof output === 'object' && output !== null && !Array.isArray(output) ? (output as any) : {},
                    status: exec.status as StepStatusType,
                    error: exec.error || undefined,
                });
            }
        }
        this.logger.log(`✓ Restored state: ${this.stepContexts.size} step(s) hydrated`);
    }
}
