import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { LlmStep, PlanStep, Step } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import { executeLlmStep } from './llm-executor.ts';
import type { StepExecutorOptions, StepResult } from './types.ts';

export const DEFAULT_PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          needs: { type: 'array', items: { type: 'string' } },
          workflow: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: true,
      },
    },
    notes: { type: 'string' },
  },
  required: ['steps'],
};

export function buildPlanPrompt(goal: string, context: string, constraints: string): string {
  return `You are a planner. Break the goal into a concise, ordered list of steps.

Goal:
${goal}

Context:
${context || 'None'}

Constraints:
${constraints || 'None'}

Each step should be small, specific, and independently executable.
Include any dependencies under "needs" and optional "workflow" or "inputs" when appropriate.

Return only the structured JSON required by the schema.`;
}

export async function executePlanStep(
  step: PlanStep,
  context: ExpressionContext,
  logger: Logger,
  options: StepExecutorOptions
): Promise<StepResult> {
  const goal = ExpressionEvaluator.evaluateString(step.goal, context);
  const contextText = step.context ? ExpressionEvaluator.evaluateString(step.context, context) : '';
  const constraintsText = step.constraints
    ? ExpressionEvaluator.evaluateString(step.constraints, context)
    : '';
  const prompt = step.prompt
    ? ExpressionEvaluator.evaluateString(step.prompt, context)
    : buildPlanPrompt(goal, contextText, constraintsText);

  const llmStep: LlmStep = {
    id: step.id,
    type: 'llm',
    agent: step.agent || 'keystone-architect',
    provider: step.provider,
    model: step.model,
    prompt,
    tools: step.tools,
    allowedHandoffs: step.allowedHandoffs,
    maxIterations: step.maxIterations,
    maxMessageHistory: step.maxMessageHistory,
    contextStrategy: step.contextStrategy,
    qualityGate: step.qualityGate,
    useGlobalMcp: step.useGlobalMcp,
    allowClarification: step.allowClarification,
    mcpServers: step.mcpServers,
    useStandardTools: step.useStandardTools,
    allowOutsideCwd: step.allowOutsideCwd,
    allowInsecure: step.allowInsecure,
    handoff: step.handoff,
    outputSchema: step.outputSchema ?? DEFAULT_PLAN_OUTPUT_SCHEMA,
    needs: [],
  };

  const execLlm = options.executeLlmStep || executeLlmStep;
  const execStep = options.executeStep; // This will be passed from step-executor

  return execLlm(
    llmStep,
    context,
    (s, c) => execStep(s, c, logger, { ...options, stepExecutionId: undefined }),
    logger,
    options.mcpManager,
    options.artifactRoot, // Note: using artifactRoot as fallback for workflowDir if not explicit
    options.abortSignal,
    options.emitEvent,
    options.runId ? { runId: options.runId } : undefined
  );
}
