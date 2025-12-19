import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { WorkflowDb } from '../db/workflow-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Step, Workflow, WorkflowStep } from '../parser/schema.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { Redactor } from '../utils/redactor.ts';
import { WorkflowRegistry } from '../utils/workflow-registry.ts';
import { MCPManager } from './mcp-manager.ts';
import { withRetry } from './retry.ts';
import { type StepResult, WorkflowSuspendedError, executeStep } from './step-executor.ts';
import { withTimeout } from './timeout.ts';

export interface Logger {
  log: (msg: string) => void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * A logger wrapper that redacts secrets from all log messages
 */
class RedactingLogger implements Logger {
  constructor(
    private inner: Logger,
    private redactor: Redactor
  ) { }

  log(msg: string): void {
    this.inner.log(this.redactor.redact(msg));
  }

  error(msg: string): void {
    this.inner.error(this.redactor.redact(msg));
  }

  warn(msg: string): void {
    this.inner.warn(this.redactor.redact(msg));
  }
}

export interface RunOptions {
  inputs?: Record<string, unknown>;
  dbPath?: string;
  resumeRunId?: string;
  logger?: Logger;
  mcpManager?: MCPManager;
  preventExit?: boolean; // Defaults to false
  workflowDir?: string;
}

export interface StepContext {
  output?: unknown;
  outputs?: Record<string, unknown>;
  status: 'success' | 'failed' | 'skipped' | 'pending' | 'suspended';
}

// Type for foreach results - wraps array to ensure JSON serialization preserves all properties
export interface ForeachStepContext extends StepContext {
  items: StepContext[]; // Individual iteration results
  // output and outputs inherited from StepContext
  // output: array of output values
  // outputs: mapped outputs object
}

/**
 * Main workflow execution engine
 */
export class WorkflowRunner {
  private workflow: Workflow;
  private db: WorkflowDb;
  private runId: string;
  private stepContexts: Map<string, StepContext | ForeachStepContext> = new Map();
  private inputs: Record<string, unknown>;
  private secrets: Record<string, string>;
  private redactor: Redactor;
  private resumeRunId?: string;
  private restored = false;
  private logger: Logger;
  private mcpManager: MCPManager;
  private options: RunOptions;
  private signalHandler?: (signal: string) => void;

  constructor(workflow: Workflow, options: RunOptions = {}) {
    this.workflow = workflow;
    this.options = options;
    this.db = new WorkflowDb(options.dbPath);
    this.secrets = this.loadSecrets();
    this.redactor = new Redactor(this.secrets);
    // Wrap the logger with a redactor to prevent secret leakage in logs
    const rawLogger = options.logger || console;
    this.logger = new RedactingLogger(rawLogger, this.redactor);
    this.mcpManager = options.mcpManager || new MCPManager();

    if (options.resumeRunId) {
      // Resume existing run
      this.runId = options.resumeRunId;
      this.resumeRunId = options.resumeRunId;
      this.inputs = {}; // Will be loaded from DB in restoreState
    } else {
      // Start new run
      this.inputs = options.inputs || {};
      this.runId = randomUUID();
    }

    this.setupSignalHandlers();
  }

  /**
   * Get the current run ID
   */
  public getRunId(): string {
    return this.runId;
  }

