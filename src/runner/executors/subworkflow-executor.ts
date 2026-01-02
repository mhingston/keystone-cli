import { dirname } from 'node:path';
import { type ExpressionContext, ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { WorkflowStep } from '../../parser/schema.ts';
import { WorkflowParser } from '../../parser/workflow-parser';
import type { Logger } from '../../utils/logger.ts';
import { WorkflowRegistry } from '../../utils/workflow-registry';
import type { MCPManager } from '../mcp-manager.ts';
import type { StepResult } from './types.ts';

/**
 * Interface to avoid circular dependencies with WorkflowRunner
 */
export interface RunnerFactory {
  create(
    workflow: any,
    options: { signal?: AbortSignal; [key: string]: any }
  ): {
    run(): Promise<Record<string, unknown>>;
    runId: string;
  };
}

/**
 * Execute a sub-workflow step
 */
export async function executeSubWorkflow(
  step: WorkflowStep,
  context: ExpressionContext,
  options: {
    runnerFactory: RunnerFactory;
    parentWorkflowDir?: string;
    parentDbPath: string;
    parentLogger: Logger;
    parentMcpManager: MCPManager;
    parentDepth: number;
    parentOptions: any;
    abortSignal?: AbortSignal;
    stepExecutionId?: string;
    parentDb?: any; // WorkflowDb
  }
): Promise<StepResult> {
  if (options.abortSignal?.aborted) {
    throw new Error('Sub-workflow aborted');
  }
  const workflowPath = WorkflowRegistry.resolvePath(step.path, options.parentWorkflowDir);
  const workflow = WorkflowParser.loadWorkflow(workflowPath);
  const subWorkflowDir = dirname(workflowPath);

  // Evaluate inputs for the sub-workflow
  const inputs: Record<string, unknown> = {};
  if (step.inputs) {
    for (const [key, value] of Object.entries(step.inputs)) {
      inputs[key] = ExpressionEvaluator.evaluate(value, context);
    }
  }

  // Create a new runner for the sub-workflow via factory to avoid circular imports
  const subRunner = options.runnerFactory.create(workflow, {
    ...options.parentOptions,
    inputs,
    dbPath: options.parentDbPath,
    db: options.parentDb, // Reuse existing DB connection
    logger: options.parentLogger,
    mcpManager: options.parentMcpManager,
    workflowDir: subWorkflowDir,
    depth: options.parentDepth + 1,
    signal: options.abortSignal,
  });

  // Track sub-workflow run ID in parent step metadata for rollback safety
  if (options.stepExecutionId && options.parentDb) {
    try {
      await options.parentDb.updateStepMetadata(options.stepExecutionId, {
        __subRunId: subRunner.runId,
      });
    } catch (error) {
      options.parentLogger.warn(
        `Failed to store sub-workflow run ID in metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  try {
    const output = await subRunner.run();

    const rawOutputs =
      typeof output === 'object' && output !== null && !Array.isArray(output) ? output : {};
    const mappedOutputs: Record<string, unknown> = {};

    // Handle explicit output mapping
    if (step.outputMapping) {
      for (const [alias, mapping] of Object.entries(step.outputMapping)) {
        let originalKey: string;
        let defaultValue: unknown;

        if (typeof mapping === 'string') {
          originalKey = mapping;
        } else {
          originalKey = mapping.from;
          defaultValue = mapping.default;
        }

        if (originalKey in rawOutputs) {
          mappedOutputs[alias] = rawOutputs[originalKey];
        } else if (defaultValue !== undefined) {
          mappedOutputs[alias] = defaultValue;
        } else {
          throw new Error(
            `Sub-workflow output "${originalKey}" not found (required by mapping "${alias}" in step "${step.id}")`
          );
        }
      }
    }

    return {
      output: {
        ...mappedOutputs,
        outputs: rawOutputs, // Namespaced raw outputs
        __subRunId: subRunner.runId, // Track sub-workflow run ID for rollback
      },
      status: 'success',
    };
  } catch (error) {
    return {
      output: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
