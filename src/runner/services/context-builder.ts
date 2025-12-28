import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { WorkflowState } from '../workflow-state.ts';
import type { Workflow } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';

/**
 * Service for building the expression context for workflow steps.
 */
export class ContextBuilder {
    constructor(
        private workflow: Workflow,
        private inputs: Record<string, unknown>,
        private secretValues: string[],
        private state: WorkflowState,
        private logger: Logger
    ) { }

    /**
     * Builds the context object used for expression evaluation.
     */
    public buildContext(
        secrets: Record<string, string>,
        envOverrides: Record<string, string> = {},
        memory: Record<string, unknown> = {},
        lastFailedStep?: string,
        item?: unknown,
        index?: number
    ): ExpressionContext {
        const stepsContext: Record<
            string,
            {
                output?: unknown;
                outputs?: Record<string, unknown>;
                status?: string;
                error?: string;
                items?: any[];
            }
        > = {};

        for (const [stepId, ctx] of this.state.entries()) {
            stepsContext[stepId] = {
                output: ctx.output,
                outputs: ctx.outputs,
                status: ctx.status,
                error: ctx.error,
                ...(ctx && 'items' in ctx ? { items: (ctx as any).items } : {}),
            };
        }

        const baseContext: ExpressionContext = {
            inputs: this.inputs,
            secrets: secrets,
            secretValues: this.secretValues,
            steps: stepsContext,
            item,
            index,
            env: {},
            envOverrides: envOverrides,
            memory: memory,
            output: item
                ? undefined
                : this.state.get(this.workflow.steps.find((s) => !s.foreach)?.id || '')?.output,
            last_failed_step: lastFailedStep ? { id: lastFailedStep, error: '' } : undefined,
        };

        const resolvedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                resolvedEnv[key] = value;
            }
        }

        if (this.workflow.env) {
            for (const [key, value] of Object.entries(this.workflow.env)) {
                try {
                    resolvedEnv[key] = ExpressionEvaluator.evaluateString(value, {
                        ...baseContext,
                        env: resolvedEnv,
                    });
                } catch (error) {
                    this.logger.warn(
                        `Warning: Failed to evaluate workflow env "${key}": ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        baseContext.env = { ...resolvedEnv, ...envOverrides };
        return baseContext;
    }
    /**
     * Builds input object for a specific step.
     */
    public buildStepInputs(step: any, context: ExpressionContext): Record<string, unknown> {
        const stripUndefined = (value: Record<string, unknown>) => {
            const result: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(value)) {
                if (val !== undefined) {
                    result[key] = val;
                }
            }
            return result;
        };

        switch (step.type) {
            case 'shell': {
                let env: Record<string, string> | undefined;
                if (step.env) {
                    env = {};
                    for (const [key, value] of Object.entries(step.env)) {
                        env[key] = ExpressionEvaluator.evaluateString(value as string, context);
                    }
                }
                return stripUndefined({
                    run: ExpressionEvaluator.evaluateString((step as any).run, context),
                    env,
                });
            }
            case 'file': {
                return stripUndefined({
                    path: ExpressionEvaluator.evaluateString((step as any).path, context),
                    content: (step as any).content
                        ? ExpressionEvaluator.evaluateString((step as any).content, context)
                        : undefined,
                    op: (step as any).op,
                });
            }
            default:
                // For most steps, we just pass through properties which might contain expressions
                const inputs: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(step)) {
                    if (key === 'id' || key === 'type' || key === 'if' || key === 'foreach') continue;
                    if (typeof value === 'string' && value.includes('{{')) {
                        inputs[key] = ExpressionEvaluator.evaluateString(value, context);
                    } else {
                        inputs[key] = value;
                    }
                }
                return stripUndefined(inputs);
        }
    }
}
