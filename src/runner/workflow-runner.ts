import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MemoryDb } from '../db/memory-db.ts';
import { type RunStatus, WorkflowDb } from '../db/workflow-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Step, Workflow, WorkflowStep } from '../parser/schema.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { StepStatus, type StepStatusType, WorkflowStatus } from '../types/status.ts';
import { ConfigLoader } from '../utils/config-loader.ts';
import { extractJson } from '../utils/json-parser.ts';
import { Redactor } from '../utils/redactor.ts';
import { formatSchemaErrors, validateJsonSchema } from '../utils/schema-validator.ts';
import { WorkflowRegistry } from '../utils/workflow-registry.ts';
import { ForeachExecutor } from './foreach-executor.ts';
import { type LLMMessage, getAdapter } from './llm-adapter.ts';
import { MCPManager } from './mcp-manager.ts';
import { withRetry } from './retry.ts';
import { type StepResult, WorkflowSuspendedError, executeStep } from './step-executor.ts';
import { withTimeout } from './timeout.ts';

import { ConsoleLogger, type Logger } from '../utils/logger.ts';

/**
 * A logger wrapper that redacts secrets from all log messages
 */
class RedactingLogger implements Logger {
  constructor(
    private inner: Logger,
    private redactor: Redactor
  ) {}

  log(msg: string): void {
    this.inner.log(this.redactor.redact(msg));
  }

  error(msg: string): void {
    this.inner.error(this.redactor.redact(msg));
  }

  warn(msg: string): void {
    this.inner.warn(this.redactor.redact(msg));
  }

  info(msg: string): void {
    this.inner.info(this.redactor.redact(msg));
  }

  debug(msg: string): void {
    if (this.inner.debug) {
      this.inner.debug(this.redactor.redact(msg));
    }
  }
}

class StepExecutionError extends Error {
  constructor(public readonly result: StepResult) {
    super(result.error || 'Step failed');
    this.name = 'StepExecutionError';
  }
}

