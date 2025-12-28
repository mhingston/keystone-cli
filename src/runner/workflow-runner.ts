import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { ResourcePoolManager } from './resource-pool.ts';
import { withRetry } from './retry.ts';
import {
  type StepResult,
  WorkflowSuspendedError,
  WorkflowWaitingError,
  executeStep,
} from './step-executor.ts';
import { withTimeout } from './timeout.ts';
import { WorkflowState, type StepContext, type ForeachStepContext } from './workflow-state.ts';
import { WorkflowScheduler } from './workflow-scheduler.ts';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';
import { container } from '../utils/container.ts';
import type { EventHandler, StepPhase, WorkflowEvent } from './events.ts';

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

function getWakeAt(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const wakeAt = (output as { wakeAt?: unknown }).wakeAt;
  return typeof wakeAt === 'string' ? wakeAt : undefined;
}

export interface RunOptions {
  inputs?: Record<string, unknown>;
  secrets?: Record<string, string>;
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
  dedup?: boolean;
  getAdapter?: typeof getAdapter;
  executeStep?: typeof executeStep;
  depth?: number;
  allowSuccessResume?: boolean;
  resourcePoolManager?: ResourcePoolManager;
  allowInsecure?: boolean;
  artifactRoot?: string;
  db?: WorkflowDb;
  memoryDb?: MemoryDb;
  onEvent?: EventHandler;
  memoize?: boolean;
}

// Redacted StepContext and ForeachStepContext (moved to workflow-state.ts)

/**
 * Main workflow execution engine
 */
export class WorkflowRunner {
  private workflow: Workflow;
  private db: WorkflowDb;
  private memoryDb: MemoryDb;
  private _runId!: string;
  private state!: WorkflowState;
  private scheduler!: WorkflowScheduler;
  private inputs!: Record<string, unknown>;
  private secrets: Record<string, string>;
  private redactor: Redactor;
  private rawLogger!: Logger;
  private secretValues: string[] = [];
  private redactAtRest = true;
  private resumeRunId?: string;
  private logger!: Logger;
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
  private abortController = new AbortController();
  private resourcePool!: ResourcePoolManager;
  private restored = false;

  /**
   * Get the abort signal for cancellation checks
   */
  public get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if the workflow has been canceled
   */
  private get isCanceled(): boolean {
    return this.abortController.signal.aborted;
  }

  private createStepAbortController(): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const parentSignal = this.abortSignal;
    const onAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    if (parentSignal.aborted) {
      controller.abort();
      return { controller, cleanup: () => { } };
    }

