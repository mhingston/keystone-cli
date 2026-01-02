import type { MemoryDb } from '../db/memory-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Step, WorkflowStep } from '../parser/schema.ts';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';

import { executeArtifactStep } from './executors/artifact-executor.ts';
import { executeBlueprintStep } from './executors/blueprint-executor.ts';
import { executeDynamicStep } from './executors/dynamic-executor.ts';
import { executeEngineStepWrapper } from './executors/engine-executor.ts';
import { executeFileStep } from './executors/file-executor.ts';
import { executeGitStep } from './executors/git-executor.ts';
import { executeHumanStep, executeSleepStep } from './executors/human-executor.ts';
import { executeJoinStep } from './executors/join-executor.ts';
import { executeLlmStep } from './executors/llm-executor.ts';
import { executeMemoryStep } from './executors/memory-executor.ts';
import { executePlanStep } from './executors/plan-executor.ts';
import { executeRequestStep } from './executors/request-executor.ts';
import { executeScriptStep } from './executors/script-executor.ts';
import { executeShellStep } from './executors/shell-executor.ts';
import {
  type StepExecutorOptions,
  type StepResult,
  WorkflowSuspendedError,
  WorkflowWaitingError,
} from './executors/types.ts';
import { executeWaitStep } from './executors/wait-executor.ts';

// Re-export for external consumers
export type { StepResult, StepExecutorOptions };
export { WorkflowSuspendedError, WorkflowWaitingError };

/**
 * Main dispatcher for workflow steps
 */
export async function executeStep(
  step: Step,
  context: ExpressionContext,
  logger: Logger = new ConsoleLogger(),
  options: StepExecutorOptions = {}
): Promise<StepResult> {
  const {
    executeWorkflowFn,
    mcpManager,
    memoryDb,
    workflowDir,
    dryRun,
    abortSignal,
    runId,
    stepExecutionId,
    artifactRoot,
    redactForStorage,
    executeStep: injectedExecuteStep,
    executeLlmStep: injectedExecuteLlmStep,
  } = options;

  try {
    if (abortSignal?.aborted) {
      throw new Error('Step canceled');
    }

    // Dry run handling - only shell steps are allowed in dry run
    if (dryRun && step.type !== 'shell') {
      logger.log(`[DRY RUN] Skipping ${step.type} step: ${step.id}`);
      return {
        output: null,
        status: 'skipped',
      };
    }

    let result: StepResult;
    switch (step.type) {
      case 'shell':
        result = await executeShellStep(step, context, logger, dryRun, abortSignal);
        break;
      case 'file':
        result = await executeFileStep(step, context, logger, abortSignal);
        break;
      case 'artifact':
        result = await executeArtifactStep(step, context, logger, {
          artifactRoot,
          workflowDir,
          runId,
          abortSignal,
        });
        break;
      case 'request':
        result = await executeRequestStep(step, context, logger, abortSignal);
        break;
      case 'human':
        result = await executeHumanStep(step, context, logger, abortSignal);
        break;
      case 'sleep':
        result = await executeSleepStep(step, context, logger, abortSignal);
        break;
      case 'llm':
        result = await (injectedExecuteLlmStep || executeLlmStep)(
          step,
          context,
          (s, c) => {
            const exec = injectedExecuteStep || executeStep;
            return exec(s, c, logger, {
              ...options,
              stepExecutionId: undefined,
            });
          },
          logger,
          mcpManager,
          workflowDir,
          abortSignal,
          options.emitEvent,
          options.workflowName
            ? { runId: options.runId, workflow: options.workflowName }
            : undefined
        );
        break;
      case 'plan':
        result = await executePlanStep(step, context, logger, {
          ...options,
          executeStep: injectedExecuteStep || executeStep,
        });
        break;
      case 'wait':
        result = await executeWaitStep(step, context, logger, options);
        break;
      case 'memory':
        result = await executeMemoryStep(step, context, logger, options);
        break;
      case 'workflow':
        if (!executeWorkflowFn) {
          throw new Error('Workflow executor not provided');
        }
        result = await executeWorkflowFn(step, context, abortSignal, options.stepExecutionId);
        break;
      case 'script':
        result = await executeScriptStep(step, context, logger, {
          sandbox: options.sandbox,
          abortSignal,
        });
        break;
      case 'engine':
        result = await executeEngineStepWrapper(step, context, logger, {
          abortSignal,
          runId,
          stepExecutionId,
          artifactRoot,
          redactForStorage,
        });
        break;
      case 'blueprint':
        result = await executeBlueprintStep(
          step,
          context,
          (s, c) => (injectedExecuteStep || executeStep)(s, c, logger, options),
          logger,
          {
            mcpManager,
            workflowDir,
            abortSignal,
            runId,
            artifactRoot,
            emitEvent: options.emitEvent,
            workflowName: options.workflowName,
          }
        );
        break;
      case 'join':
        result = await executeJoinStep(step, context, logger, abortSignal);
        break;
      case 'git':
        result = await executeGitStep(step, context, logger, abortSignal);
        break;
      case 'dynamic':
        result = await executeDynamicStep(
          step,
          context,
          (s, c) => (injectedExecuteStep || executeStep)(s, c, logger, options),
          logger,
          {
            mcpManager,
            workflowDir,
            abortSignal,
            runId,
            artifactRoot,
            executeLlmStep: injectedExecuteLlmStep || executeLlmStep,
            workflowName: options.workflowName,
            db: options.db,
            depth: options.depth,
          }
        );
        break;
      default:
        throw new Error(`Unknown step type: ${(step as Step).type}`);
    }

    // Apply transformation if specified and step succeeded
    if (step.transform && result.status === 'success') {
      const transformContext = {
        ...(typeof result.output === 'object' && result.output !== null ? result.output : {}),
        ...context,
        output: result.output,
      };

      try {
        let expr = step.transform.trim();
        if (expr.startsWith('${{') && expr.endsWith('}}')) {
          expr = expr.slice(3, -2).trim();
        }
        result.output = ExpressionEvaluator.evaluateExpression(expr, transformContext);
      } catch (error) {
        throw new Error(
          `Transform failed for step ${step.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  } catch (error) {
    if (error instanceof WorkflowSuspendedError) {
      return {
        output: null,
        status: 'suspended',
        error: error.message,
      };
    }
    if (error instanceof WorkflowWaitingError) {
      return {
        output: { wakeAt: error.wakeAt }, // Store wakeAt in output for getWakeAt helper
        status: 'waiting',
        error: error.message,
      };
    }
    return {
      output: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
