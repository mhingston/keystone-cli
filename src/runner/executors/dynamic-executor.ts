/**
 * Dynamic Step Executor
 *
 * Enables LLM-driven workflow orchestration where an agent generates
 * a sequence of steps at runtime that are then executed dynamically.
 */

import { DynamicStateManager } from '../../db/dynamic-state-manager.ts';
import type { WorkflowDb } from '../../db/workflow-db.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { DynamicStep, HumanStep, LlmStep, Step } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import { topologicalSort } from '../../utils/topo-sort.ts';
import type { WorkflowEvent } from '../events.ts';
import type { MCPManager } from '../mcp-manager.ts';
import type { DynamicPlan, DynamicStepState, GeneratedStep } from './dynamic-types.ts';
import { executeHumanStep } from './human-executor.ts';
import { executeLlmStep } from './llm-executor.ts';
import type { StepExecutorOptions, StepResult } from './types.ts';

/**
 * Schema for generated step definitions from the supervisor LLM
 */
export const DYNAMIC_STEP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    workflow_id: { type: 'string', description: 'Unique identifier for this workflow instance' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique step identifier' },
          name: { type: 'string', description: 'Human-readable step name' },
          type: {
            type: 'string',
            enum: ['llm', 'shell', 'workflow', 'file', 'request'],
            description: 'Step type to execute',
          },
          agent: { type: 'string', description: 'Agent to use for llm steps' },
          prompt: { type: 'string', description: 'Prompt for llm steps' },
          run: { type: 'string', description: 'Command for shell steps' },
          path: { type: 'string', description: 'Path for workflow/file steps' },
          op: {
            type: 'string',
            enum: ['read', 'write', 'append'],
            description: 'Operation for file steps',
          },
          content: { type: 'string', description: 'Content for file write/append' },
          needs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Step IDs this step depends on',
          },
          inputs: {
            type: 'object',
            additionalProperties: true,
            description: 'Inputs to pass to the step',
          },
          allowStepFailure: {
            type: 'boolean',
            description: 'Whether to continue if this specific step fails',
          },
        },
        required: ['id', 'name', 'type'],
      },
    },
    notes: { type: 'string', description: 'Any additional notes about the plan' },
  },
  required: ['steps'],
};

/**
 * Build a supervisor prompt from the step configuration
 */
function buildSupervisorPrompt(
  step: DynamicStep,
  context: ExpressionContext,
  failureContext?: string
): string {
  const goal = ExpressionEvaluator.evaluateString(step.goal, context);
  const contextText = step.context ? ExpressionEvaluator.evaluateString(step.context, context) : '';

  // Build template descriptions if provided
  let templateInfo = '';
  if (step.templates && Object.keys(step.templates).length > 0) {
    templateInfo = `\n\nAvailable specialized agents:\n${Object.entries(step.templates)
      .map(([role, agent]) => `- ${role}: ${agent}`)
      .join('\n')}`;
  }

  // Build library patterns if provided
  let libraryInfo = '';
  if (step.library && step.library.length > 0) {
    libraryInfo = `\n\nAvailable step patterns in your library:\n${step.library
      .map((p) => `- ${p.name}: ${p.description}`)
      .join(
        '\n'
      )}\n\nYou can use these patterns as inspiration or incorporate their logic into your plan.`;
  }

  return `You are a workflow supervisor. Your job is to break down a goal into executable steps
and delegate to specialized agents.

## Goal
${goal}

## Context
${contextText || 'None provided'}
${templateInfo}${libraryInfo}

## Instructions
1. Analyze the goal and determine what steps are needed
2. For each step, specify:
   - A unique id (lowercase, no spaces)
   - A descriptive name
   - The type (llm, shell, workflow, file, or request)
   - For llm steps: which agent and what prompt
   - For shell steps: what command to run
   - For file steps: path, op (read/write/append), and content (if write/append)
   - Dependencies on other steps (needs array)
   - allowStepFailure (optional boolean, default false)

3. Order steps logically - steps can run in parallel if they don't depend on each other. Specify 'needs' for strict sequencing.
4. Keep the plan minimal but complete.
${failureContext ? `\n5. **FAILURE RECOVERY**: Some steps failed in the previous attempt. Analyze the errors below and generate a plan to fix the issues:\n\n${failureContext}\n` : ''}

Return a JSON object with the steps array. Each step should be independently executable.`;
}