    parentSignal.addEventListener('abort', onAbort, { once: true });
    return {
      controller,
      cleanup: () => parentSignal.removeEventListener('abort', onAbort),
    };
  }

  constructor(workflow: Workflow, options: RunOptions = {}) {
    this.workflow = workflow;
    this.options = options;
    this.depth = options.depth || 0;

    if (this.depth > WorkflowRunner.MAX_RECURSION_DEPTH) {
      throw new Error(
        `Maximum workflow recursion depth (${WorkflowRunner.MAX_RECURSION_DEPTH}) exceeded.`
      );
    }

    // Use injected instances or resolve from container or create new from paths
    this.db =
      options.db ||
      (options.dbPath ? new WorkflowDb(options.dbPath) : container.resolveOptional<WorkflowDb>('db')) ||
      new WorkflowDb(options.dbPath);

    this.memoryDb =
      options.memoryDb ||
      (options.memoryDbPath
        ? new MemoryDb(options.memoryDbPath)
        : container.resolveOptional<MemoryDb>('memoryDb')) ||
      new MemoryDb(options.memoryDbPath);

    this.secrets = this.loadSecrets();
    this.redactor = new Redactor(this.secrets, { forcedSecrets: this.secretValues });

    this.initLogger(options);
    this.initRun(options);
    this.mcpManager = options.mcpManager || new MCPManager();
    this.initResourcePool(options);

    this.setupSignalHandlers();
  }

  private initLogger(options: RunOptions): void {
    const rawLogger =
      options.logger || container.resolveOptional<Logger>('logger') || new ConsoleLogger();
    this.rawLogger = rawLogger;
    this.logger = new RedactingLogger(rawLogger, this.redactor);
  }

  private initResourcePool(options: RunOptions): void {
    if (options.resourcePoolManager) {
      this.resourcePool = options.resourcePoolManager;
    } else {
      const config = ConfigLoader.load();
      const globalPools = config.concurrency?.pools || {};
      const workflowPools: Record<string, number> = {};

      if (this.workflow.pools) {
        const baseContext = this.buildContext();
        for (const [name, limit] of Object.entries(this.workflow.pools)) {
          if (typeof limit === 'string') {
            workflowPools[name] = Number(ExpressionEvaluator.evaluate(limit, baseContext));
          } else {
            workflowPools[name] = limit;
          }
        }
      }

      this.resourcePool = new ResourcePoolManager(this.logger, {
        defaultLimit: config.concurrency?.default || 10,
        pools: { ...globalPools, ...workflowPools },
      });
    }
  }

  private initRun(options: RunOptions): void {
    if (options.resumeRunId) {
      this._runId = options.resumeRunId;
      this.resumeRunId = options.resumeRunId;
      this.inputs = options.resumeInputs || {};
    } else {
      this.inputs = options.inputs || {};
      this._runId = randomUUID();
    }

    this.state = new WorkflowState(
      this._runId,
      this.workflow,
      this.db,
      this.inputs,
      this.secrets,
      this.logger
    );
    this.scheduler = new WorkflowScheduler(this.workflow, this.state.getCompletedStepIds());
  }

  /**
   * Get the current run ID
   */
  public get runId(): string {
    return this._runId;
  }

  /**
   * Get the current run ID (method for mocking compatibility)
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

    if (
      run.status !== WorkflowStatus.FAILED &&
      run.status !== WorkflowStatus.PAUSED &&
      run.status !== WorkflowStatus.RUNNING &&
      run.status !== WorkflowStatus.CANCELED &&
      !(this.options.allowSuccessResume && run.status === WorkflowStatus.SUCCESS)
    ) {
      throw new Error(
        `Cannot resume run with status '${run.status}'. Only 'failed', 'paused', 'canceled', or 'running' runs can be resumed.`
      );
    }

    if (run.status === WorkflowStatus.RUNNING) {
      this.logger.warn(
        `⚠️  Resuming a run marked as 'running'. This usually means the previous process crashed or was killed forcefully.`
      );
    }

    if (run.status === WorkflowStatus.CANCELED) {
      this.logger.log('📋 Resuming a previously canceled run. Completed steps will be skipped.');
    }

    // Hydrate state from DB
    await this.state.restore();

    // Re-initialize scheduler with completed steps from restored state
    const completedSteps = new Set<string>();
    for (const [stepId, ctx] of this.state.entries()) {
      if (ctx.status === StepStatus.SUCCESS || ctx.status === StepStatus.SKIPPED) {
        completedSteps.add(stepId);
      }
    }
    this.scheduler = new WorkflowScheduler(this.workflow, completedSteps);

    this.restored = true;
    this.logger.log(`✓ Restored state: ${completedSteps.size} step(s) hydrated`);
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handler = async (signal: string) => {
      if (this.isStopping) return;
      this.logger.log(`\n\n🛑 Received ${signal}. Canceling workflow...`);
      // Signal cancellation to all running steps
      this.abortController.abort();
      await this.stop(WorkflowStatus.CANCELED, `Canceled by user (${signal})`);

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
   * Process compensations (rollback)
   */
  private async processCompensations(errorReason: string): Promise<void> {
    this.logger.log(`\n↩️  Initiating rollback due to: ${errorReason}`);

    try {
      // Get all pending compensations
      const compensations = await this.db.getPendingCompensations(this.runId);

      if (compensations.length === 0) {
        this.logger.log('  No pending compensations found.');
        return;
      }

      this.logger.log(`  Found ${compensations.length} compensation(s) to execute.`);

      // Execute in reverse order (LIFO) - already sorted by query
      for (const compRecord of compensations) {
        const stepDef = JSON.parse(compRecord.definition) as Step;
        this.logger.log(`  Running compensation: ${stepDef.id} (undoing ${compRecord.step_id})`);

        await this.db.updateCompensationStatus(compRecord.id, 'running');

        // Build context for compensation
        // It has access to the original step's output via steps.<step_id>.output
        const context = this.buildContext();

        try {
          // Execute the compensation step
          const result = await executeStep(stepDef, context, this.logger, {
            executeWorkflowFn: this.executeSubWorkflow.bind(this),
            mcpManager: this.mcpManager,
            db: this.db,
            memoryDb: this.memoryDb,
            workflowDir: this.options.workflowDir,
            dryRun: this.options.dryRun,
            runId: this.runId,
            artifactRoot: this.options.artifactRoot,
            redactForStorage: this.redactForStorage.bind(this),
          });

          if (result.status === 'success') {
            this.logger.log(`  ✓ Compensation ${stepDef.id} succeeded`);
            await this.db.updateCompensationStatus(compRecord.id, 'success', result.output);
          } else {
            this.logger.error(`  ✗ Compensation ${stepDef.id} failed: ${result.error}`);
            await this.db.updateCompensationStatus(
              compRecord.id,
              'failed',
              result.output,
              result.error
            );
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(`  ✗ Compensation ${stepDef.id} crashed: ${errMsg}`);
          await this.db.updateCompensationStatus(compRecord.id, 'failed', null, errMsg);
        }

        // 2. Recursive rollback for sub-workflows
        // Try to find if this step was a workflow step with a subRunId
        const stepExec = await this.db.getMainStep(this.runId, compRecord.step_id);
        const stepOutput = stepExec?.output;
        if (stepOutput) {
          try {
            const output = JSON.parse(stepOutput);
            const subRunId = output?.__subRunId;
            if (subRunId) {
              await this.cascadeRollback(subRunId, errorReason);
            }
          } catch (_e) {
            // ignore parse errors
          }
        }
      }

      this.logger.log('  Rollback completed.\n');
    } catch (error) {
      this.logger.error(
        `  ⚠️ Error during rollback processing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stop the runner and cleanup resources
   */
  public async stop(status: RunStatus = WorkflowStatus.FAILED, error?: string): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;

    try {
      this.removeSignalHandlers();

      // Trigger rollback if failing or canceled
      if (status === WorkflowStatus.FAILED || status === WorkflowStatus.CANCELED) {
        await this.processCompensations(error || status);
      }

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
    const secrets: Record<string, string> = { ...(this.options.secrets || {}) };

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
    this.redactor = new Redactor(this.loadSecrets(), { forcedSecrets: this.secretValues });
    this.logger = new RedactingLogger(this.rawLogger, this.redactor);
  }

  private redactForStorage<T>(value: T): T {
    if (!this.redactAtRest) return value;
    return this.redactor.redactValue(value) as T;
  }

  private async calculateStepCacheKey(
    step: Step,
    inputs: Record<string, unknown>
  ): Promise<string | null> {
    const memoizeEnabled = step.memoize ?? this.options.memoize ?? false;
    if (!memoizeEnabled) return null;

    // Only memoize deterministic steps by default unless explicitly requested
    const cacheableTypes = ['shell', 'file', 'script', 'request', 'engine', 'blueprint'];
    if (!cacheableTypes.includes(step.type) && step.memoize !== true) return null;

    const data = {
      type: step.type,
      run: (step as any).run,
      prompt: (step as any).prompt,
      agent: (step as any).agent,
      inputs,
      env: step.env,
      version: 1, // Cache versioning
    };

    // @ts-ignore - Bun.hash exists in Bun environment
    const hash = Bun.hash(JSON.stringify(data)).toString(16);
    return hash;
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
      const details = result.errors.map((line: string) => `  - ${line}`).join('\n');
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
            env[key] = ExpressionEvaluator.evaluateString(value as string, context);
          }
        }
        return stripUndefined({
          run: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').ShellStep).run,
            context
          ),
          dir: step.dir ? ExpressionEvaluator.evaluateString(step.dir, context) : undefined,
          env,
          allowInsecure: step.allowInsecure,
        });
      }
      case 'file':
        return stripUndefined({
          path: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').FileStep).path,
            context
          ),
          content:
            (step as import('../parser/schema.ts').FileStep).content !== undefined
              ? ExpressionEvaluator.evaluateString(
                (step as import('../parser/schema.ts').FileStep).content as string,
                context
              )
              : undefined,
          op: step.op,
          allowOutsideCwd: step.allowOutsideCwd,
        });
      case 'artifact':
        return stripUndefined({
          op: step.op,
          name: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').ArtifactStep).name,
            context
          ),
          paths: (step as import('../parser/schema.ts').ArtifactStep).paths?.map((p) =>
            ExpressionEvaluator.evaluateString(p, context)
          ),
          path: (step as import('../parser/schema.ts').ArtifactStep).path
            ? ExpressionEvaluator.evaluateString(
              (step as import('../parser/schema.ts').ArtifactStep).path as string,
              context
            )
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
          url: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').RequestStep).url,
            context
          ),
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
          message: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').HumanStep).message,
            context
          ),
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
          path: (step as import('../parser/schema.ts').WorkflowStep).path,
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
          command: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').EngineStep).command,
            context
          ),
          args: (step as import('../parser/schema.ts').EngineStep).args?.map((arg) =>
            ExpressionEvaluator.evaluateString(arg, context)
          ),
          input:
            (step as import('../parser/schema.ts').EngineStep).input !== undefined
              ? ExpressionEvaluator.evaluateObject(
                (step as import('../parser/schema.ts').EngineStep).input,
                context
              )
              : undefined,
          env,
          cwd: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').EngineStep).cwd,
            context
          ),
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
          event: ExpressionEvaluator.evaluateString(
            (step as import('../parser/schema.ts').WaitStep).event,
            context
          ),
          oneShot: (step as import('../parser/schema.ts').WaitStep).oneShot,
        });
      default:
        return {};
    }
  }

  /**
   * Collect primitive secret values from structured inputs.
   */
  private static collectSecretValues(
    value: unknown,
    sink: Set<string>,
    seen: WeakSet<object>
  ): void {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      sink.add(value);
      return;
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      sink.add(String(value));
      return;
    }

    if (typeof value !== 'object') return;

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        WorkflowRunner.collectSecretValues(item, sink, seen);
      }
      return;
    }

    for (const item of Object.values(value as Record<string, unknown>)) {
      WorkflowRunner.collectSecretValues(item, sink, seen);
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
        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
          throw new Error(`Input "${key}" cannot use enum values with type "${type}"`);
        }
        for (const allowed of config.values) {
          const matchesType =
            (type === 'string' && typeof allowed === 'string') ||
            (type === 'number' && typeof allowed === 'number') ||
            (type === 'boolean' && typeof allowed === 'boolean');
          if (!matchesType) {
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
        WorkflowRunner.collectSecretValues(value, secretValues, new WeakSet());
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

    for (const [stepId, ctx] of this.state.entries()) {
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
      secrets: this.loadSecrets(), // Access secrets from options
      secretValues: this.secretValues,
      steps: stepsContext,
      item,
      index,
      env: {},
      output: item
        ? undefined
        : this.state.get(this.workflow.steps.find((s) => !s.foreach)?.id || '')?.output,
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

  private async claimIdempotencyRecord(
    scopedKey: string,
    stepId: string,
    ttlSeconds?: number
  ): Promise<
    | { status: 'hit'; output: unknown; error?: string }
    | { status: 'claimed' }
    | { status: 'in-flight' }
  > {
    try {
      await this.db.clearExpiredIdempotencyRecord(scopedKey);

      const existing = await this.db.getIdempotencyRecord(scopedKey);
      if (existing) {
        if (existing.status === StepStatus.SUCCESS) {
          let output: unknown = null;
          try {
            output = existing.output ? JSON.parse(existing.output) : null;
          } catch (parseError) {
            this.logger.warn(
              `  ⚠️ Failed to parse idempotency output for ${stepId}: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            );
          }
          return { status: 'hit', output, error: existing.error || undefined };
        }
        if (existing.status === StepStatus.RUNNING) {
          return { status: 'in-flight' };
        }

        const claimed = await this.db.markIdempotencyRecordRunning(
          scopedKey,
          this.runId,
          stepId,
          ttlSeconds
        );
        if (claimed) {
          return { status: 'claimed' };
        }
      }

      const inserted = await this.db.insertIdempotencyRecordIfAbsent(
        scopedKey,
        this.runId,
        stepId,
        StepStatus.RUNNING,
        ttlSeconds
      );
      if (inserted) {
        return { status: 'claimed' };
      }

      const current = await this.db.getIdempotencyRecord(scopedKey);
      if (current?.status === StepStatus.SUCCESS) {
        let output: unknown = null;
        try {
          output = current.output ? JSON.parse(current.output) : null;
        } catch (parseError) {
          this.logger.warn(
            `  ⚠️ Failed to parse idempotency output for ${stepId}: ${parseError instanceof Error ? parseError.message : String(parseError)}`
          );
        }
        return { status: 'hit', output, error: current.error || undefined };
      }
      return { status: 'in-flight' };
    } catch (error) {
      this.logger.warn(
        `  ⚠️ Failed to claim idempotency key for ${stepId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return { status: 'claimed' };
    }
  }

  private async recordIdempotencyResult(
    scopedKey: string | undefined,
    stepId: string,
    status: StepStatusType,
    output: unknown,
    error?: string,
    ttlSeconds?: number
  ): Promise<void> {
    if (!scopedKey) return;
    try {
      await this.db.storeIdempotencyRecord(
        scopedKey,
        this.runId,
        stepId,
        status,
        output,
        error,
        ttlSeconds
      );
    } catch (err) {
      this.logger.warn(
        `  ⚠️ Failed to store idempotency record: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Execute a single step instance and return the result
   * Does NOT update global stepContexts
   */
  private async executeStepInternal(
    step: Step,
    context: ExpressionContext,
    stepExecId: string,
    idempotencyContext?: {
      rawKey: string;
      scopedKey: string;
      ttlSeconds?: number;
      claimed: boolean;
    }
  ): Promise<StepContext> {
    // Check idempotency key for dedup (scoped per run by default)
    const dedupEnabled = this.options.dedup !== false;
    let idempotencyKey: string | undefined = idempotencyContext?.rawKey;
    let scopedIdempotencyKey: string | undefined = idempotencyContext?.scopedKey;
    let idempotencyTtlSeconds: number | undefined = idempotencyContext?.ttlSeconds;
    let idempotencyClaimed = idempotencyContext?.claimed ?? false;
    if (dedupEnabled && !idempotencyClaimed && step.idempotencyKey) {
      try {
        idempotencyKey = ExpressionEvaluator.evaluateString(step.idempotencyKey, context);
      } catch (error) {
        this.logger.warn(
          `  ⚠️ Failed to evaluate idempotencyKey for ${step.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (idempotencyKey) {
        const scope = step.idempotencyScope || 'run';
        scopedIdempotencyKey = scope === 'run' ? `${this.runId}:${idempotencyKey}` : idempotencyKey;
        idempotencyTtlSeconds = step.idempotencyTtlSeconds;

        const claim = await this.claimIdempotencyRecord(
          scopedIdempotencyKey,
          step.id,
          idempotencyTtlSeconds
        );
        if (claim.status === 'hit') {
          this.logger.log(`  ⟳ Step ${step.id} skipped (idempotency hit: ${idempotencyKey})`);
          const output = claim.output;
          await this.db.completeStep(stepExecId, 'success', output, claim.error || undefined);
          return {
            output,
            outputs:
              typeof output === 'object' && output !== null && !Array.isArray(output)
                ? (output as Record<string, unknown>)
                : {},
            status: 'success',
            error: claim.error || undefined,
          };
        }
        if (claim.status === 'in-flight') {
          const errorMsg = `Idempotency key already in-flight: ${idempotencyKey}`;
          await this.db.completeStep(
            stepExecId,
            StepStatus.FAILED,
            null,
            this.redactAtRest ? this.redactor.redact(errorMsg) : errorMsg
          );
          return {
            output: null,
            outputs: {},
            status: StepStatus.FAILED,
            error: errorMsg,
          };
        }
        idempotencyClaimed = true;
      }
    }

    // Global step caching (memoization)
    const stepInputs = this.buildStepInputs(step, context);
    const cacheKey = await this.calculateStepCacheKey(step, stepInputs);
    if (cacheKey) {
      const cached = await this.db.getStepCache(cacheKey);
      if (cached) {
        this.logger.log(`  ⚡ Step ${step.id} skipped (global cache hit)`);
        const output = JSON.parse(cached.output);
        await this.db.completeStep(stepExecId, StepStatus.SUCCESS, output);
        return {
          output,
          outputs:
            typeof output === 'object' && output !== null && !Array.isArray(output)
              ? (output as Record<string, unknown>)
              : {},
          status: StepStatus.SUCCESS,
        };
      }
    }

    const idempotencyContextForRetry =
      idempotencyClaimed && scopedIdempotencyKey
        ? {
          rawKey: idempotencyKey || scopedIdempotencyKey,
          scopedKey: scopedIdempotencyKey,
          ttlSeconds: idempotencyTtlSeconds,
          claimed: true,
        }
        : undefined;

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

    if (stepToExecute.breakpoint && this.options.debug && !isRecursion) {
      if (!process.stdin.isTTY) {
        const message = `Breakpoint hit before step ${stepToExecute.id}`;
        if (dedupEnabled && idempotencyClaimed) {
          await this.recordIdempotencyResult(
            scopedIdempotencyKey,
            stepToExecute.id,
            StepStatus.SUSPENDED,
            null,
            message,
            idempotencyTtlSeconds
          );
        }
        await this.db.completeStep(
          stepExecId,
          StepStatus.SUSPENDED,
          null,
          this.redactAtRest ? this.redactor.redact(message) : message
        );
        return {
          output: null,
          outputs: {},
          status: StepStatus.SUSPENDED,
          error: message,
        };
      }

      try {
        const { DebugRepl } = await import('./debug-repl.ts');
        const repl = new DebugRepl(context, stepToExecute, undefined, this.logger, process.stdin, process.stdout, {
          mode: 'breakpoint',
        });
        const action = await repl.start();

        if (action.type === 'skip') {
          this.logger.log(`  ⏭️ Skipping step ${stepToExecute.id} at breakpoint`);
          await this.db.completeStep(
            stepExecId,
            StepStatus.SKIPPED,
            null,
            undefined,
            undefined
          );
          return {
            output: null,
            outputs: {},
            status: StepStatus.SKIPPED,
          };
        }

        if (action.type === 'continue' || action.type === 'retry') {
          stepToExecute = action.modifiedStep || stepToExecute;
        }
      } catch (replError) {
        this.logger.error(`  ✗ Debug REPL error: ${replError}`);
      }
    }

    const operation = async (attemptContext: ExpressionContext, abortSignal?: AbortSignal) => {
      const exec = this.options.executeStep || executeStep;
      const result = await exec(stepToExecute, attemptContext, this.logger, {
        executeWorkflowFn: this.executeSubWorkflow.bind(this),
        mcpManager: this.mcpManager,
        db: this.db,
        memoryDb: this.memoryDb,
        workflowDir: this.options.workflowDir,
        dryRun: this.options.dryRun,
        abortSignal,
        runId: this.runId,
        stepExecutionId: stepExecId,
        artifactRoot: this.options.artifactRoot,
        redactForStorage: this.redactForStorage.bind(this),
        getAdapter: this.options.getAdapter,
        executeStep: this.options.executeStep || executeStep,
      });
      if (result.status === 'failed') {
        throw new StepExecutionError(result);
      }
      if (result.status === 'success' && stepToExecute.outputSchema) {
        try {
          const outputForValidation =
            stepToExecute.type === 'engine' &&
              result.output &&
              typeof result.output === 'object' &&
              'summary' in result.output
              ? (result.output as { summary?: unknown }).summary
              : result.output;
          this.validateSchema(
            'output',
            stepToExecute.outputSchema,
            outputForValidation,
            stepToExecute.id
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const outputRetries = stepToExecute.outputRetries || 0;
          const currentAttempt = (attemptContext.outputRepairAttempts as number) || 0;

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
              ...attemptContext,
              outputRepairAttempts: currentAttempt + 1,
            };

            // Execute the repair step
            const exec = this.options.executeStep || executeStep;
            const repairResult = await exec(repairStep, repairContext, this.logger, {
              executeWorkflowFn: this.executeSubWorkflow.bind(this),
              mcpManager: this.mcpManager,
              db: this.db,
              memoryDb: this.memoryDb,
              workflowDir: this.options.workflowDir,
              dryRun: this.options.dryRun,
              abortSignal,
              runId: this.runId,
              stepExecutionId: stepExecId,
              artifactRoot: this.options.artifactRoot,
              redactForStorage: this.redactForStorage.bind(this),
              executeStep: this.options.executeStep || executeStep,
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
                return operation(
                  {
                    ...attemptContext,
                    outputRepairAttempts: currentAttempt + 1,
                  },
                  abortSignal
                );
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
        const { controller, cleanup } = this.createStepAbortController();
        try {
          const attempt = operation(context, controller.signal);
          if (step.timeout) {
            return await withTimeout(attempt, step.timeout, `Step ${step.id}`, {
              abortController: controller,
            });
          }
          return await attempt;
        } finally {
          cleanup();
        }
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
        if (step.type === 'human') {
          const existingTimer = await this.db.getTimerByStep(this.runId, step.id);
          if (!existingTimer) {
            const timerId = randomUUID();
            await this.db.createTimer(timerId, this.runId, step.id, 'human');
          }
        }
        if (dedupEnabled && idempotencyClaimed) {
          await this.recordIdempotencyResult(
            scopedIdempotencyKey,
            step.id,
            StepStatus.SUSPENDED,
            result.output,
            result.error,
            idempotencyTtlSeconds
          );
        }
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

      if (result.status === StepStatus.WAITING) {
        const wakeAt = getWakeAt(result.output);
        const waitError = `Waiting until ${wakeAt}`;
        // Avoid creating duplicate timers for the same step execution
        const existingTimer = await this.db.getTimerByStep(this.runId, step.id);
        if (!existingTimer) {
          const timerId = randomUUID();
          await this.db.createTimer(timerId, this.runId, step.id, 'sleep', wakeAt);
        }
        if (dedupEnabled && idempotencyClaimed) {
          await this.recordIdempotencyResult(
            scopedIdempotencyKey,
            step.id,
            StepStatus.WAITING,
            result.output,
            waitError,
            idempotencyTtlSeconds
          );
        }
        await this.db.completeStep(
          stepExecId,
          StepStatus.WAITING,
          persistedOutput,
          this.redactAtRest ? this.redactor.redact(waitError) : waitError,
          result.usage
        );
        result.error = waitError;
        return result;
      }

      await this.db.completeStep(
        stepExecId,
        result.status,
        persistedOutput,
        persistedError,
        result.usage
      );
      if (result.status === StepStatus.SUCCESS) {
        const existingTimer = await this.db.getTimerByStep(this.runId, step.id);
        if (existingTimer) {
          await this.db.completeTimer(existingTimer.id);
        }
      }

      // Register compensation if step succeeded and defines one
      if (result.status === StepStatus.SUCCESS && step.compensate) {
        try {
          // Ensure compensation step has an ID
          const compStep = {
            ...step.compensate,
            id: step.compensate.id || `${step.id}-compensate`,
          };
          const definition = JSON.stringify(compStep);
          const compensationId = randomUUID();

          this.logger.log(`  📎 Registering compensation for step ${step.id}`);
          await this.db.registerCompensation(
            compensationId,
            this.runId,
            step.id,
            compStep.id,
            definition
          );
        } catch (compError) {
          this.logger.warn(
            `  ⚠️ Failed to register compensation for step ${step.id}: ${compError instanceof Error ? compError.message : String(compError)}`
          );
        }
      }

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

      if (dedupEnabled && idempotencyClaimed) {
        await this.recordIdempotencyResult(
          scopedIdempotencyKey,
          step.id,
          result.status,
          result.output,
          result.error,
          idempotencyTtlSeconds
        );
      }

      const finalResult = {
        output: result.output,
        outputs,
        status: result.status,
        error: result.error,
        usage: result.usage,
      };

      // Store in global cache if enabled
      if (cacheKey && result.status === StepStatus.SUCCESS) {
        const ttl = step.memoizeTtlSeconds;
        await this.db.storeStepCache(cacheKey, this.workflow.name, step.id, persistedOutput, ttl);
      }

      return finalResult;
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

            return this.executeStepInternal(
              newStep,
              nextContext,
              stepExecId,
              idempotencyContextForRetry
            );
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

            return this.executeStepInternal(
              newStep,
              nextContext,
              stepExecId,
              idempotencyContextForRetry
            );
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
            return this.executeStepInternal(
              stepToRun,
              context,
              stepExecId,
              idempotencyContextForRetry
            );
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
        if (dedupEnabled && idempotencyClaimed) {
          await this.recordIdempotencyResult(
            scopedIdempotencyKey,
            step.id,
            StepStatus.SUCCESS,
            failureOutput,
            errorMsg,
            idempotencyTtlSeconds
          );
        }
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
      if (dedupEnabled && idempotencyClaimed) {
        await this.recordIdempotencyResult(
          scopedIdempotencyKey,
          step.id,
          StepStatus.FAILED,
          failureOutput,
          errorMsg,
          idempotencyTtlSeconds
        );
      }

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
    const exec = this.options.executeStep || executeStep;
    const result = await exec(agentStep, context, this.logger, {
      executeWorkflowFn: this.executeSubWorkflow.bind(this),
      mcpManager: this.mcpManager,
      memoryDb: this.memoryDb,
      workflowDir: this.options.workflowDir,
      dryRun: this.options.dryRun,
      debug: this.options.debug,
      runId: this.runId,
      artifactRoot: this.options.artifactRoot,
      redactForStorage: this.redactForStorage.bind(this),
      allowInsecure: this.options.allowInsecure,
      executeStep: this.options.executeStep || executeStep,
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
      reask: 'Please try again, carefully following the output format requirements.',
      repair:
        'Please fix the output to match the required schema. You may need to restructure, add missing fields, or correct data types.',
      hybrid:
        'Please fix the output to match the required schema. If you cannot fix it, regenerate a completely new response.',
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
      this.state.set(step.id, { status: 'skipped' });
      return;
    }

    if (this.options.dryRun && step.type !== 'shell') {
      this.logger.log(`  ⊘ [DRY RUN] Skipping ${step.type} step ${step.id}`);
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);
      await this.db.completeStep(stepExecId, StepStatus.SKIPPED, null);
      this.state.set(step.id, { status: StepStatus.SKIPPED });
      return;
    }

    if (step.foreach) {
      const { ForeachExecutor } = await import('./foreach-executor.ts');
      const executor = new ForeachExecutor(
        this.db,
        this.logger,
        this.executeStepInternal.bind(this),
        this.abortSignal,
        this.resourcePool
      );

      const existingContext = this.state.get(step.id) as ForeachStepContext;
      const result = await executor.execute(step, baseContext, this.runId, existingContext);

      this.state.set(step.id, result);
    } else {
      // Single execution
      const stepExecId = randomUUID();
      await this.db.createStep(stepExecId, this.runId, step.id);

      const result = await this.executeStepInternal(step, baseContext, stepExecId);

      // Update global state
      this.state.set(step.id, result);

      if (result.status === 'suspended') {
        const inputType = step.type === 'human' ? step.inputType : 'text';
        throw new WorkflowSuspendedError(result.error || 'Workflow suspended', step.id, inputType);
      }

      if (result.status === 'waiting') {
        const wakeAt = getWakeAt(result.output);
        throw new WorkflowWaitingError(result.error || `Waiting until ${wakeAt}`, step.id, wakeAt);
      }

      if (result.status === 'failed') {
        const suffix = result.error ? `: ${result.error}` : '';
        throw new Error(`Step ${step.id} failed${suffix}`);
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
    const workflowPath = WorkflowRegistry.resolvePath(step.path, this.options.workflowDir);
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
      dedup: this.options.dedup,
      artifactRoot: this.options.artifactRoot,
    });

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

  /**
   * Redact secrets from a value
   */
  public redact<T>(value: T): T {
    return this.redactor.redactValue(value) as T;
  }

  private emitEvent(event: WorkflowEvent): void {
    if (!this.options.onEvent) return;
    try {
      const redacted = this.redactor.redactValue(event) as WorkflowEvent;
      this.options.onEvent(redacted);
    } catch (error) {
      this.logger.warn(
        `  ⚠️ Failed to emit event: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private emitStepStart(
    step: Step,
    phase: StepPhase,
    stepIndex?: number,
    totalSteps?: number
  ): number {
    const startedAt = Date.now();
    this.emitEvent({
      type: 'step.start',
      timestamp: new Date(startedAt).toISOString(),
      runId: this.runId,
      workflow: this.workflow.name,
      stepId: step.id,
      stepType: step.type,
      phase,
      stepIndex,
      totalSteps,
    });
    return startedAt;
  }

  private emitStepEnd(
    step: Step,
    phase: StepPhase,
    startedAt: number,
    error?: unknown,
    stepIndex?: number,
    totalSteps?: number
  ): void {
    const endedAt = Date.now();
    const context = this.state.get(step.id);
    const status = context?.status || StepStatus.FAILED;
    const errorMsg =
      context?.error || (error instanceof Error ? error.message : error ? String(error) : undefined);

    this.emitEvent({
      type: 'step.end',
      timestamp: new Date(endedAt).toISOString(),
      runId: this.runId,
      workflow: this.workflow.name,
      stepId: step.id,
      stepType: step.type,
      phase,
      status,
      durationMs: endedAt - startedAt,
      error: status === StepStatus.SUCCESS || status === StepStatus.SKIPPED ? undefined : errorMsg,
      stepIndex,
      totalSteps,
    });
  }

  /**
   * Execute the workflow
   */
  async run(): Promise<Record<string, unknown>> {
    const expressionStrict = ConfigLoader.load().expression?.strict ?? false;
    ExpressionEvaluator.setStrictMode(expressionStrict);
    let completionEvent: WorkflowEvent | null = null;

    // Handle resume state restoration
    if (this.resumeRunId && !this.restored) {
      await this.restoreState();
    }

    const isResume = !!this.resumeRunId || this.state.size > 0;

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
    this.emitEvent({
      type: 'workflow.start',
      timestamp: new Date().toISOString(),
      runId: this.runId,
      workflow: this.workflow.name,
      inputs: this.redact(this.inputs),
    });

    try {
      // Use scheduler's execution order
      const executionOrder = this.scheduler.getExecutionOrder();

      if (isResume && this.scheduler.isComplete()) {
        this.logger.log('All steps already completed. Nothing to resume.\n');
        // Evaluate outputs from completed state
        const outputs = this.evaluateOutputs();
        await this.db.updateRunStatus(this.runId, 'success', this.redactForStorage(outputs));
        this.logger.log('✨ Workflow already completed!\n');
        completionEvent = {
          type: 'workflow.complete',
          timestamp: new Date().toISOString(),
          runId: this.runId,
          workflow: this.workflow.name,
          status: WorkflowStatus.SUCCESS,
          outputs: this.redact(outputs),
        };
        return outputs;
      }

      const pendingCount = this.scheduler.getPendingCount();
      const totalSteps = executionOrder.length;
      const completedCount = totalSteps - pendingCount;

      if (isResume && completedCount > 0) {
        this.logger.log(`Skipping ${completedCount} already completed step(s)\n`);
      }

      this.logger.log(`Execution order: ${executionOrder.join(' → ')}\n`);

      const stepIndices = new Map(executionOrder.map((id, index) => [id, index + 1]));

      // Evaluate global concurrency limit
      let globalConcurrencyLimit = pendingCount || 10;
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

      // Register top-level compensation if defined
      if (this.workflow.compensate) {
        await this.registerWorkflowCompensation();
      }

      // Execute steps in parallel where possible (respecting dependencies and global concurrency)
      const runningPromises = new Map<string, Promise<void>>();

      try {
        while (!this.scheduler.isComplete() || runningPromises.size > 0) {
          // Check for cancellation - drain in-flight steps but don't start new ones
          if (this.isCanceled) {
            if (runningPromises.size > 0) {
              this.logger.log(
                `⏳ Waiting for ${runningPromises.size} in-flight step(s) to complete...`
              );
              await Promise.allSettled(runningPromises.values());
            }
            throw new Error('Workflow canceled by user');
          }

          // 1. Find runnable steps from scheduler
          const runnableSteps = this.scheduler
            .getRunnableSteps(runningPromises.size, globalConcurrencyLimit)
            .filter((step) => this.resourcePool.hasCapacity(step.pool || step.type));

          for (const step of runnableSteps) {
            // Don't schedule new steps if canceled
            if (this.isCanceled) break;

            const stepId = step.id;
            this.scheduler.startStep(stepId);

            // Determine pool for this step
            const poolName = step.pool || step.type;

            // Start execution
            const stepIndex = stepIndices.get(stepId);

            const promise = (async () => {
              let release: (() => void) | undefined;
              const startedAt = this.emitStepStart(step, 'main', stepIndex, totalSteps);
              try {
                this.logger.debug?.(
                  `[${stepIndex}/${totalSteps}] ⏳ Waiting for pool: ${poolName}`
                );
                release = await this.resourcePool.acquire(poolName, { signal: this.abortSignal });

                this.logger.log(
                  `[${stepIndex}/${totalSteps}] ▶ Executing step: ${step.id} (${step.type})`
                );

                await this.executeStepWithForeach(step);
                this.emitStepEnd(step, 'main', startedAt, undefined, stepIndex, totalSteps);
                this.scheduler.markStepComplete(stepId);
                this.logger.log(`[${stepIndex}/${totalSteps}] ✓ Step ${step.id} completed\n`);
              } catch (error) {
                this.emitStepEnd(step, 'main', startedAt, error, stepIndex, totalSteps);
                throw error;
              } finally {
                if (typeof release === 'function') {
                  release();
                }
                runningPromises.delete(stepId);
              }
            })();

            runningPromises.set(stepId, promise);
          }

          // 2. Detect deadlock (only if not canceled)
          if (!this.isCanceled && runningPromises.size === 0 && !this.scheduler.isComplete()) {
            // Check if there are ANY steps whose dependencies are met, even if they're blocked by capacity/concurrency
            const readySteps = this.scheduler.getRunnableSteps(0, Number.MAX_SAFE_INTEGER);
            if (readySteps.length === 0) {
              throw new Error(
                `Deadlock detected in workflow execution. Steps remaining but none runnable (dependency cycles or missing inputs).`
              );
            }
          }

          // 3. Wait for at least one step to finish before checking again
          if (runningPromises.size > 0) {
            await Promise.race(runningPromises.values());
            // Yield to event loop to prevent tight loop if multiple steps finish in same tick
            await Bun.sleep(0);
          }
        }
      } catch (error) {
        // Wait for other parallel steps to settle to avoid unhandled rejections
        if (runningPromises.size > 0) {
          await Promise.allSettled(runningPromises.values());
        }

        const msg = error instanceof Error ? error.message : String(error);

        // Trigger rollback
        await this.processCompensations(msg);

        // Re-throw to be caught by the outer block (which calls stop)
        // Actually, the outer caller usually handles this.
        // But we want to ensure rollback happens BEFORE final status update if possible.
        throw error;
      }

      // Evaluate outputs
      const outputs = this.evaluateOutputs();

      // Mark run as complete
      await this.db.updateRunStatus(this.runId, 'success', this.redactForStorage(outputs));

      this.logger.log('✨ Workflow completed successfully!\n');

      completionEvent = {
        type: 'workflow.complete',
        timestamp: new Date().toISOString(),
        runId: this.runId,
        workflow: this.workflow.name,
        status: WorkflowStatus.SUCCESS,
        outputs: this.redact(outputs),
      };

      return outputs;
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        await this.db.updateRunStatus(this.runId, 'paused');
        this.logger.log(`\n⏸  Workflow paused: ${error.message}`);
        completionEvent = {
          type: 'workflow.complete',
          timestamp: new Date().toISOString(),
          runId: this.runId,
          workflow: this.workflow.name,
          status: WorkflowStatus.PAUSED,
          error: error.message,
        };
        throw error;
      }

      if (error instanceof WorkflowWaitingError) {
        await this.db.updateRunStatus(this.runId, 'paused');
        this.logger.log(`\n⏳ Workflow waiting: ${error.message}`);
        completionEvent = {
          type: 'workflow.complete',
          timestamp: new Date().toISOString(),
          runId: this.runId,
          workflow: this.workflow.name,
          status: WorkflowStatus.PAUSED,
          error: error.message,
        };
        throw error;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Find the failed step from stepContexts
      for (const [stepId, ctx] of this.state.entries()) {
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
      completionEvent = {
        type: 'workflow.complete',
        timestamp: new Date().toISOString(),
        runId: this.runId,
        workflow: this.workflow.name,
        status: WorkflowStatus.FAILED,
        error: errorMsg,
      };
      throw error;
    } finally {
      this.removeSignalHandlers();
      await this.runFinally();
      if (completionEvent) {
        this.emitEvent(completionEvent);
      }
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

          // Dependencies can be from main steps (already in this.state) or previous finally steps
          const dependenciesMet = step.needs.every(
            (dep: string) => this.state.has(dep) || completedFinallySteps.has(dep)
          );

          if (dependenciesMet) {
            pendingFinallySteps.delete(stepId);

            const finallyStepIndex = finallyStepIndices.get(stepId);
            this.logger.log(
              `[${finallyStepIndex}/${totalFinallySteps}] ▶ Executing finally step: ${step.id} (${step.type})`
            );
            const startedAt = this.emitStepStart(
              step,
              'finally',
              finallyStepIndex,
              totalFinallySteps
            );
            const promise = this.executeStepWithForeach(step)
              .then(() => {
                this.emitStepEnd(
                  step,
                  'finally',
                  startedAt,
                  undefined,
                  finallyStepIndex,
                  totalFinallySteps
                );
                completedFinallySteps.add(stepId);
                runningPromises.delete(stepId);
                this.logger.log(
                  `[${finallyStepIndex}/${totalFinallySteps}] ✓ Finally step ${step.id} completed\n`
                );
              })
              .catch((err) => {
                this.emitStepEnd(
                  step,
                  'finally',
                  startedAt,
                  err,
                  finallyStepIndex,
                  totalFinallySteps
                );
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
          await Bun.sleep(0);
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

          // Dependencies can be from main steps (already in this.state) or previous errors steps
          const dependenciesMet = step.needs.every(
            (dep: string) => this.state.has(dep) || completedErrorsSteps.has(dep)
          );

          if (dependenciesMet) {
            pendingErrorsSteps.delete(stepId);

            const errorsStepIndex = errorsStepIndices.get(stepId);
            this.logger.log(
              `[${errorsStepIndex}/${totalErrorsSteps}] ▶ Executing errors step: ${step.id} (${step.type})`
            );
            const startedAt = this.emitStepStart(
              step,
              'errors',
              errorsStepIndex,
              totalErrorsSteps
            );
            const promise = this.executeStepWithForeach(step)
              .then(() => {
                this.emitStepEnd(
                  step,
                  'errors',
                  startedAt,
                  undefined,
                  errorsStepIndex,
                  totalErrorsSteps
                );
                completedErrorsSteps.add(stepId);
                runningPromises.delete(stepId);
                this.logger.log(
                  `[${errorsStepIndex}/${totalErrorsSteps}] ✓ Errors step ${step.id} completed\n`
                );
              })
              .catch((err) => {
                this.emitStepEnd(
                  step,
                  'errors',
                  startedAt,
                  err,
                  errorsStepIndex,
                  totalErrorsSteps
                );
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
          await Bun.sleep(0);
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
    const context = this.buildContext();
    const outputs: Record<string, unknown> = {};

    if (this.workflow.outputs) {
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
    }

    // Validate outputs against schema if provided
    if (this.workflow.outputSchema) {
      try {
        this.validateSchema('output', this.workflow.outputSchema, outputs, 'workflow');
      } catch (error) {
        throw new Error(
          `Workflow output validation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return outputs;
  }

  /**
   * Check if a join condition is met based on completed dependencies
   */
  private isJoinConditionMet(
    step: import('../parser/schema.ts').JoinStep,
    completedSteps: Set<string>
  ): boolean {
    const total = step.needs.length;
    if (total === 0) return true;

    // Count successful/skipped dependencies
    const successCount = step.needs.filter((dep) => completedSteps.has(dep)).length;

    // Find failed/suspended dependencies (that we've already tried)
    // If some dependencies failed (and didn't allowFailure), the whole workflow would usually fail.
    // If allowFailure was true, they are in completedSteps.
    // So completedSteps effectively represents "done successfully".

    if (step.condition === 'all') {
      return successCount === total;
    }
    if (step.condition === 'any') {
      // Met if at least one succeeded, OR if all finished and none succeeded?
      // Actually strictly "any" means at least one success.
      return successCount > 0;
    }
    if (typeof step.condition === 'number') {
      return successCount >= step.condition;
    }

    return successCount === total;
  }

  /**
   * Register top-level compensation for the workflow
   */
  private async registerWorkflowCompensation(): Promise<void> {
    if (!this.workflow.compensate) return;

    // Check if already registered (for resume)
    const existing = await this.db.getAllCompensations(this.runId);
    if (existing.some((c) => c.step_id === 'workflow')) return;

    const compStep = {
      ...this.workflow.compensate,
      id: this.workflow.compensate.id || `${this.workflow.name}-compensate`,
    };
    const definition = JSON.stringify(compStep);
    const compensationId = randomUUID();

    this.logger.log(`  📎 Registering top-level compensation for workflow ${this.workflow.name}`);
    await this.db.registerCompensation(
      compensationId,
      this.runId,
      'workflow', // use 'workflow' as step_id marker
      compStep.id,
      definition
    );
  }

  /**
   * Cascade rollback to a child sub-workflow
   */
  private async cascadeRollback(subRunId: string, errorReason: string): Promise<void> {
    this.logger.log(`  📂 Cascading rollback to sub-workflow: ${subRunId}`);
    try {
      const runRecord = await this.db.getRun(subRunId);
      if (!runRecord) {
        this.logger.warn(`  ⚠️ Could not find run record for sub-workflow ${subRunId}`);
        return;
      }

      const workflowPath = WorkflowRegistry.resolvePath(
        runRecord.workflow_name,
        this.options.workflowDir
      );
      const workflow = WorkflowParser.loadWorkflow(workflowPath);

      const subRunner = new WorkflowRunner(workflow, {
        resumeRunId: subRunId,
        dbPath: this.db.dbPath,
        logger: this.logger,
        mcpManager: this.mcpManager,
        workflowDir: dirname(workflowPath),
        depth: this.depth + 1,
        allowSuccessResume: true, // Internal workflows might need this
        resourcePoolManager: this.resourcePool,
        allowInsecure: this.options.allowInsecure,
      });

      // Restore sub-workflow state
      await subRunner.restoreState();

      // Trigger its compensations
      // We call the private method directly since we're in the same class (different instance)
      // but TypeScript might complain if it's strictly private.
      // Actually, in TS, private is accessible by other instances of the same class.
      await subRunner.processCompensations(errorReason);
    } catch (error) {
      this.logger.error(
        `  ⚠️ Failed to cascade rollback to ${subRunId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