  /**
   * Restore state from a previous run (for resume functionality)
   */
  private async restoreState(): Promise<void> {
    const run = this.db.getRun(this.runId);
    if (!run) {
      throw new Error(`Run ${this.runId} not found`);
    }

    // Only allow resuming failed or paused runs
    if (run.status !== 'failed' && run.status !== 'paused') {
      throw new Error(
        `Cannot resume run with status '${run.status}'. Only 'failed' or 'paused' runs can be resumed.`
      );
    }

    // Restore inputs from the previous run to ensure consistency
    try {
      this.inputs = JSON.parse(run.inputs);
    } catch (error) {
      throw new Error(
        `Failed to parse inputs from run: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Load all step executions for this run
    const steps = this.db.getStepsByRun(this.runId);

    // Group steps by step_id to handle foreach loops (multiple executions per step_id)
    const stepExecutionsByStepId = new Map<string, typeof steps>();
    for (const step of steps) {
      if (!stepExecutionsByStepId.has(step.step_id)) {
        stepExecutionsByStepId.set(step.step_id, []);
      }
      stepExecutionsByStepId.get(step.step_id)?.push(step);
    }

    // Get topological order to ensure dependencies are restored before dependents
    const executionOrder = WorkflowParser.topologicalSort(this.workflow);
    const completedStepIds = new Set<string>();

    // Reconstruct step contexts in topological order
    for (const stepId of executionOrder) {
      const stepExecutions = stepExecutionsByStepId.get(stepId);
      if (!stepExecutions || stepExecutions.length === 0) continue;

      const stepDef = this.workflow.steps.find((s) => s.id === stepId);
      if (!stepDef) continue;

      const isForeach = !!stepDef.foreach;

      if (isForeach) {
        // Reconstruct foreach aggregated context
        const items: StepContext[] = [];
        const outputs: unknown[] = [];
        let allSuccess = true;

        // Sort by iteration_index to ensure correct order
        const sortedExecs = [...stepExecutions].sort(
          (a, b) => (a.iteration_index ?? 0) - (b.iteration_index ?? 0)
        );

        for (const exec of sortedExecs) {
          if (exec.iteration_index === null) continue; // Skip parent step record

          if (exec.status === 'success' || exec.status === 'skipped') {
            const output = exec.output ? JSON.parse(exec.output) : null;
            items[exec.iteration_index] = {
              output,
              outputs:
                typeof output === 'object' && output !== null && !Array.isArray(output)
                  ? (output as Record<string, unknown>)
                  : {},
              status: exec.status as 'success' | 'skipped',
            };
            outputs[exec.iteration_index] = output;
          } else {
            allSuccess = false;
            // Still populate with placeholder if failed
            items[exec.iteration_index] = {
              output: null,
              outputs: {},
              status: exec.status as 'failed' | 'pending' | 'success' | 'skipped' | 'suspended',
            };
          }
        }

        // We need to know the total expected items to decide if the whole step is complete
        // Evaluate the foreach expression again
        let expectedCount = -1;
        try {
          const baseContext = this.buildContext();
          const foreachExpr = stepDef.foreach;
          if (foreachExpr) {
            const foreachItems = ExpressionEvaluator.evaluate(foreachExpr, baseContext);
            if (Array.isArray(foreachItems)) {
              expectedCount = foreachItems.length;
            }
          }
        } catch (e) {
          // If we can't evaluate yet (dependencies not met?), we can't be sure it's complete
          allSuccess = false;
        }

        // Check if we have all items (no gaps)
        const hasAllItems =
          expectedCount !== -1 &&
          items.length === expectedCount &&
          !Array.from({ length: expectedCount }).some((_, i) => !items[i]);

        // Always restore what we have to allow partial expression evaluation
        const mappedOutputs = this.aggregateOutputs(outputs);
        this.stepContexts.set(stepId, {
          output: outputs,
          outputs: mappedOutputs,
          status: allSuccess && hasAllItems ? 'success' : 'failed',
          items,
        } as ForeachStepContext);

        // Only mark as fully completed if all iterations completed successfully AND we have all items
        if (allSuccess && hasAllItems) {
          completedStepIds.add(stepId);
        }
      } else {
        // Single execution step
        const exec = stepExecutions[0];
        if (exec.status === 'success' || exec.status === 'skipped') {
          const output = exec.output ? JSON.parse(exec.output) : null;
          this.stepContexts.set(stepId, {
            output,
            outputs:
              typeof output === 'object' && output !== null && !Array.isArray(output)
                ? (output as Record<string, unknown>)
                : {},
            status: exec.status as 'success' | 'skipped',
          });
          completedStepIds.add(stepId);
        }
      }
    }

    this.restored = true;
    this.logger.log(`✓ Restored state: ${completedStepIds.size} step(s) already completed`);
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handler = async (signal: string) => {
      this.logger.log(`\n\n🛑 Received ${signal}. Cleaning up...`);
      try {
        await this.db.updateRunStatus(
          this.runId,
          'failed',
          undefined,
          `Cancelled by user (${signal})`
        );
        this.logger.log('✓ Run status updated to failed');
      } catch (error) {
        this.logger.error('Error during cleanup:', error);
      }

      // Only exit if not embedded
      if (!this.options.preventExit) {
        process.exit(130);
      }
    };

    this.signalHandler = handler;

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  /**
   * Remove signal handlers
   */
  private removeSignalHandlers(): void {
    if (this.signalHandler) {
      process.removeListener('SIGINT', this.signalHandler);
      process.removeListener('SIGTERM', this.signalHandler);
    }
  }

  /**
   * Load secrets from environment
   */
  private loadSecrets(): Record<string, string> {
    const secrets: Record<string, string> = {};

    // Common non-secret environment variables to exclude from redaction
    const blocklist = new Set([
      'USER',
      'PATH',
      'SHELL',
      'HOME',
      'PWD',
      'LOGNAME',
      'LANG',
      'TERM',
      'EDITOR',
      'VISUAL',
      '_',
      'SHLVL',
      'LC_ALL',
      'OLDPWD',
      'DISPLAY',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'XPC_FLAGS',
      'XPC_SERVICE_NAME',
      'ITERM_SESSION_ID',
      'ITERM_PROFILE',
      'TERM_PROGRAM',
      'TERM_PROGRAM_VERSION',
      'COLORTERM',
    ]);

    // Bun automatically loads .env file
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value && !blocklist.has(key)) {
        secrets[key] = value;
      }
    }
    return secrets;
  }

  /**
   * Aggregate outputs from multiple iterations of a foreach step
   */
  private aggregateOutputs(outputs: unknown[]): Record<string, unknown> {
    const mappedOutputs: Record<string, unknown> = { length: outputs.length };
    const allKeys = new Set<string>();

    for (const output of outputs) {
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        for (const key of Object.keys(output)) {
          allKeys.add(key);
        }
      }
    }

    for (const key of allKeys) {
      mappedOutputs[key] = outputs.map((o) =>
        o && typeof o === 'object' && !Array.isArray(o) && key in (o as Record<string, unknown>)
          ? (o as Record<string, unknown>)[key]
          : null
      );
    }
    return mappedOutputs;
  }

  /**
   * Apply workflow defaults to inputs and validate types
   */
  private applyDefaultsAndValidate(): void {
    if (!this.workflow.inputs) return;

    for (const [key, config] of Object.entries(this.workflow.inputs)) {
      // Apply default if missing
      if (this.inputs[key] === undefined && config.default !== undefined) {
        this.inputs[key] = config.default;
      }

      // Validate required inputs
      if (this.inputs[key] === undefined) {
        throw new Error(`Missing required input: ${key}`);
      }

      // Basic type validation
      const value = this.inputs[key];
      const type = config.type.toLowerCase();

      if (type === 'string' && typeof value !== 'string') {
        throw new Error(`Input "${key}" must be a string, got ${typeof value}`);
      }
      if (type === 'number' && typeof value !== 'number') {
        throw new Error(`Input "${key}" must be a number, got ${typeof value}`);
      }
      if (type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Input "${key}" must be a boolean, got ${typeof value}`);
      }
      if (type === 'array' && !Array.isArray(value)) {
        throw new Error(`Input "${key}" must be an array, got ${typeof value}`);
      }
    }
  }