/**
 * Convert a generated step definition into an executable Step
 */
function convertToExecutableStep(generated: GeneratedStep, parentStepId: string): Step {
  const baseProps = {
    id: `${parentStepId}_${generated.id}`,
    needs: generated.needs?.map((n) => `${parentStepId}_${n}`) || [],
  };

  switch (generated.type) {
    case 'llm':
      return {
        ...baseProps,
        type: 'llm' as const,
        agent: generated.agent || 'software-engineer',
        prompt: generated.prompt || '',
        maxIterations: 10, // Default for generated LLM steps
      };

    case 'shell':
      return {
        ...baseProps,
        type: 'shell' as const,
        run: generated.run || 'echo "No command specified"',
      };

    case 'workflow':
      return {
        ...baseProps,
        type: 'workflow' as const,
        path: generated.path || '',
        inputs: generated.inputs as Record<string, string> | undefined,
      };

    case 'file':
      return {
        ...baseProps,
        type: 'file' as const,
        path: generated.path || '',
        op: generated.op || (generated.inputs?.op as 'read' | 'write' | 'append') || 'read',
        content: generated.content || (generated.inputs?.content as string),
      };

    case 'request':
      return {
        ...baseProps,
        type: 'request' as const,
        url: generated.path || '',
        method: 'GET' as const,
      };

    default:
      // Fallback to an echo shell step for unknown types
      return {
        ...baseProps,
        type: 'shell' as const,
        run: `echo "Unknown step type: ${generated.type}"`,
      };
  }
}

/**
 * Execute a dynamic step
 *
 * This is the core orchestrator that:
 * 1. Calls the supervisor LLM to generate a plan
 * 2. Converts the plan into executable steps
 * 3. Executes steps in dependency order
 * 4. Tracks state for resumability
 */
export async function executeDynamicStep(
  step: DynamicStep,
  context: ExpressionContext,
  executeStepFn: (step: Step, context: ExpressionContext, depth?: number) => Promise<StepResult>,
  logger: Logger,
  options: StepExecutorOptions & {
    stateManager?: DynamicStateManager;
    loadState?: (stepId: string) => Promise<DynamicStepState | null>;
    saveState?: (stepId: string, state: DynamicStepState) => Promise<void>;
    executeLlmStep?: typeof executeLlmStep;
    executeHumanStep?: typeof executeHumanStep;
    depth?: number;
  }
): Promise<StepResult> {
  const { runId, db, abortSignal } = options;
  const depth = options.depth || 0;

  // Prevent infinite recursion in dynamic steps
  // 10 is matching WorkflowRunner.MAX_RECURSION_DEPTH
  // We should ideally import this constant, but for now we hardcode or add to LIMITS
  if (depth > 10) {
    throw new Error('Maximum workflow recursion depth (10) exceeded in dynamic step.');
  }
  const stateManager = options.stateManager || (db ? new DynamicStateManager(db) : null);

  const { state, dbState } = await initializeState(step, runId, stateManager, options.loadState);
  const isResuming =
    state.status !== 'completed' &&
    state.status !== 'planning' &&
    state.generatedPlan.steps.length > 0;

  logger.log(`  🎯 Dynamic step: ${step.id} (${isResuming ? 'resuming' : 'starting'})`);

  try {
    while (state.status !== 'completed' && state.status !== 'failed') {
      if (abortSignal?.aborted) throw new Error('Dynamic step execution canceled');

      if (state.status === 'planning') {
        await handlePlanningPhase(
          step,
          context,
          state,
          dbState,
          stateManager,
          executeStepFn,
          logger,
          { ...options, depth }
        );
      }

      if (state.status === 'awaiting_confirmation') {
        await handleConfirmationPhase(step, context, state, dbState, stateManager, logger, options);
      }

      if (state.status === 'executing') {
        await handleExecutionPhase(
          step,
          context,
          state,
          dbState,
          stateManager,
          executeStepFn,
          logger,
          { ...options, depth }
        );
      }
    }

    return buildFinalResult(state);
  } catch (error) {
    // Re-throw suspension/waiting errors so the workflow can properly suspend
    if (error instanceof Error) {
      if (error.name === 'WorkflowSuspendedError' || error.name === 'WorkflowWaitingError') {
        throw error;
      }
    }
    return await handleExecutionError(step, state, dbState, stateManager, options.saveState, error);
  }
}

