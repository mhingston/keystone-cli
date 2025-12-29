import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { Workflow } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { WorkflowState } from '../workflow-state.ts';

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
  ) {}

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
          run: ExpressionEvaluator.evaluateString(step.run, context),
          args: step.args?.map((arg: string) => ExpressionEvaluator.evaluateString(arg, context)),
          dir: step.dir ? ExpressionEvaluator.evaluateString(step.dir, context) : undefined,
          env,
          allowInsecure: step.allowInsecure,
        });
      }
      case 'file':
        return stripUndefined({
          path: ExpressionEvaluator.evaluateString(step.path, context),
          content:
            step.content !== undefined
              ? ExpressionEvaluator.evaluateString(step.content as string, context)
              : undefined,
          op: step.op,
          allowOutsideCwd: step.allowOutsideCwd,
        });
      case 'artifact':
        return stripUndefined({
          op: step.op,
          name: ExpressionEvaluator.evaluateString(step.name, context),
          paths: step.paths?.map((p: string) => ExpressionEvaluator.evaluateString(p, context)),
          path: step.path
            ? ExpressionEvaluator.evaluateString(step.path as string, context)
            : undefined,
          allowOutsideCwd: step.allowOutsideCwd,
        });
      case 'request': {
        let headers: Record<string, string> | undefined;
        if (step.headers) {
          headers = {};
          for (const [key, value] of Object.entries(step.headers)) {
            headers[key] = ExpressionEvaluator.evaluateString(value as string, context);
          }
        }
        return stripUndefined({
          url: ExpressionEvaluator.evaluateString(step.url, context),
          method: step.method,
          headers,
          body:
            step.body !== undefined
              ? ExpressionEvaluator.evaluateObject(step.body, context)
              : undefined,
          allowInsecure: step.allowInsecure,
        });
      }
      case 'human':
        return stripUndefined({
          message: ExpressionEvaluator.evaluateString(step.message, context),
          inputType: step.inputType,
        });
      case 'sleep': {
        const evaluated = ExpressionEvaluator.evaluate(step.duration.toString(), context);
        return { duration: Number(evaluated) };
      }
      case 'llm':
        return stripUndefined({
          agent: ExpressionEvaluator.evaluateString(step.agent, context),
          provider: step.provider
            ? ExpressionEvaluator.evaluateString(step.provider, context)
            : undefined,
          model: step.model ? ExpressionEvaluator.evaluateString(step.model, context) : undefined,
          prompt: ExpressionEvaluator.evaluateString(step.prompt, context),
          tools: step.tools,
          maxIterations: step.maxIterations,
          useGlobalMcp: step.useGlobalMcp,
          allowClarification: step.allowClarification,
          mcpServers: step.mcpServers,
          useStandardTools: step.useStandardTools,
          allowOutsideCwd: step.allowOutsideCwd,
          allowInsecure: step.allowInsecure,
        });
      case 'workflow':
        return stripUndefined({
          path: step.path,
          inputs: step.inputs
            ? ExpressionEvaluator.evaluateObject(step.inputs, context)
            : undefined,
        });
      case 'script':
        return stripUndefined({
          run: step.run,
          allowInsecure: step.allowInsecure,
        });
      case 'engine': {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(step.env || {})) {
          env[key] = ExpressionEvaluator.evaluateString(value as string, context);
        }
        return stripUndefined({
          command: ExpressionEvaluator.evaluateString(step.command, context),
          args: step.args?.map((arg: string) => ExpressionEvaluator.evaluateString(arg, context)),
          input:
            step.input !== undefined
              ? ExpressionEvaluator.evaluateObject(step.input, context)
              : undefined,
          env,
          cwd: step.cwd ? ExpressionEvaluator.evaluateString(step.cwd, context) : undefined,
        });
      }
      case 'memory':
        return stripUndefined({
          op: step.op,
          query: step.query ? ExpressionEvaluator.evaluateString(step.query, context) : undefined,
          text: step.text ? ExpressionEvaluator.evaluateString(step.text, context) : undefined,
          model: step.model,
          metadata: step.metadata
            ? ExpressionEvaluator.evaluateObject(step.metadata, context)
            : undefined,
          limit: step.limit,
        });
      case 'wait':
        return stripUndefined({
          event: ExpressionEvaluator.evaluateString(step.event, context),
          oneShot: step.oneShot,
        });
      default: {
        // For fallback, pass through properties which might contain expressions
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
}