export interface RunOptions {
  inputs?: Record<string, unknown>;
  dbPath?: string;
  memoryDbPath?: string;
  resumeRunId?: string;
  logger?: Logger;
  mcpManager?: MCPManager;
  preventExit?: boolean; // Defaults to false
  workflowDir?: string;
  resumeInputs?: Record<string, unknown>;
  dryRun?: boolean;
  debug?: boolean;
  getAdapter?: typeof getAdapter;
  depth?: number;
}

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
  private memoryDb: MemoryDb;
  private runId: string;
  private stepContexts: Map<string, StepContext | ForeachStepContext> = new Map();
  private inputs: Record<string, unknown>;
  private secrets: Record<string, string>;
  private redactor: Redactor;
  private rawLogger: Logger;
  private secretValues: string[] = [];
  private redactAtRest = true;
  private resumeRunId?: string;
  private restored = false;
  private logger: Logger;
  private mcpManager: MCPManager;
  private options: RunOptions;
  private signalHandler?: (signal: string) => void;
  private isStopping = false;
  private hasWarnedMemory = false;
  private static readonly MEMORY_WARNING_THRESHOLD = 1000;
  private static readonly MAX_RECURSION_DEPTH = 10;
  private static readonly REDACTED_PLACEHOLDER = '***REDACTED***';
  private depth = 0;
  private lastFailedStep?: { id: string; error: string };

  constructor(workflow: Workflow, options: RunOptions = {}) {
    this.workflow = workflow;
    this.options = options;
    this.depth = options.depth || 0;

    if (this.depth > WorkflowRunner.MAX_RECURSION_DEPTH) {
      throw new Error(
        `Maximum workflow recursion depth (${WorkflowRunner.MAX_RECURSION_DEPTH}) exceeded.`
      );
    }

    this.db = new WorkflowDb(options.dbPath);
    this.memoryDb = new MemoryDb(options.memoryDbPath);
    this.secrets = this.loadSecrets();
    this.redactor = new Redactor(this.secrets, { forcedSecrets: this.secretValues });
    // Wrap the logger with a redactor to prevent secret leakage in logs
    const rawLogger = options.logger || new ConsoleLogger();
    this.rawLogger = rawLogger;
    this.logger = new RedactingLogger(rawLogger, this.redactor);
    this.mcpManager = options.mcpManager || new MCPManager();

    if (options.resumeRunId) {
      // Resume existing run
      this.runId = options.resumeRunId;
      this.resumeRunId = options.resumeRunId;
      this.inputs = options.resumeInputs || {}; // Start with resume inputs, will be merged with DB inputs in restoreState
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
    const run = await this.db.getRun(this.runId);
    if (!run) {
      throw new Error(`Run ${this.runId} not found`);
    }

    // Only allow resuming failed, paused, or running (crash recovery) runs
    if (
      run.status !== WorkflowStatus.FAILED &&
      run.status !== WorkflowStatus.PAUSED &&
      run.status !== WorkflowStatus.RUNNING
    ) {
      throw new Error(
        `Cannot resume run with status '${run.status}'. Only 'failed', 'paused', or 'running' runs can be resumed.`
      );
    }

    if (run.status === WorkflowStatus.RUNNING) {
      this.logger.warn(
        `⚠️  Resuming a run marked as 'running'. This usually means the previous process crashed or was killed forcefully. Ensure no other instances are running.`
      );
    }

    // Restore inputs from the previous run to ensure consistency
    // Merge with any resumeInputs provided (e.g. answers to human steps)
    try {
      if (!run.inputs || run.inputs === 'null' || run.inputs === '') {
        this.logger.warn(`Run ${this.runId} has no persisted inputs`);
        // Keep existing inputs
      } else {
        const storedInputs = JSON.parse(run.inputs);
        this.inputs = { ...storedInputs, ...this.inputs };
      }
    } catch (error) {
      this.logger.error(
        `CRITICAL: Failed to parse inputs from run ${this.runId}. Data may be corrupted. Using default/resume inputs. Error: ${error instanceof Error ? error.message : String(error)}`
      );
      // Fallback: preserve existing inputs from resume options
    }

    // Load all step executions for this run
    const steps = await this.db.getStepsByRun(this.runId);

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

          if (exec.status === StepStatus.SUCCESS || exec.status === StepStatus.SKIPPED) {
            let output: unknown = null;
            try {
              output = exec.output ? JSON.parse(exec.output) : null;
            } catch (error) {
              this.logger.warn(
                `Failed to parse output for step ${stepId} iteration ${exec.iteration_index}: ${error}`
              );
              output = { error: 'Failed to parse output' };
            }
            items[exec.iteration_index] = {
              output,
              outputs:
                typeof output === 'object' && output !== null && !Array.isArray(output)
                  ? (output as Record<string, unknown>)
                  : {},
              status: exec.status as typeof StepStatus.SUCCESS | typeof StepStatus.SKIPPED,
              error: exec.error || undefined,
            };
            outputs[exec.iteration_index] = output;
          } else {
            allSuccess = false;
            // Still populate with placeholder if failed
            items[exec.iteration_index] = {
              output: null,
              outputs: {},
              status: exec.status as StepStatusType,
              error: exec.error || undefined,
            };
          }
        }

        // Use persisted foreach items from parent step for deterministic resume
        // This ensures the resume uses the same array as the initial run
        let expectedCount = -1;
        const parentExec = stepExecutions.find((e) => e.iteration_index === null);
        if (parentExec?.output) {
          try {
            const parsed = JSON.parse(parentExec.output);
            if (parsed.__foreachItems && Array.isArray(parsed.__foreachItems)) {
              expectedCount = parsed.__foreachItems.length;
            }
          } catch {
            // Parse error, fall through to expression evaluation
          }
        }

        // Fallback to expression evaluation if persisted items not found
        if (expectedCount === -1) {
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
        }

        // Check if we have all items (no gaps)
        const hasAllItems =
          expectedCount !== -1 &&
          items.length === expectedCount &&
          !Array.from({ length: expectedCount }).some((_, i) => !items[i]);

        // Determine overall status based on iterations
        let status: StepContext['status'] = StepStatus.SUCCESS;
        if (allSuccess && hasAllItems) {
          status = StepStatus.SUCCESS;
        } else if (items.some((item) => item?.status === StepStatus.SUSPENDED)) {
          status = StepStatus.SUSPENDED;
        } else {
          status = StepStatus.FAILED;
        }

        // Always restore what we have to allow partial expression evaluation
        const mappedOutputs = ForeachExecutor.aggregateOutputs(outputs);
        this.stepContexts.set(stepId, {
          output: outputs,
          outputs: mappedOutputs,
          status,
          items,
        } as ForeachStepContext);

        // Only mark as fully completed if all iterations completed successfully AND we have all items
        if (status === StepStatus.SUCCESS) {
          completedStepIds.add(stepId);
        }
      } else {
        // Single execution step
        const exec = stepExecutions[0];
        if (
          exec.status === StepStatus.SUCCESS ||
          exec.status === StepStatus.SKIPPED ||
          exec.status === StepStatus.SUSPENDED
        ) {
          let output: unknown = null;
          try {
            output = exec.output ? JSON.parse(exec.output) : null;
          } catch (error) {
            this.logger.warn(`Failed to parse output for step ${stepId}: ${error}`);
            output = { error: 'Failed to parse output' };
          }
          this.stepContexts.set(stepId, {
            output,
            outputs:
              typeof output === 'object' && output !== null && !Array.isArray(output)
                ? (output as Record<string, unknown>)
                : {},
            status: exec.status as StepContext['status'],
            error: exec.error || undefined,
          });
          if (exec.status !== StepStatus.SUSPENDED) {
            completedStepIds.add(stepId);
          }
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
      if (this.isStopping) return;
      this.logger.log(`\n\n🛑 Received ${signal}. Cleaning up...`);
      await this.stop(WorkflowStatus.FAILED, `Cancelled by user (${signal})`);

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
   * Stop the runner and cleanup resources
   */
  public async stop(status: RunStatus = WorkflowStatus.FAILED, error?: string): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;

    try {
      this.removeSignalHandlers();

      // Update run status in DB
      await this.db.updateRunStatus(
        this.runId,
        status,
        undefined,
        error ? this.redactForStorage(error) : undefined
      );

      // Stop all MCP clients
      await this.mcpManager.stopAll();

      this.db.close();
      this.memoryDb.close();
    } catch (err) {
      this.logger.error(`Error during stop/cleanup: ${err}`);
    }
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
      'DISPLAY',
      'SSH_AUTH_SOCK',
      'XPC_FLAGS',
      'XPC_SERVICE_NAME',
      'ITERM_SESSION_ID',
      'ITERM_PROFILE',
      'TERM_PROGRAM',
      'TERM_PROGRAM_VERSION',
      'COLORTERM',
      'LC_TERMINAL',
      'LC_TERMINAL_VERSION',
      'PWD',
      'OLDPWD',
      'HOME',
      'USER',
      'SHELL',
      'PATH',
      'LOGNAME',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_RUNTIME_DIR',
    ]);

    // Bun automatically loads .env file
    for (const [key, value] of Object.entries(Bun.env)) {
      if (value && !blocklist.has(key)) {
        secrets[key] = value;
      }
    }
    return secrets;
  }

  private refreshRedactor(): void {
    this.redactor = new Redactor(this.secrets, { forcedSecrets: this.secretValues });
    this.logger = new RedactingLogger(this.rawLogger, this.redactor);
  }

  private redactForStorage<T>(value: T): T {
    if (!this.redactAtRest) return value;
    return this.redactor.redactValue(value) as T;
  }

  private validateSchema(
    kind: 'input' | 'output',
    schema: unknown,
    data: unknown,
    stepId: string
  ): void {
    try {
      const result = validateJsonSchema(schema, data);
      if (result.valid) return;
      const details = formatSchemaErrors(result.errors)
        .map((line) => `  - ${line}`)
        .join('\n');
      throw new Error(
        `${kind === 'input' ? 'Input' : 'Output'} schema validation failed for step "${stepId}":\n${details}`
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('schema validation failed for step')) {
          throw error;
        }
        throw new Error(
          `${kind === 'input' ? 'Input' : 'Output'} schema error for step "${stepId}": ${error.message}`
        );
      }
      throw error;
    }
  }

  private buildStepInputs(step: Step, context: ExpressionContext): Record<string, unknown> {
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
            env[key] = ExpressionEvaluator.evaluateString(value, context);
          }
        }
        return stripUndefined({
          run: ExpressionEvaluator.evaluateString(step.run, context),
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
              ? ExpressionEvaluator.evaluateString(step.content, context)
              : undefined,
          op: step.op,
          allowOutsideCwd: step.allowOutsideCwd,
        });
      case 'request': {
        let headers: Record<string, string> | undefined;
        if (step.headers) {
          headers = {};
          for (const [key, value] of Object.entries(step.headers)) {
            headers[key] = ExpressionEvaluator.evaluateString(value, context);
          }
        }
        return stripUndefined({
          url: ExpressionEvaluator.evaluateString(step.url, context),
          method: step.method,
          headers,
          body: step.body ? ExpressionEvaluator.evaluateObject(step.body, context) : undefined,
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
          agent: step.agent,
          provider: step.provider,
          model: step.model,
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
      default:
        return {};
    }
  }

  /**
   * Apply workflow defaults to inputs and validate types
   */
  private applyDefaultsAndValidate(): void {
    if (!this.workflow.inputs) return;

    const secretValues = new Set<string>();

    for (const [key, config] of Object.entries(this.workflow.inputs)) {
      // Apply default if missing
      if (this.inputs[key] === undefined && config.default !== undefined) {
        this.inputs[key] = config.default;
      }

      if (config.secret) {
        if (this.inputs[key] === WorkflowRunner.REDACTED_PLACEHOLDER) {
          throw new Error(
            `Secret input "${key}" was redacted at rest. Please provide it again to resume this run.`
          );
        }
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
      if (
        type === 'object' &&
        (typeof value !== 'object' || value === null || Array.isArray(value))
      ) {
        throw new Error(`Input "${key}" must be an object, got ${typeof value}`);
      }

      if (config.values) {
        if (!['string', 'number', 'boolean'].includes(type)) {
          throw new Error(`Input "${key}" cannot use enum values with type "${type}"`);
        }
        for (const allowed of config.values) {
          if (typeof allowed !== type) {
            throw new Error(
              `Input "${key}" enum value ${JSON.stringify(allowed)} must be a ${type}`
            );
          }
        }
        if (!config.values.includes(value as string | number | boolean)) {
          throw new Error(
            `Input "${key}" must be one of: ${config.values.map((v) => JSON.stringify(v)).join(', ')}`
          );
        }
      }

      if (config.secret && value !== undefined && value !== WorkflowRunner.REDACTED_PLACEHOLDER) {
        if (typeof value === 'string') {
          secretValues.add(value);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          secretValues.add(String(value));
        }
      }
    }

    this.secretValues = Array.from(secretValues);
    this.refreshRedactor();
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
        error?: string;
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
          error: ctx.error,
          items: ctx.items,
        };
      } else {
        stepsContext[stepId] = {
          output: ctx.output,
          outputs: ctx.outputs,
          status: ctx.status,
          error: ctx.error,
        };
      }
    }

    const baseContext: ExpressionContext = {
      inputs: this.inputs,
      secrets: this.secrets,
      secretValues: this.secretValues,
      steps: stepsContext,
      item,
      index,
      env: {},
      output: item
        ? undefined
        : this.stepContexts.get(this.workflow.steps.find((s) => !s.foreach)?.id || '')?.output,
      last_failed_step: this.lastFailedStep,
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

    baseContext.env = resolvedEnv;
    return baseContext;
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
   * Retrieve past successful runs and format them as few-shot examples
   */
  private async getFewShotExamples(workflowName: string): Promise<string> {
    try {
      const runs = await this.db.getSuccessfulRuns(workflowName, 3);
      if (!runs || runs.length === 0) return '';

      let examples = 'Here are examples of how you successfully handled this task in the past:\n';

      for (const [index, run] of runs.entries()) {
        examples += `\nExample ${index + 1}:\n`;
        try {
          // Pretty print JSON inputs/outputs
          const inputs = JSON.stringify(JSON.parse(run.inputs), null, 2);
          const outputs = run.outputs ? JSON.stringify(JSON.parse(run.outputs), null, 2) : '{}';

          examples += `Input: ${inputs}\n`;
          examples += `Output: ${outputs}\n`;
        } catch (e) {
          // Fallback for raw strings if parsing fails
          examples += `Input: ${run.inputs}\n`;
          examples += `Output: ${run.outputs || '{}'}\n`;
        }
      }

      return examples;
    } catch (error) {
      this.logger.warn(`Failed to retrieve few-shot examples: ${error}`);
      return '';
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
    // Check idempotency key for dedup
    let idempotencyKey: string | undefined;
    if (step.idempotencyKey) {
      try {
        idempotencyKey = ExpressionEvaluator.evaluateString(step.idempotencyKey, context);
        if (idempotencyKey) {
          const existing = await this.db.getIdempotencyRecord(idempotencyKey);
          if (existing && existing.status === 'success') {
            this.logger.log(`  ⟳ Step ${step.id} skipped (idempotency hit: ${idempotencyKey})`);
            const output = existing.output ? JSON.parse(existing.output) : null;
            await this.db.completeStep(stepExecId, 'success', output, undefined);
            return {
              output,
              outputs:
                typeof output === 'object' && output !== null && !Array.isArray(output)
                  ? (output as Record<string, unknown>)
                  : {},
              status: 'success',
            };
          }
        }
      } catch (error) {
        this.logger.warn(
          `  ⚠️ Failed to evaluate idempotencyKey for ${step.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    let stepToExecute = step;

    // Inject few-shot examples if enabled
    if (step.type === 'llm' && step.learn) {
      const examples = await this.getFewShotExamples(this.workflow.name);
      if (examples) {
        stepToExecute = {
          ...step,
          prompt: `${examples}\n\n${step.prompt}`,
        };
        this.logger.log(
          `  🧠 Injected few-shot examples from ${examples.split('Example').length - 1} past runs`
        );
      }
    }

    const isRecursion =
      (context.reflexionAttempts as number) > 0 || (context.autoHealAttempts as number) > 0;

    if (!isRecursion) {
      await this.db.startStep(stepExecId);
    }

    const operation = async () => {
      const result = await executeStep(stepToExecute, context, this.logger, {
        executeWorkflowFn: this.executeSubWorkflow.bind(this),
        mcpManager: this.mcpManager,
        memoryDb: this.memoryDb,
        workflowDir: this.options.workflowDir,
        dryRun: this.options.dryRun,
      });
      if (result.status === 'failed') {
        throw new StepExecutionError(result);
      }
      if (result.status === 'success' && stepToExecute.outputSchema) {
        try {
          this.validateSchema(
            'output',
            stepToExecute.outputSchema,
            result.output,
            stepToExecute.id
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const outputRetries = stepToExecute.outputRetries || 0;
          const currentAttempt = (context.outputRepairAttempts as number) || 0;

          // Only attempt repair for LLM steps with outputRetries configured
          if (stepToExecute.type === 'llm' && outputRetries > 0 && currentAttempt < outputRetries) {
            const strategy = stepToExecute.repairStrategy || 'reask';
            this.logger.log(
              `  🔄 Output validation failed, attempting ${strategy} repair (${currentAttempt + 1}/${outputRetries})`
            );

            // Build repair context with validation errors
            const repairPrompt = this.buildOutputRepairPrompt(
              stepToExecute,
              result.output,
              message,
              strategy
            );

            // Create a modified step with repair context
            const repairStep = {
              ...stepToExecute,
              prompt: repairPrompt,
            };

            // Recursively execute with incremented repair attempt count
            const repairContext = {
              ...context,
              outputRepairAttempts: currentAttempt + 1,
            };

            // Execute the repair step
            const repairResult = await executeStep(repairStep, repairContext, this.logger, {
              executeWorkflowFn: this.executeSubWorkflow.bind(this),
              mcpManager: this.mcpManager,
              memoryDb: this.memoryDb,
              workflowDir: this.options.workflowDir,
              dryRun: this.options.dryRun,
            });

            if (repairResult.status === 'failed') {
              throw new StepExecutionError(repairResult);
            }

            // Validate the repaired output
            try {
              this.validateSchema(
                'output',
                stepToExecute.outputSchema,
                repairResult.output,
                stepToExecute.id
              );
              this.logger.log(
                `  ✓ Output repair successful after ${currentAttempt + 1} attempt(s)`
              );
              return repairResult;
            } catch (repairError) {
              // If still failing, either retry again or give up
              if (currentAttempt + 1 < outputRetries) {
                // Try again with updated context
                return operation();
              }
              const repairMessage =
                repairError instanceof Error ? repairError.message : String(repairError);
              throw new StepExecutionError({
                ...repairResult,
                status: 'failed',
                error: `Output validation failed after ${outputRetries} repair attempts: ${repairMessage}`,
              });
            }
          }

          throw new StepExecutionError({
            ...result,
            status: 'failed',
            error: message,
          });
        }
      }
      return result;
    };

    try {
      if (stepToExecute.inputSchema) {
        const inputsForValidation = this.buildStepInputs(stepToExecute, context);
        this.validateSchema(
          'input',
          stepToExecute.inputSchema,
          inputsForValidation,
          stepToExecute.id
        );
      }

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

      const persistedOutput = this.redactForStorage(result.output);
      const persistedError = result.error
        ? this.redactAtRest
          ? this.redactor.redact(result.error)
          : result.error
        : result.error;

      if (result.status === StepStatus.SUSPENDED) {
        await this.db.completeStep(
          stepExecId,
          StepStatus.SUSPENDED,
          persistedOutput,
          this.redactAtRest
            ? this.redactor.redact('Waiting for interaction')
            : 'Waiting for interaction',
          result.usage
        );
        return result;
      }

      await this.db.completeStep(
        stepExecId,
        result.status,
        persistedOutput,
        persistedError,
        result.usage
      );

      // Auto-Learning logic
      if (step.learn && result.status === StepStatus.SUCCESS) {
        try {
          await this.learnFromStep(step, result, context);
        } catch (error) {
          this.logger.warn(
            `  ⚠️ Failed to learn from step ${step.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

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

      // Store idempotency record for successful steps
      if (idempotencyKey && result.status === 'success') {
        try {
          await this.db.storeIdempotencyRecord(
            idempotencyKey,
            this.runId,
            step.id,
            'success',
            result.output,
            undefined,
            undefined // TTL in seconds (undefined = no expiry)
          );
        } catch (error) {
          this.logger.warn(
            `  ⚠️ Failed to store idempotency record for ${step.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      return {
        output: result.output,
        outputs,
        status: result.status,
        error: result.error,
        usage: result.usage,
      };
    } catch (error) {
      // Reflexion (Self-Correction) logic
      if (step.reflexion) {
        const { limit = 3, hint } = step.reflexion;
        const currentAttempt = (context.reflexionAttempts as number) || 0;

        if (currentAttempt < limit) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.log(
            `  🔧 Reflexion triggered for step ${step.id} (Attempt ${currentAttempt + 1}/${limit})`
          );

          try {
            // Get corrected command from Mechanic
            const fixedStep = await this.getFixFromReflexion(step, errorMsg, hint);

            // Merge fixed properties
            const newStep = { ...step, ...fixedStep };

            // Retry with new step definition
            const nextContext = {
              ...context,
              reflexionAttempts: currentAttempt + 1,
            };

            return this.executeStepInternal(newStep, nextContext, stepExecId);
          } catch (healError) {
            this.logger.error(
              `  ✗ Reflexion failed: ${healError instanceof Error ? healError.message : String(healError)}`
            );
            // Fall through to auto-heal or failure
          }
        }
      }

      // Auto-heal logic
      if (step.auto_heal && typeof step.auto_heal === 'object') {
        const autoHeal = step.auto_heal;
        // Limit recursion/loops
        const maxAttempts = autoHeal.maxAttempts || 1;
        const currentAttempt = (context.autoHealAttempts as number) || 0;

        if (currentAttempt < maxAttempts) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.log(
            `  🩹 Auto-healing triggered for step ${step.id} (Attempt ${currentAttempt + 1}/${maxAttempts})`
          );

          try {
            // Get fix from agent
            const fixedStep = await this.getFixFromAgent(step, errorMsg, context);

            // Merge fixed properties into the step
            const newStep = { ...step, ...fixedStep };

            // Retry with new step definition
            const nextContext = {
              ...context,
              autoHealAttempts: currentAttempt + 1,
            };

            return this.executeStepInternal(newStep, nextContext, stepExecId);
          } catch (healError) {
            this.logger.error(
              `  ✗ Auto-heal failed: ${healError instanceof Error ? healError.message : String(healError)}`
            );
            // Fall through to normal failure
          }
        }
      }

      // Debug REPL logic
      if (this.options.debug) {
        try {
          const { DebugRepl } = await import('./debug-repl.ts');
          const repl = new DebugRepl(context, step, error, this.logger);
          const action = await repl.start();

          if (action.type === 'retry') {
            this.logger.log(`  ↻ Retrying step ${step.id} after manual intervention`);
            // We use the modified step if provided, else original
            const stepToRun = action.modifiedStep || step;
            return this.executeStepInternal(stepToRun, context, stepExecId);
          }
          if (action.type === 'skip') {
            this.logger.log(`  ⏭️ Skipping step ${step.id} manually`);
            await this.db.completeStep(stepExecId, StepStatus.SKIPPED, null, undefined, undefined);
            return {
              output: null,
              outputs: {},
              status: StepStatus.SKIPPED,
            };
          }
          // if 'continue_failure', fall through
        } catch (replError) {
          this.logger.error(`  ✗ Debug REPL error: ${replError}`);
        }
      }

      const failureResult = error instanceof StepExecutionError ? error.result : null;
      const errorMsg =
        failureResult?.error || (error instanceof Error ? error.message : String(error));
      const redactedErrorMsg = this.redactor.redact(errorMsg);
      const failureOutput = failureResult?.output ?? null;
      const failureOutputs =
        typeof failureOutput === 'object' && failureOutput !== null && !Array.isArray(failureOutput)
          ? (failureOutput as Record<string, unknown>)
          : {};

      if (step.allowFailure) {
        this.logger.warn(
          `  ⚠️ Step ${step.id} failed but allowFailure is true: ${redactedErrorMsg}`
        );
        await this.db.completeStep(
          stepExecId,
          StepStatus.SUCCESS,
          this.redactForStorage(failureOutput),
          this.redactAtRest ? redactedErrorMsg : errorMsg
        );
        return {
          output: failureOutput,
          outputs: failureOutputs,
          status: StepStatus.SUCCESS,
          error: errorMsg,
        };
      }

      this.logger.error(`  ✗ Step ${step.id} failed: ${redactedErrorMsg}`);
      await this.db.completeStep(
        stepExecId,
        StepStatus.FAILED,
        this.redactForStorage(failureOutput),
        this.redactAtRest ? redactedErrorMsg : errorMsg
      );

      // Return failed context
      return {
        output: failureOutput,
        outputs: failureOutputs,
        status: StepStatus.FAILED,
        error: errorMsg,
      };
    }
  }

  /**
   * Consult an agent to fix a failing step
   */
  private async getFixFromAgent(
    step: Step,
    error: string,
    context: ExpressionContext
  ): Promise<Partial<Step>> {
    const { auto_heal } = step;
    if (!auto_heal) throw new Error('Auto-heal not configured');

    const prompt = `
The following step failed during execution:
\`\`\`json
${JSON.stringify(step, null, 2)}
\`\`\`

Error:
${error}

Please analyze the error and provide a fixed version of the step configuration.
Return ONLY a valid JSON object containing the fields that need to be changed.
For example, if the command was wrong, return:
{ "run": "correct command" }

Do not change the 'id' or 'type' or 'auto_heal' fields.
`;

    // Create a synthetic step to invoke the agent
    const agentStep: Step = {
      id: `${step.id}-healer`,
      type: 'llm',
      agent: auto_heal.agent,
      model: auto_heal.model,
      prompt,
      outputSchema: {
        type: 'object',
        description: 'Partial step configuration with fixed values',
        additionalProperties: true,
      },
    } as import('../parser/schema.ts').LlmStep;

    this.logger.log(`  🚑 Consulting agent ${auto_heal.agent} for a fix...`);

    // Execute the agent step
    // We use a fresh context but share secrets/env
    const result = await executeStep(agentStep, context, this.logger, {
      executeWorkflowFn: this.executeSubWorkflow.bind(this),
      mcpManager: this.mcpManager,
      memoryDb: this.memoryDb,
      workflowDir: this.options.workflowDir,
      dryRun: this.options.dryRun,
    });

    if (result.status !== 'success' || !result.output) {
      throw new Error(`Healer agent failed: ${result.error || 'No output'}`);
    }

    return result.output as Partial<Step>;
  }

  /**
   * Automatically learn from a successful step outcome
   */
  private async learnFromStep(
    step: Step,
    result: StepResult,
    _context: ExpressionContext
  ): Promise<void> {
    const getAdapterFn = this.options.getAdapter || getAdapter;
    const { adapter } = getAdapterFn('local'); // Default for embedding
    if (!adapter.embed) return;

    // Combine input context (if relevant) and output
    // For now, let's keep it simple: "Step: ID\nGoal: description\nOutput: result"

    // We can try to construct a summary of what happened
    let textToEmbed = `Step ID: ${step.id} (${step.type})\n`;

    if (step.type === 'llm') {
      // biome-ignore lint/suspicious/noExplicitAny: generic access
      textToEmbed += `Task Context/Prompt:\n${(step as any).prompt}\n\n`;
    } else if (step.type === 'shell') {
      // biome-ignore lint/suspicious/noExplicitAny: generic access
      textToEmbed += `Command:\n${(step as any).run}\n\n`;
    }

    textToEmbed += `Successful Outcome:\n${JSON.stringify(result.output, null, 2)}`;

    const embedding = await adapter.embed(textToEmbed, 'local');
    await this.memoryDb.store(textToEmbed, embedding, {
      stepId: step.id,
      workflow: this.workflow.name,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`  ✨ Learned from step ${step.id}`);
  }

  /**
   * Consult the built-in "Mechanic" agent to fix a failing step
   */
  private async getFixFromReflexion(
    step: Step,
    error: string,
    hint?: string
  ): Promise<Partial<Step>> {
    const systemPrompt = `You are the "Mechanic", an expert coding assistant built into the Keystone CLI.
Your job is to fix failing shell commands or scripts by analyzing the error output and the user's original intent.

Rules:
1. Analyze the failing command and the error message which comes from stdout/stderr.
2. If a "Hint" is provided, prioritize it as the primary strategy for the fix.
3. Return ONLY a valid JSON object containing the fields that need to be changed in the step configuration.
4. Do NOT verify the fix yourself; just provide the corrected configuration.
5. Common fixes include: 
   - Installing missing dependencies (e.g. pip install, npm install)
   - Fixing syntax errors
   - Creating missing directories
   - Adjusting flags or arguments`;

    // biome-ignore lint/suspicious/noExplicitAny: generic access
    const runCommand = (step as any).run;
    const userContent = `The following step failed:
\`\`\`json
${JSON.stringify({ type: step.type, run: runCommand }, null, 2)}
\`\`\`

Error Output:
${error}

${hint ? `Hint from User: "${hint}"` : ''}

Please provide the fixed step configuration as JSON.`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    try {
      // Use the default model (gpt-4o) or configured default for the Mechanic
      // We'll use gpt-4o as a strong default for this reasoning task
      const getAdapterFn = this.options.getAdapter || getAdapter;
      const { adapter, resolvedModel } = getAdapterFn('gpt-4o');
      this.logger.log(`  🤖 Mechanic is analyzing the failure using ${resolvedModel}...`);

      const response = await adapter.chat(messages, {
        model: resolvedModel,
      });

      const content = response.message.content;
      if (!content) {
        throw new Error('Mechanic returned empty response');
      }

      try {
        const fixedConfig = extractJson(content) as Partial<Step>;
        return fixedConfig;
      } catch (e) {
        throw new Error(`Failed to parse Mechanic's response as JSON: ${content}`);
      }
    } catch (err) {
      throw new Error(`Mechanic unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Build a repair prompt for output validation failures
   */
  private buildOutputRepairPrompt(
    step: Step,
    output: unknown,
    validationError: string,
    strategy: 'reask' | 'repair' | 'hybrid'
  ): string {
    const llmStep = step as import('../parser/schema.ts').LlmStep;
    const originalPrompt = llmStep.prompt;
    const outputSchema = step.outputSchema;

    const strategyInstructions = {
      reask: `Please try again, carefully following the output format requirements.`,
      repair: `Please fix the output to match the required schema. You may need to restructure, add missing fields, or correct data types.`,
      hybrid: `Please fix the output to match the required schema. If you cannot fix it, regenerate a completely new response.`,
    };

    return `${originalPrompt}

---

**OUTPUT REPAIR REQUIRED**

Your previous response failed validation. Here are the details:

**Your Previous Output:**
\`\`\`json
${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
\`\`\`

**Validation Error:**
${validationError}

**Required Output Schema:**
\`\`\`json
${JSON.stringify(outputSchema, null, 2)}
\`\`\`

${strategyInstructions[strategy]}

Please provide a corrected response that exactly matches the required schema.`;
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

    if (this.options.dryRun && step.type !== 'shell') {
      this.logger.log(`  ⊘ [DRY RUN] Skipping ${step.type} step ${step.id}`);
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);
      await this.db.completeStep(stepExecId, StepStatus.SKIPPED, null);
      this.stepContexts.set(step.id, { status: StepStatus.SKIPPED });
      return;
    }

    if (step.foreach) {
      const { ForeachExecutor } = await import('./foreach-executor.ts');
      const executor = new ForeachExecutor(
        this.db,
        this.logger,
        this.executeStepInternal.bind(this)
      );

      const existingContext = this.stepContexts.get(step.id) as ForeachStepContext;
      const result = await executor.execute(step, baseContext, this.runId, existingContext);

      this.stepContexts.set(step.id, result);
    } else {
      // Single execution
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);

      const result = await this.executeStepInternal(step, baseContext, stepExecId);

      // Update global state
      this.stepContexts.set(step.id, result);

      if (result.status === 'suspended') {
        const inputType = step.type === 'human' ? step.inputType : 'text';
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
      depth: this.depth + 1,
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

    const isResume = !!this.resumeRunId || this.stepContexts.size > 0;

    this.logger.log(`\n🏛️  ${isResume ? 'Resuming' : 'Running'} workflow: ${this.workflow.name}`);
    this.logger.log(`Run ID: ${this.runId}`);
    this.logger.log(
      '\n⚠️  Security Warning: Only run workflows from trusted sources.\n' +
        '   Workflows can execute arbitrary shell commands and access your environment.\n'
    );

    this.redactAtRest = ConfigLoader.load().storage?.redact_secrets_at_rest ?? true;

    // Apply defaults and validate inputs
    this.applyDefaultsAndValidate();

    // Create run record (only for new runs, not for resume)
    if (!isResume) {
      await this.db.createRun(this.runId, this.workflow.name, this.redactForStorage(this.inputs));
    }
    await this.db.updateRunStatus(this.runId, 'running');

    try {
      // Get execution order using topological sort
      const executionOrder = WorkflowParser.topologicalSort(this.workflow);
      const stepMap = new Map(this.workflow.steps.map((s) => [s.id, s]));

      // Initialize completedSteps with already completed steps (for resume)
      // Only include steps that were successful or skipped, so failed steps are retried
      const completedSteps = new Set<string>();
      for (const [id, ctx] of this.stepContexts.entries()) {
        if (ctx.status === 'success' || ctx.status === 'skipped') {
          completedSteps.add(id);
        }
      }

      // Filter out already completed steps from execution order
      const remainingSteps = executionOrder.filter((stepId) => !completedSteps.has(stepId));

      if (isResume && remainingSteps.length === 0) {
        this.logger.log('All steps already completed. Nothing to resume.\n');
        // Evaluate outputs from completed state
        const outputs = this.evaluateOutputs();
        await this.db.updateRunStatus(this.runId, 'success', this.redactForStorage(outputs));
        this.logger.log('✨ Workflow already completed!\n');
        return outputs;
      }

      if (isResume && completedSteps.size > 0) {
        this.logger.log(`Skipping ${completedSteps.size} already completed step(s)\n`);
      }

      this.logger.log(`Execution order: ${executionOrder.join(' → ')}\n`);

      const totalSteps = executionOrder.length;
      const stepIndices = new Map(executionOrder.map((id, index) => [id, index + 1]));

      // Evaluate global concurrency limit
      let globalConcurrencyLimit = remainingSteps.length;
      if (this.workflow.concurrency !== undefined) {
        const baseContext = this.buildContext();
        if (typeof this.workflow.concurrency === 'string') {
          globalConcurrencyLimit = Number(
            ExpressionEvaluator.evaluate(this.workflow.concurrency, baseContext)
          );
        } else {
          globalConcurrencyLimit = this.workflow.concurrency;
        }
      }
      if (!Number.isInteger(globalConcurrencyLimit) || globalConcurrencyLimit <= 0) {
        throw new Error(
          `workflow.concurrency must be a positive integer, got: ${globalConcurrencyLimit}`
        );
      }

      // Execute steps in parallel where possible (respecting dependencies and global concurrency)
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

            if (dependenciesMet && runningPromises.size < globalConcurrencyLimit) {
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
      await this.db.updateRunStatus(this.runId, 'success', this.redactForStorage(outputs));

      this.logger.log('✨ Workflow completed successfully!\n');

      return outputs;
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        await this.db.updateRunStatus(this.runId, 'paused');
        this.logger.log(`\n⏸  Workflow paused: ${error.message}`);
        throw error;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Find the failed step from stepContexts
      for (const [stepId, ctx] of this.stepContexts.entries()) {
        if (ctx.status === 'failed') {
          this.lastFailedStep = { id: stepId, error: ctx.error || errorMsg };
          break;
        }
      }

      // Run errors block if defined (before finally, after retries exhausted)
      await this.runErrors();

      this.logger.error(`\n✗ Workflow failed: ${errorMsg}\n`);
      await this.db.updateRunStatus(
        this.runId,
        'failed',
        undefined,
        this.redactAtRest ? this.redactor.redact(errorMsg) : errorMsg
      );
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
   * Execute the errors block if defined (runs after a step exhausts retries, before finally)
   */
  private async runErrors(): Promise<void> {
    if (!this.workflow.errors || this.workflow.errors.length === 0) {
      return;
    }

    if (!this.lastFailedStep) {
      this.logger.warn('Errors block defined but no failed step context available');
      return;
    }

    this.logger.log('\n🔧 Executing errors block...');

    const stepMap = new Map(this.workflow.errors.map((s) => [s.id, s]));
    const completedErrorsSteps = new Set<string>();
    const pendingErrorsSteps = new Set(this.workflow.errors.map((s) => s.id));
    const runningPromises = new Map<string, Promise<void>>();
    const totalErrorsSteps = this.workflow.errors.length;
    const errorsStepIndices = new Map(this.workflow.errors.map((s, index) => [s.id, index + 1]));

    try {
      while (pendingErrorsSteps.size > 0 || runningPromises.size > 0) {
        for (const stepId of pendingErrorsSteps) {
          const step = stepMap.get(stepId);
          if (!step) continue;

          // Dependencies can be from main steps (already in this.stepContexts) or previous errors steps
          const dependenciesMet = step.needs.every(
            (dep: string) => this.stepContexts.has(dep) || completedErrorsSteps.has(dep)
          );

          if (dependenciesMet) {
            pendingErrorsSteps.delete(stepId);

            const errorsStepIndex = errorsStepIndices.get(stepId);
            this.logger.log(
              `[${errorsStepIndex}/${totalErrorsSteps}] ▶ Executing errors step: ${step.id} (${step.type})`
            );
            const promise = this.executeStepWithForeach(step)
              .then(() => {
                completedErrorsSteps.add(stepId);
                runningPromises.delete(stepId);
                this.logger.log(
                  `[${errorsStepIndex}/${totalErrorsSteps}] ✓ Errors step ${step.id} completed\n`
                );
              })
              .catch((err) => {
                runningPromises.delete(stepId);
                this.logger.error(
                  `  ✗ Errors step ${step.id} failed: ${err instanceof Error ? err.message : String(err)}`
                );
                // We continue with other errors steps if possible
                completedErrorsSteps.add(stepId); // Mark as "done" (even if failed) so dependents can run
              });

            runningPromises.set(stepId, promise);
          }
        }

        if (runningPromises.size === 0 && pendingErrorsSteps.size > 0) {
          this.logger.error('Deadlock in errors block detected');
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
        `Error in errors block: ${error instanceof Error ? error.message : String(error)}`
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