/**
 * Initialize state for dynamic step execution
 */
async function initializeState(
  step: DynamicStep,
  runId: string | undefined,
  stateManager: DynamicStateManager | null,
  loadState?: (stepId: string) => Promise<DynamicStepState | null>
): Promise<{ state: DynamicStepState; dbState: DynamicStepState | null }> {
  let state: DynamicStepState = {
    workflowId: runId || `dynamic-${Date.now()}`,
    generatedPlan: { steps: [] },
    stepResults: new Map(),
    currentStepIndex: 0,
    status: 'planning',
    startedAt: new Date().toISOString(),
    replanCount: 0,
  };

  let dbState: DynamicStepState | null = null;

  if (stateManager) {
    if (!runId) throw new Error('runId is required when using stateManager');
    dbState = await stateManager.load(runId, step.id);
    if (dbState?.id) {
      const stepResults = await stateManager.getStepResultsMap(dbState.id);
      state = {
        workflowId: dbState.workflowId || dbState.runId || runId || 'unknown',
        generatedPlan: dbState.generatedPlan,
        stepResults: new Map(
          Array.from(stepResults.entries()).map(([k, v]) => [k, v as StepResult])
        ),
        currentStepIndex: dbState.currentStepIndex,
        status: dbState.status as any,
        startedAt: dbState.startedAt,
        completedAt: dbState.completedAt,
        error: dbState.error,
        replanCount: dbState.replanCount || 0,
      };
    } else {
      dbState = await stateManager.create({ runId, stepId: step.id, workflowId: state.workflowId });
    }
  } else if (loadState) {
    const loaded = await loadState(step.id);
    if (loaded) state = loaded;
  }

  return { state, dbState };
}

/**
 * Phase 1: Planning
 */
async function handlePlanningPhase(
  step: DynamicStep,
  context: ExpressionContext,
  state: DynamicStepState,
  dbState: DynamicStepState | null,
  stateManager: DynamicStateManager | null,
  executeStepFn: (step: Step, context: ExpressionContext, depth?: number) => Promise<StepResult>,
  logger: Logger,
  options: StepExecutorOptions & {
    stateManager?: DynamicStateManager;
    saveState?: (stepId: string, state: DynamicStepState) => Promise<void>;
    executeLlmStep?: typeof executeLlmStep;
    depth?: number;
  }
) {
  const { runId, emitEvent, workflowName, abortSignal, mcpManager, workflowDir } = options;
  const runLlmStep = options.executeLlmStep || executeLlmStep;

  logger.log(
    state.replanCount > 0
      ? `  📋 Re-planning attempt ${state.replanCount}/${step.maxReplans}...`
      : '  📋 Generating execution plan...'
  );

  let failureContext = '';
  if (state.replanCount > 0) {
    failureContext = Array.from(state.stepResults.entries())
      .filter(([_, res]) => res.status === 'failed')
      .map(([id, res]) => `- Step "${id}" failed: ${res.error}`)
      .join('\n');
  }

  const supervisorPrompt = step.prompt
    ? ExpressionEvaluator.evaluateString(step.prompt, context)
    : buildSupervisorPrompt(step, context, failureContext);

  const llmStep: LlmStep = {
    id: `${step.id}_supervisor_${state.replanCount}`,
    type: 'llm',
    agent: step.supervisor || step.agent || 'keystone-architect',
    provider: step.provider,
    model: step.model,
    prompt: supervisorPrompt,
    outputSchema: step.outputSchema ?? DYNAMIC_STEP_OUTPUT_SCHEMA,
    maxIterations: step.maxIterations || 5,
    useStandardTools: false,
    needs: [],
  };

  const planResult = await runLlmStep(
    llmStep,
    context,
    executeStepFn,
    logger,
    mcpManager,
    workflowDir,
    abortSignal,
    emitEvent,
    workflowName && runId ? { runId, workflow: workflowName } : undefined
  );

  if (planResult.status !== 'success') {
    state.status = 'failed';
    state.error = planResult.error || 'Plan generation failed';
    if (stateManager && dbState && dbState.id)
      await stateManager.finish(dbState.id, 'failed', state.error);
    throw new Error(state.error);
  }

  state.generatedPlan = planResult.output as DynamicPlan;
  // Early validation of plan structure and dependencies
  try {
    topologicalSort(state.generatedPlan.steps);
  } catch (err) {
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
    if (stateManager && dbState && dbState.id)
      await stateManager.finish(dbState.id, 'failed', state.error);
    throw new Error(state.error);
  }

  state.status = step.confirmPlan ? 'awaiting_confirmation' : 'executing';

  logger.log(`  📋 Plan generated with ${state.generatedPlan.steps.length} steps:`);
  for (const s of state.generatedPlan.steps) {
    const deps = s.needs?.length ? ` (needs: ${s.needs.join(', ')})` : '';
    logger.log(`     - [${s.type}] ${s.name}${deps}`);
  }

  if (stateManager && dbState && dbState.id) {
    await stateManager.setPlan(dbState.id, state.generatedPlan, state.status);
  } else if (options.saveState) {
    await options.saveState(step.id, state);
  }
}

