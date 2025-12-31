import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import type { Blueprint, BlueprintStep, LlmStep, Step } from '../../parser/schema.ts';
import { BlueprintUtils } from '../../utils/blueprint-utils.ts';
import type { Logger } from '../../utils/logger.ts';
import type { WorkflowEvent } from '../events.ts';
import type { MCPManager } from '../mcp-manager.ts';
import { executeLlmStep } from './llm-executor.ts';
import type { StepResult } from './types.ts';

/**
 * Execute a blueprint step
 */
export async function executeBlueprintStep(
  step: BlueprintStep,
  context: ExpressionContext,
  executeStepFn: (step: Step, context: ExpressionContext) => Promise<StepResult>,
  logger: Logger,
  options: {
    mcpManager?: MCPManager;
    workflowDir?: string;
    abortSignal?: AbortSignal;
    runId?: string;
    artifactRoot?: string;
    executeLlmStep?: typeof executeLlmStep;
    emitEvent?: (event: WorkflowEvent) => void;
    workflowName?: string;
  }
): Promise<StepResult> {
  const {
    mcpManager,
    workflowDir,
    abortSignal,
    runId,
    artifactRoot,
    executeLlmStep: injected,
    emitEvent,
    workflowName,
  } = options;
  const runLlmStep = injected || executeLlmStep;

  // 1. Create a virtual LLM step to generate the blueprint
  // We reuse the BlueprintSchema as the outputSchema for validation
  const llmStep: LlmStep = {
    id: `${step.id}_generation`,
    type: 'llm',
    agent: step.agent || 'keystone-architect',
    prompt: step.prompt,
    outputSchema: {
      // Reference the actual BlueprintSchema structure
      // Since we are in runtime, we need the raw object or a way to get it from Zod
      // For now, let's assume BlueprintSchema is available or we define it here
      // Actually, it's better to just use the Zod schema for validation later
      // But the LLM needs a JSON Schema.
      type: 'object',
      properties: {
        architecture: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            patterns: { type: 'array', items: { type: 'string' } },
          },
          required: ['description'],
        },
        apis: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              endpoints: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    method: { type: 'string' },
                    purpose: { type: 'string' },
                  },
                  required: ['path', 'method', 'purpose'],
                },
              },
            },
            required: ['name', 'description'],
          },
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              purpose: { type: 'string' },
              constraints: { type: 'array', items: { type: 'string' } },
            },
            required: ['path', 'purpose'],
          },
        },
        dependencies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              purpose: { type: 'string' },
            },
            required: ['name', 'purpose'],
          },
        },
        constraints: { type: 'array', items: { type: 'string' } },
      },
      required: ['architecture', 'files'],
    },
    useStandardTools: true,
    needs: [],
    maxIterations: 10,
  };

  logger.log(`  🎨 Generating system blueprint using agent: ${llmStep.agent}`);

  const llmResult = await runLlmStep(
    llmStep,
    context,
    executeStepFn,
    logger,
    mcpManager,
    workflowDir,
    abortSignal,
    emitEvent,
    workflowName ? { runId, workflow: workflowName } : undefined
  );

  if (llmResult.status !== 'success') {
    return llmResult;
  }

  const blueprint = llmResult.output as Blueprint;

  // 2. Calculate hash for immutability check
  const hash = BlueprintUtils.calculateHash(blueprint);

  // 3. Persist as artifact
  const root = artifactRoot || path.join(process.cwd(), '.keystone', 'artifacts');
  const runDir = runId ? path.join(root, runId) : root;
  mkdirSync(runDir, { recursive: true });

  const artifactPath = path.join(runDir, `blueprint-${hash.substring(0, 8)}.json`);
  await Bun.write(artifactPath, JSON.stringify(blueprint, null, 2));

  logger.log(`  📦 Blueprint persisted: ${path.relative(process.cwd(), artifactPath)}`);

  return {
    output: {
      ...blueprint,
      __hash: hash,
      __artifactPath: artifactPath,
    },
    status: 'success',
    usage: llmResult.usage,
  };
}