  /**
   * Build expression context for evaluation
   */
  private buildContext(item?: unknown, index?: number): ExpressionContext {
    const stepsContext: Record<
      string,
      {
        output?: unknown;
        outputs?: Record<string, unknown>;
        status?: string;
        items?: StepContext[];
      }
    > = {};

    for (const [stepId, ctx] of this.stepContexts.entries()) {
      // For foreach results, include items array for iteration access
      if ('items' in ctx && ctx.items) {
        stepsContext[stepId] = {
          output: ctx.output,
          outputs: ctx.outputs,
          status: ctx.status,
          items: ctx.items, // Allows ${{ steps.id.items[0] }} or ${{ steps.id.items.every(...) }}
        };
      } else {
        stepsContext[stepId] = {
          output: ctx.output,
          outputs: ctx.outputs,
          status: ctx.status,
        };
      }
    }

    return {
      inputs: this.inputs,
      secrets: this.secrets,
      steps: stepsContext,
      item,
      index,
      env: this.workflow.env,
    };
  }

  /**
   * Evaluate a conditional expression
   */
  private evaluateCondition(condition: string, context: ExpressionContext): boolean {
    const result = ExpressionEvaluator.evaluate(condition, context);
    return Boolean(result);
  }

  /**
   * Check if a step should be skipped based on its condition
   */
  private shouldSkipStep(step: Step, context: ExpressionContext): boolean {
    if (!step.if) return false;

    try {
      return !this.evaluateCondition(step.if, context);
    } catch (error) {
      this.logger.error(
        `Warning: Failed to evaluate condition for step ${step.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return true; // Skip on error
    }
  }

  /**
   * Execute a single step instance and return the result
   * Does NOT update global stepContexts
   */
  private async executeStepInternal(
    step: Step,
    context: ExpressionContext,
    stepExecId: string
  ): Promise<StepContext> {
    await this.db.startStep(stepExecId);

    const operation = async () => {
      const result = await executeStep(
        step,
        context,
        this.logger,
        this.executeSubWorkflow.bind(this),
        this.mcpManager,
        this.options.workflowDir
      );
      if (result.status === 'failed') {
        throw new Error(result.error || 'Step failed');
      }
      return result;
    };

    try {
      const operationWithTimeout = async () => {
        if (step.timeout) {
          return await withTimeout(operation(), step.timeout, `Step ${step.id}`);
        }
        return await operation();
      };

      const result = await withRetry(operationWithTimeout, step.retry, async (attempt, error) => {
        this.logger.log(`  ↻ Retry ${attempt}/${step.retry?.count} for step ${step.id}`);
        await this.db.incrementRetry(stepExecId);
      });

      if (result.status === 'suspended') {
        await this.db.completeStep(stepExecId, 'pending', null, 'Waiting for human input');
        return result;
      }

      await this.db.completeStep(stepExecId, result.status, result.output, result.error);

      // Ensure outputs is always an object for consistent access
      let outputs: Record<string, unknown>;
      if (
        typeof result.output === 'object' &&
        result.output !== null &&
        !Array.isArray(result.output)
      ) {
        outputs = result.output as Record<string, unknown>;
      } else {
        // For non-object outputs (strings, numbers, etc.), provide empty object
        // Users can still access the raw value via .output
        outputs = {};
      }

      return {
        output: result.output,
        outputs,
        status: result.status,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const redactedErrorMsg = this.redactor.redact(errorMsg);
      this.logger.error(`  ✗ Step ${step.id} failed: ${redactedErrorMsg}`);
      await this.db.completeStep(stepExecId, 'failed', null, redactedErrorMsg);

      // Return failed context
      return {
        output: null,
        outputs: {},
        status: 'failed',
      };
    }
  }

  /**
   * Execute a step (handles foreach if present)
   */
  private async executeStepWithForeach(step: Step): Promise<void> {
    const baseContext = this.buildContext();

    if (this.shouldSkipStep(step, baseContext)) {
      this.logger.log(`  ⊘ Skipping step ${step.id} (condition not met)`);
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);
      await this.db.completeStep(stepExecId, 'skipped', null);
      this.stepContexts.set(step.id, { status: 'skipped' });
      return;
    }

    if (step.foreach) {
      const items = ExpressionEvaluator.evaluate(step.foreach, baseContext);
      if (!Array.isArray(items)) {
        throw new Error(`foreach expression must evaluate to an array: ${step.foreach}`);
      }

      this.logger.log(`  ⤷ Executing step ${step.id} for ${items.length} items`);

      // Evaluate concurrency if it's an expression, otherwise use the number directly
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
        }
      }

      // Create parent step record in DB
      const parentStepExecId = randomUUID();
      await this.db.createStep(parentStepExecId, this.runId, step.id);
      await this.db.startStep(parentStepExecId);

      try {
        // Initialize results array with existing context or empty slots
        const existingContext = this.stepContexts.get(step.id) as ForeachStepContext;
        const itemResults: StepContext[] = existingContext?.items || new Array(items.length);

        // Ensure array is correct length if items changed (unlikely in resume but safe)
        if (itemResults.length !== items.length) {
          itemResults.length = items.length;
        }

        // Worker pool implementation for true concurrency
        let currentIndex = 0;
        let aborted = false;
        const workers = new Array(Math.min(concurrencyLimit, items.length))
          .fill(null)
          .map(async () => {
            while (currentIndex < items.length && !aborted) {
              const i = currentIndex++; // Capture index atomically
              const item = items[i];

              // Skip if already successful or skipped in previous run or by another worker
              if (
                itemResults[i] &&
                (itemResults[i].status === 'success' || itemResults[i].status === 'skipped')
              ) {
                continue;
              }

              const itemContext = this.buildContext(item, i);

              // Check DB again for robustness (in case itemResults wasn't fully restored)
              const existingExec = this.db.getStepByIteration(this.runId, step.id, i);
              if (
                existingExec &&
                (existingExec.status === 'success' || existingExec.status === 'skipped')
              ) {
                const output = existingExec.output ? JSON.parse(existingExec.output) : null;
                itemResults[i] = {
                  output,
                  outputs:
                    typeof output === 'object' && output !== null && !Array.isArray(output)
                      ? (output as Record<string, unknown>)
                      : {},
                  status: existingExec.status as 'success' | 'skipped',
                };
                continue;
              }

              const stepExecId = randomUUID();
              await this.db.createStep(stepExecId, this.runId, step.id, i);

              // Execute and store result at correct index
              try {
                this.logger.log(`  ⤷ [${i + 1}/${items.length}] Executing iteration...`);
                itemResults[i] = await this.executeStepInternal(step, itemContext, stepExecId);
                if (itemResults[i].status === 'failed') {
                  aborted = true;
                }
              } catch (error) {
                aborted = true;
                throw error;
              }
            }
          });

        await Promise.all(workers);

        // Aggregate results to match Spec requirements
        // This allows:
        // 1. ${{ steps.id.output }} -> array of output values
        // 2. ${{ steps.id.items[0].status }} -> 'success'
        // 3. ${{ steps.id.items.every(s => s.status == 'success') }} -> works via items array
        const outputs = itemResults.map((r) => r.output);
        const allSuccess = itemResults.every((r) => r.status === 'success');

        // Map child properties for easier access
        // If outputs are [{ id: 1 }, { id: 2 }], then outputs.id = [1, 2]
        const mappedOutputs = this.aggregateOutputs(outputs);

        // Use proper object structure that serializes correctly
        const aggregatedContext: ForeachStepContext = {
          output: outputs,
          outputs: mappedOutputs,
          status: allSuccess ? 'success' : 'failed',
          items: itemResults,
        };

        this.stepContexts.set(step.id, aggregatedContext);

        // Update parent step record with aggregated status
        await this.db.completeStep(
          parentStepExecId,
          allSuccess ? 'success' : 'failed',
          aggregatedContext,
          allSuccess ? undefined : 'One or more iterations failed'
        );

        if (!allSuccess) {
          throw new Error(`Step ${step.id} failed: one or more iterations failed`);
        }
      } catch (error) {
        // Mark parent step as failed
        const errorMsg = error instanceof Error ? error.message : String(error);
        await this.db.completeStep(parentStepExecId, 'failed', null, errorMsg);
        throw error;
      }
    } else {
      // Single execution
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);

      const result = await this.executeStepInternal(step, baseContext, stepExecId);

      // Update global state
      this.stepContexts.set(step.id, result);

      if (result.status === 'suspended') {
        const inputType = step.type === 'human' ? step.inputType : 'confirm';
        throw new WorkflowSuspendedError(result.error || 'Workflow suspended', step.id, inputType);
      }

      if (result.status === 'failed') {
        throw new Error(`Step ${step.id} failed`);
      }
    }
  }

  /**
   * Execute a sub-workflow step
   */
  private async executeSubWorkflow(
    step: WorkflowStep,
    context: ExpressionContext
  ): Promise<StepResult> {
    const workflowPath = WorkflowRegistry.resolvePath(step.path);
    const workflow = WorkflowParser.loadWorkflow(workflowPath);
    const subWorkflowDir = dirname(workflowPath);

    // Evaluate inputs for the sub-workflow
    const inputs: Record<string, unknown> = {};
    if (step.inputs) {
      for (const [key, value] of Object.entries(step.inputs)) {
        inputs[key] = ExpressionEvaluator.evaluate(value, context);
      }
    }

    // Create a new runner for the sub-workflow
    // We pass the same dbPath to share the state database
    const subRunner = new WorkflowRunner(workflow, {
      inputs,
      dbPath: this.db.dbPath,
      logger: this.logger,
      mcpManager: this.mcpManager,
      workflowDir: subWorkflowDir,
    });

    try {
      const output = await subRunner.run();
      return {
        output,
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

  /**
   * Redact secrets from a value
   */
  public redact<T>(value: T): T {
    return this.redactor.redactValue(value) as T;
  }

  /**
   * Execute the workflow
   */
  async run(): Promise<Record<string, unknown>> {
    // Handle resume state restoration
    if (this.resumeRunId && !this.restored) {
      await this.restoreState();
    }

    const isResume = this.stepContexts.size > 0;

    this.logger.log(`\n🏛️  ${isResume ? 'Resuming' : 'Running'} workflow: ${this.workflow.name}`);
    this.logger.log(`Run ID: ${this.runId}`);
    this.logger.log(
      '\n⚠️  Security Warning: Only run workflows from trusted sources.\n' +
      '   Workflows can execute arbitrary shell commands and access your environment.\n'
    );

    // Apply defaults and validate inputs
    this.applyDefaultsAndValidate();

    // Create run record (only for new runs, not for resume)
    if (!isResume) {
      await this.db.createRun(this.runId, this.workflow.name, this.inputs);
    }
    await this.db.updateRunStatus(this.runId, 'running');

    try {
      // Get execution order using topological sort
      const executionOrder = WorkflowParser.topologicalSort(this.workflow);
      const stepMap = new Map(this.workflow.steps.map((s) => [s.id, s]));

      // Initialize completedSteps with already completed steps (for resume)
      const completedSteps = new Set<string>(this.stepContexts.keys());

      // Filter out already completed steps from execution order
      const remainingSteps = executionOrder.filter((stepId) => !completedSteps.has(stepId));

      if (isResume && remainingSteps.length === 0) {
        this.logger.log('All steps already completed. Nothing to resume.\n');
        // Evaluate outputs from completed state
        const outputs = this.evaluateOutputs();
        await this.db.updateRunStatus(this.runId, 'completed', outputs);
        this.logger.log('✨ Workflow already completed!\n');
        return outputs;
      }

      if (isResume && completedSteps.size > 0) {
        this.logger.log(`Skipping ${completedSteps.size} already completed step(s)\n`);
      }

      this.logger.log(`Execution order: ${executionOrder.join(' → ')}\n`);

      const totalSteps = executionOrder.length;
      const stepIndices = new Map(executionOrder.map((id, index) => [id, index + 1]));

      // Execute steps in parallel where possible (respecting dependencies)
      const pendingSteps = new Set(remainingSteps);
      const runningPromises = new Map<string, Promise<void>>();

      try {
        while (pendingSteps.size > 0 || runningPromises.size > 0) {
          // 1. Find runnable steps (all dependencies met)
          for (const stepId of pendingSteps) {
            const step = stepMap.get(stepId);
            if (!step) {
              throw new Error(`Step ${stepId} not found in workflow`);
            }
            const dependenciesMet = step.needs.every((dep: string) => completedSteps.has(dep));

            if (dependenciesMet) {
              pendingSteps.delete(stepId);

              // Start execution
              const stepIndex = stepIndices.get(stepId);
              this.logger.log(
                `[${stepIndex}/${totalSteps}] ▶ Executing step: ${step.id} (${step.type})`
              );
              const promise = this.executeStepWithForeach(step)
                .then(() => {
                  completedSteps.add(stepId);
                  runningPromises.delete(stepId);
                  this.logger.log(`[${stepIndex}/${totalSteps}] ✓ Step ${step.id} completed\n`);
                })
                .catch((err) => {
                  runningPromises.delete(stepId);
                  throw err; // Fail fast
                });

              runningPromises.set(stepId, promise);
            }
          }

          // 2. Detect deadlock
          if (runningPromises.size === 0 && pendingSteps.size > 0) {
            const pendingList = Array.from(pendingSteps).join(', ');
            throw new Error(
              `Deadlock detected in workflow execution. Pending steps: ${pendingList}`
            );
          }

          // 3. Wait for at least one step to finish before checking again
          if (runningPromises.size > 0) {
            await Promise.race(runningPromises.values());
          }
        }
      } catch (error) {
        // Wait for other parallel steps to settle to avoid unhandled rejections
        if (runningPromises.size > 0) {
          await Promise.allSettled(runningPromises.values());
        }
        throw error;
      }

      // Evaluate outputs
      const outputs = this.evaluateOutputs();

      // Mark run as complete
      await this.db.updateRunStatus(this.runId, 'completed', outputs);

      this.logger.log('✨ Workflow completed successfully!\n');

      return outputs;
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        await this.db.updateRunStatus(this.runId, 'paused');
        this.logger.log(`\n⏸  Workflow paused: ${error.message}`);
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`\n✗ Workflow failed: ${errorMsg}\n`);
      await this.db.updateRunStatus(this.runId, 'failed', undefined, errorMsg);
      throw error;
    } finally {
      this.removeSignalHandlers();
      await this.runFinally();
      if (!this.options.mcpManager) {
        await this.mcpManager.stopAll();
      }
      this.db.close();
    }
  }

  /**
   * Execute the finally block if defined
   */
  private async runFinally(): Promise<void> {
    if (!this.workflow.finally || this.workflow.finally.length === 0) {
      return;
    }

    this.logger.log('\n🏁 Executing finally block...');

    const stepMap = new Map(this.workflow.finally.map((s) => [s.id, s]));
    const completedFinallySteps = new Set<string>();
    const pendingFinallySteps = new Set(this.workflow.finally.map((s) => s.id));
    const runningPromises = new Map<string, Promise<void>>();
    const totalFinallySteps = this.workflow.finally.length;
    const finallyStepIndices = new Map(this.workflow.finally.map((s, index) => [s.id, index + 1]));

    try {
      while (pendingFinallySteps.size > 0 || runningPromises.size > 0) {
        for (const stepId of pendingFinallySteps) {
          const step = stepMap.get(stepId);
          if (!step) continue;

          // Dependencies can be from main steps (already in this.stepContexts) or previous finally steps
          const dependenciesMet = step.needs.every(
            (dep: string) => this.stepContexts.has(dep) || completedFinallySteps.has(dep)
          );

          if (dependenciesMet) {
            pendingFinallySteps.delete(stepId);

            const finallyStepIndex = finallyStepIndices.get(stepId);
            this.logger.log(
              `[${finallyStepIndex}/${totalFinallySteps}] ▶ Executing finally step: ${step.id} (${step.type})`
            );
            const promise = this.executeStepWithForeach(step)
              .then(() => {
                completedFinallySteps.add(stepId);
                runningPromises.delete(stepId);
                this.logger.log(
                  `[${finallyStepIndex}/${totalFinallySteps}] ✓ Finally step ${step.id} completed\n`
                );
              })
              .catch((err) => {
                runningPromises.delete(stepId);
                this.logger.error(
                  `  ✗ Finally step ${step.id} failed: ${err instanceof Error ? err.message : String(err)}`
                );
                // We continue with other finally steps if possible
                completedFinallySteps.add(stepId); // Mark as "done" (even if failed) so dependents can run
              });

            runningPromises.set(stepId, promise);
          }
        }

        if (runningPromises.size === 0 && pendingFinallySteps.size > 0) {
          this.logger.error('Deadlock in finally block detected');
          break;
        }

        if (runningPromises.size > 0) {
          await Promise.race(runningPromises.values());
        }
      }
    } catch (error) {
      // Wait for other parallel steps to settle to avoid unhandled rejections
      if (runningPromises.size > 0) {
        await Promise.allSettled(runningPromises.values());
      }
      this.logger.error(
        `Error in finally block: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Evaluate workflow outputs
   */
  private evaluateOutputs(): Record<string, unknown> {
    if (!this.workflow.outputs) {
      return {};
    }

    const context = this.buildContext();
    const outputs: Record<string, unknown> = {};

    for (const [key, expression] of Object.entries(this.workflow.outputs)) {
      try {
        outputs[key] = ExpressionEvaluator.evaluate(expression, context);
      } catch (error) {
        this.logger.warn(
          `Warning: Failed to evaluate output "${key}": ${error instanceof Error ? error.message : String(error)}`
        );
        outputs[key] = null;
      }
    }

    return outputs;
  }
}