/**
 * Phase 1.5: Confirmation
 */
async function handleConfirmationPhase(
  step: DynamicStep,
  context: ExpressionContext,
  state: DynamicStepState,
  dbState: DynamicStepState | null,
  stateManager: DynamicStateManager | null,
  logger: Logger,
  options: StepExecutorOptions & {
    stateManager?: DynamicStateManager;
    saveState?: (stepId: string, state: DynamicStepState) => Promise<void>;
    executeHumanStep?: typeof executeHumanStep;
  }
) {
  const { abortSignal } = options;
  const planJson = JSON.stringify(state.generatedPlan, null, 2);
  const message = `Please review and confirm the generated plan:\n\n${planJson}\n\nType 'yes' to confirm or provide a modified JSON plan:`;

  const humanStep: HumanStep = {
    id: `${step.id}_confirm`,
    type: 'human',
    message,
    inputType: 'text',
    needs: [],
  };
  const confirmResult = await (options.executeHumanStep || executeHumanStep)(
    humanStep,
    context,
    logger,
    abortSignal
  );

  if (confirmResult.status === 'success') {
    const response = (confirmResult.output as string).trim().toLowerCase();
    if (response === 'yes' || response === 'y' || response === 'true' || response === '') {
      logger.log('  ✓ Plan confirmed');
    } else {
      try {
        const modifiedPlan = JSON.parse(response) as DynamicPlan;
        if (modifiedPlan.steps && Array.isArray(modifiedPlan.steps)) {
          // Validate modified plan
          topologicalSort(modifiedPlan.steps);
          state.generatedPlan = modifiedPlan;
          logger.log('  ✓ Using modified plan');
        }
      } catch (e) {
        logger.error(
          `  ⚠️ Invalid plan JSON. Proceeding with original. Error: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    state.status = 'executing';
    if (stateManager && dbState && dbState.id) {
      await stateManager.setPlan(dbState.id, state.generatedPlan, 'executing');
    } else if (options.saveState) {
      await options.saveState(step.id, state);
    }
  } else {
    state.status = 'failed';
    state.error = confirmResult.error || 'Confirmation failed';
    throw new Error(state.error);
  }
}

/**
 * Phase 2: Execution
 */
async function handleExecutionPhase(
  step: DynamicStep,
  context: ExpressionContext,
  state: DynamicStepState,
  dbState: DynamicStepState | null,
  stateManager: DynamicStateManager | null,
  executeStepFn: (step: Step, context: ExpressionContext, depth?: number) => Promise<StepResult>,
  logger: Logger,
  options: StepExecutorOptions & {
    stateManager?: DynamicStateManager;
    saveState?: (stepId: string, state: DynamicStepState) => Promise<void>;
    depth?: number;
  }
) {
  const { abortSignal, runId, workflowName, emitEvent, saveState, depth = 0 } = options;

  // Detect circular dependencies and validate plan
  topologicalSort(state.generatedPlan.steps);

  const currentStepIds = new Set(state.generatedPlan.steps.map((s) => s.id));
  const dynamicContext = {
    ...context,
    dynamic: {
      plan: state.generatedPlan,
      results: Object.fromEntries(
        Array.from(state.stepResults.entries()).filter(([id]) => currentStepIds.has(id))
      ),
    },
  } as ExpressionContext;

  const completed = new Set<string>();
  const running = new Set<string>();
  const failed = new Set<string>();
  const resultsMap = new Map<string, StepResult>();

  for (const [id, res] of state.stepResults.entries()) {
    if (!currentStepIds.has(id)) continue;
    resultsMap.set(id, res);
    if (res.status === 'success') completed.add(id);
    else if (res.status === 'failed') failed.add(id);
  }

  const maxConcurrency =
    typeof step.concurrency === 'number'
      ? step.concurrency
      : Number.parseInt(ExpressionEvaluator.evaluateString(step.concurrency as string, context)) ||
        1;
  logger.log(`  🚀 Starting parallel execution (concurrency: ${maxConcurrency})`);

  // Track running promises to avoid busy wait
  const executionPromises = new Set<Promise<void>>();

  while (completed.size + failed.size < state.generatedPlan.steps.length) {
    if (abortSignal?.aborted) throw new Error('Dynamic step execution canceled');

    const hasCriticalFailure = Array.from(failed).some((fid) => {
      const s = state.generatedPlan.steps.find((x) => x.id === fid);
      return !(s?.allowStepFailure ?? step.allowStepFailure ?? false);
    });
    if (hasCriticalFailure) break;

    const ready = state.generatedPlan.steps.filter(
      (s) =>
        !completed.has(s.id) &&
        !running.has(s.id) &&
        !failed.has(s.id) &&
        (s.needs || []).every((depId) => completed.has(depId))
    );

    if (ready.length === 0 && running.size === 0) {
      const uncompleted = state.generatedPlan.steps.filter(
        (s) => !completed.has(s.id) && !failed.has(s.id)
      );
      if (uncompleted.length > 0) {
        state.status = 'failed';
        state.error = `Dependency deadlock: ${uncompleted.length} steps remain but none are ready.`;
        break;
      }
      break;
    }

    // Helper to wrap execution with cleanup
    const executeWrapper = async (genStep: GeneratedStep, i: number) => {
      try {
        logger.log(
          `  ⚡ [${i + 1}/${state.generatedPlan.steps.length}] Executing step: ${genStep.name}`
        );

        const executableStep = convertToExecutableStep(genStep, step.id);
        const stepContext = {
          ...dynamicContext,
          steps: {
            ...(dynamicContext.steps || {}),
            ...Object.fromEntries(
              Array.from(resultsMap.entries()).map(([id, res]) => [
                `${step.id}_${id}`,
                { output: res.output },
              ])
            ),
          },
        } as ExpressionContext;

        if (emitEvent && runId && workflowName) {
          emitEvent({
            type: 'step.start',
            timestamp: new Date().toISOString(),
            runId,
            workflow: workflowName,
            stepId: executableStep.id,
            stepType: executableStep.type,
            phase: 'main',
            stepIndex: i + 1,
            totalSteps: state.generatedPlan.steps.length,
          });
        }

        const res = await executeStepFn(executableStep, stepContext, depth + 1);
        resultsMap.set(genStep.id, res);
        state.stepResults.set(genStep.id, res);

        if (stateManager && dbState && dbState.id) {
          await stateManager.completeStep(dbState.id, genStep.id, res);
          await stateManager.updateProgress(dbState.id, completed.size + failed.size + 1);
        } else if (saveState) {
          await saveState(step.id, state);
        }

        if (emitEvent && runId && workflowName) {
          emitEvent({
            type: 'step.end',
            timestamp: new Date().toISOString(),
            runId,
            workflow: workflowName,
            stepId: executableStep.id,
            stepType: executableStep.type,
            phase: 'main',
            status: res.status as any,
            stepIndex: i + 1,
            totalSteps: state.generatedPlan.steps.length,
          });
        }

        if (res.status === 'success') {
          completed.add(genStep.id);
        } else {
          failed.add(genStep.id);
          if (!(genStep.allowStepFailure ?? step.allowStepFailure ?? false)) {
            state.status = 'failed';
            state.error = `Step "${genStep.name}" failed: ${res.error}`;
          }
        }
      } catch (err) {
        const failRes: StepResult = { status: 'failed', error: String(err), output: {} };
        resultsMap.set(genStep.id, failRes);
        state.stepResults.set(genStep.id, failRes);
        failed.add(genStep.id);
        state.status = 'failed';
        state.error = `Step "${genStep.name}" crashed: ${err}`;
      } finally {
        running.delete(genStep.id);
      }
    };

    if (ready.length > 0 && running.size < maxConcurrency) {
      const toStart = ready.slice(0, maxConcurrency - running.size);
      for (const genStep of toStart) {
        running.add(genStep.id);
        const i = state.generatedPlan.steps.indexOf(genStep);
        const promise = executeWrapper(genStep, i).then(() => {
          executionPromises.delete(promise);
        });
        executionPromises.add(promise);
      }
    }

    // Wait for at least one task to complete before re-evaluating loop
    if (executionPromises.size > 0) {
      await Promise.race(executionPromises);
    }
  }

  const allSatisfied = Array.from(resultsMap.entries()).every(
    ([id, r]) =>
      r.status === 'success' ||
      (r.status === 'failed' &&
        (state.generatedPlan.steps.find((s) => s.id === id)?.allowStepFailure ??
          step.allowStepFailure ??
          false))
  );

  if (allSatisfied) {
    state.status = 'completed';
    state.error = undefined;
  } else if (state.replanCount < step.maxReplans) {
    logger.warn(
      `  ⚠️ Execution failed. Attempting self-correction (${state.replanCount + 1}/${step.maxReplans})...`
    );
    state.replanCount++;
    state.status = 'planning';
    state.error = undefined;
  } else {
    state.status = 'failed';
  }

  if (stateManager && dbState && dbState.id) {
    if (state.status === 'completed' || state.status === 'failed')
      await stateManager.finish(dbState.id, state.status, state.error);
    else await stateManager.updateStatus(dbState.id, state.status);
  } else if (saveState) {
    await saveState(step.id, state);
  }
}

/**
 * Handle errors during execution
 */
async function handleExecutionError(
  step: DynamicStep,
  state: DynamicStepState,
  dbState: DynamicStepState | null,
  stateManager: DynamicStateManager | null,
  saveState: ((stepId: string, state: DynamicStepState) => Promise<void>) | undefined,
  error: unknown
): Promise<StepResult> {
  state.status = 'failed';
  state.error = error instanceof Error ? error.message : String(error);
  if (stateManager && dbState && dbState.id) {
    await stateManager.finish(dbState.id, 'failed', state.error);
  } else if (saveState) {
    await saveState(step.id, state);
  }

  return {
    output: {
      plan: state.generatedPlan,
      results: Object.fromEntries(state.stepResults),
      replans: state.replanCount,
    },
    status: 'failed',
    error: state.error,
  };
}

/**
 * Build final result object
 */
function buildFinalResult(state: DynamicStepState): StepResult {
  const results = Object.fromEntries(state.stepResults);
  const summary = {
    total: state.generatedPlan.steps.length,
    succeeded: Array.from(state.stepResults.values()).filter((r) => r.status === 'success').length,
    failed: Array.from(state.stepResults.values()).filter((r) => r.status === 'failed').length,
    replans: state.replanCount,
  };

  return {
    output: { plan: state.generatedPlan, results, summary },
    status: state.status === 'completed' ? 'success' : 'failed',
    error: state.error,
  };
}
