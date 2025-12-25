import type { MemoryDb } from '../db/memory-db.ts';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
// Removed synchronous file I/O imports - using Bun's async file API instead
import type {
  BlueprintStep,
  EngineStep,
  FileStep,
  HumanStep,
  MemoryStep,
  RequestStep,
  ScriptStep,
  ShellStep,
  SleepStep,
  Step,
  WorkflowStep,
} from '../parser/schema.ts';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';
import { executeBlueprintStep } from './blueprint-executor.ts';
import { executeEngineStep } from './engine-executor.ts';
import { getAdapter } from './llm-adapter.ts';
import { detectShellInjectionRisk, executeShell } from './shell-executor.ts';

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { SafeSandbox } from '../utils/sandbox.ts';
import { executeLlmStep } from './llm-executor.ts';
import { validateRemoteUrl } from './mcp-client.ts';
import type { MCPManager } from './mcp-manager.ts';

export class WorkflowSuspendedError extends Error {
  constructor(
    public readonly message: string,
    public readonly stepId: string,
    public readonly inputType: 'confirm' | 'text'
  ) {
    super(message);
    this.name = 'WorkflowSuspendedError';
  }
}

export class WorkflowWaitingError extends Error {
  constructor(
    public readonly message: string,
    public readonly stepId: string,
    public readonly wakeAt?: string
  ) {
    super(message);
    this.name = 'WorkflowWaitingError';
  }
}

export interface StepResult {
  output: unknown;
  status: 'success' | 'failed' | 'suspended' | 'skipped' | 'waiting';
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Execute a single step based on its type
 */
export interface StepExecutorOptions {
  executeWorkflowFn?: (step: WorkflowStep, context: ExpressionContext) => Promise<StepResult>;
  mcpManager?: MCPManager;
  memoryDb?: MemoryDb;
  workflowDir?: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  runId?: string;
  stepExecutionId?: string;
  artifactRoot?: string;
  redactForStorage?: (value: unknown) => unknown;
  debug?: boolean;
  allowInsecure?: boolean;
  // Dependency injection for testing
  getAdapter?: typeof getAdapter;
  executeStep?: typeof executeStep;
  sandbox?: typeof SafeSandbox;
}

import type { JoinStep } from '../parser/schema.ts';

/**
 * Execute a join step
 */
async function executeJoinStep(
  step: JoinStep,
  context: ExpressionContext,
  _logger: Logger
): Promise<StepResult> {
  // Join step logic:
  // It aggregates outputs from its 'needs'.
  // Since the runner ensures dependencies are met (or processed),
  // we just need to collect the results from context.steps.

  const inputs: Record<string, unknown> = {};
  const statusMap: Record<string, string> = {};
  const realStatusMap: Record<string, 'success' | 'failed'> = {}; // Status considering allowFailure errors
  const errors: string[] = [];

  for (const depId of step.needs) {
    const depContext = context.steps?.[depId];
    if (depContext) {
      inputs[depId] = depContext.output;
      if (depContext.status) {
        statusMap[depId] = depContext.status;
      }

      // Determine effective status:
      // If status is success but error exists (allowFailure), treat as failed for the join condition
      const isRealSuccess = depContext.status === 'success' && !depContext.error;
      realStatusMap[depId] = isRealSuccess ? 'success' : 'failed';

      if (depContext.error) {
        errors.push(`Dependency ${depId} failed: ${depContext.error}`);
      }
    }
  }

  // Validate condition
  const condition = step.condition;
  const total = step.needs.length;
  // Use realStatusMap to count successes/failures
  const successCount = Object.values(realStatusMap).filter((s) => s === 'success').length;

  // Note: We use the strict success count.
  // If a step was skipped, it's neither success nor failed in this binary map?
  // Skipped steps usually mean "not run".
  // If we want skipped steps to count as success? Probably not.
  // Let's check skipped.

  let passed = false;

  if (condition === 'all') {
    passed = successCount === total;
  } else if (condition === 'any') {
    passed = successCount > 0;
  } else if (typeof condition === 'number') {
    passed = successCount >= condition;
  }

  // NOTE: True "any" or "quorum" (partial completion) requires Runner support to schedule the join
  // before all dependencies are done. Currently, the runner waits for ALL dependencies.
  // So this logic works for 'all' or 'any' (if others failed but allowFailure was true).
  // Use allowFailure on branches to support "best effort" joins with the current runner.

  if (!passed) {
    return {
      output: { inputs, status: statusMap },
      status: 'failed',
      error: `Join condition '${condition}' not met. Success: ${successCount}/${total}. Errors: ${errors.join('; ')}`,
    };
  }

  return {
    output: { inputs, status: statusMap },
    status: 'success',
  };
}

/**
 * Execute a single step based on its type
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
    getAdapter: injectedGetAdapter,
    executeStep: injectedExecuteStep,
    sandbox: injectedSandbox,
  } = options;

  try {
    if (abortSignal?.aborted) {
      throw new Error('Step canceled');
    }
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
        result = await executeFileStep(step, context, logger, dryRun);
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
        result = await executeLlmStep(
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
          injectedGetAdapter
        );
        break;
      case 'memory':
        result = await executeMemoryStep(step, context, logger, memoryDb, injectedGetAdapter);
        break;
      case 'workflow':
        if (!executeWorkflowFn) {
          throw new Error('Workflow executor not provided');
        }
        result = await executeWorkflowFn(step, context);
        break;
      case 'script':
        result = await executeScriptStep(step, context, logger, injectedSandbox, abortSignal);
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
          (s, c) => executeStep(s, c, logger, options),
          logger,
          {
            mcpManager,
            workflowDir,
            abortSignal,
            runId,
            artifactRoot,
          }
        );
        break;
      case 'join':
        // Join is handled by the runner logic for aggregation, but we need a placeholder here
        // or logic to aggregate results from dependencies.
        // Actually, for 'all', 'any', 'quorum', the step *itself* should process the inputs.
        // By the time executeStep is called, dependencies are met (for 'all').
        // But for 'any', the runner must schedule it early.
        // Assuming the runner handles scheduling, here we just return the aggregated output.
        // We will assume 'context.steps' contains the dependency outputs.
        result = await executeJoinStep(step, context, logger);
        break;
      default:
        throw new Error(`Unknown step type: ${(step as Step).type}`);
    }

    // Apply transformation if specified and step succeeded
    if (step.transform && result.status === 'success') {
      const transformContext = {
        // 1. Provide raw output properties (like stdout, data) directly in context for convenience
        ...(typeof result.output === 'object' && result.output !== null ? result.output : {}),
        // 2. Add core context (inputs, secrets, etc.). This takes priority over output properties for security.
        ...context,
        // 3. Explicitly add 'output' so it refers to the current step's result even if context or output properties have a collision.
        output: result.output,
      };

      try {
        // If it's wrapped in ${{ }}, extract it, otherwise treat as raw expression
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
    return {
      output: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a shell step
 */
async function executeShellStep(
  step: ShellStep,
  context: ExpressionContext,
  logger: Logger,
  dryRun?: boolean,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  if (dryRun) {
    const command = ExpressionEvaluator.evaluateString(step.run, context);
    logger.log(`[DRY RUN] Would execute shell command: ${command}`);
    return {
      output: { stdout: '[DRY RUN] Success', stderr: '', exitCode: 0 },
      status: 'success',
    };
  }
  // Check for risk and prompt if TTY
  const command = ExpressionEvaluator.evaluateString(step.run, context);
  const isRisky = detectShellInjectionRisk(command);

  if (isRisky && !step.allowInsecure) {
    throw new Error(
      `Security Error: Command contains shell metacharacters that may indicate injection risk.\n   Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}\n   To execute this command, set 'allowInsecure: true' on the step definition.`
    );
  }

  const result = await executeShell(step, context, logger, abortSignal);

  if (result.stdout) {
    logger.log(result.stdout.trim());
  }

  if (result.exitCode !== 0) {
    return {
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      status: 'failed',
      error: `Shell command exited with code ${result.exitCode}: ${result.stderr}`,
    };
  }

  return {
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
    status: 'success',
  };
}

async function executeEngineStepWrapper(
  step: EngineStep,
  context: ExpressionContext,
  logger: Logger,
  options: {
    abortSignal?: AbortSignal;
    runId?: string;
    stepExecutionId?: string;
    artifactRoot?: string;
    redactForStorage?: (value: unknown) => unknown;
  }
): Promise<StepResult> {
  const engineResult = await executeEngineStep(step, context, {
    logger,
    abortSignal: options.abortSignal,
    runId: options.runId,
    stepExecutionId: options.stepExecutionId,
    artifactRoot: options.artifactRoot,
    redactForStorage: options.redactForStorage,
  });

  const output = {
    summary: engineResult.summary ?? null,
    stdout: engineResult.stdout,
    stderr: engineResult.stderr,
    exitCode: engineResult.exitCode,
    summarySource: engineResult.summarySource,
    summaryFormat: engineResult.summaryFormat,
    artifactPath: engineResult.artifactPath,
  };

  if (engineResult.exitCode !== 0) {
    return {
      output,
      status: 'failed',
      error: `Engine exited with code ${engineResult.exitCode}: ${engineResult.stderr}`,
    };
  }

  if (engineResult.summaryError) {
    return {
      output,
      status: 'failed',
      error: `Engine summary parse failed: ${engineResult.summaryError}`,
    };
  }

  if (engineResult.summary === null) {
    return {
      output,
      status: 'failed',
      error: `Engine step "${step.id}" did not produce a structured summary`,
    };
  }

  return {
    output,
    status: 'success',
  };
}

/**
 * Execute a file step (read, write, append)
 */
async function executeFileStep(
  step: FileStep,
  context: ExpressionContext,
  _logger: Logger,
  dryRun?: boolean
): Promise<StepResult> {
  const rawPath = ExpressionEvaluator.evaluateString(step.path, context);

  // Security: Prevent path traversal
  const cwd = process.cwd();
  const resolvedPath = path.resolve(cwd, rawPath);
  const realCwd = fs.realpathSync(cwd);
  const isWithin = (target: string) => {
    const relativePath = path.relative(realCwd, target);
    return !(relativePath.startsWith('..') || path.isAbsolute(relativePath));
  };
  const getExistingAncestorRealPath = (start: string) => {
    let current = start;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    if (!fs.existsSync(current)) {
      return realCwd;
    }
    return fs.realpathSync(current);
  };

  if (!step.allowOutsideCwd) {
    if (fs.existsSync(resolvedPath)) {
      const realTarget = fs.realpathSync(resolvedPath);
      if (!isWithin(realTarget)) {
        throw new Error(`Access denied: Path '${rawPath}' resolves outside the working directory.`);
      }
    } else {
      const realParent = getExistingAncestorRealPath(path.dirname(resolvedPath));
      if (!isWithin(realParent)) {
        throw new Error(`Access denied: Path '${rawPath}' resolves outside the working directory.`);
      }
    }
  }

  // Use resolved path for operations
  const targetPath = resolvedPath;

  if (dryRun && step.op !== 'read') {
    const opVerb = step.op === 'write' ? 'write to' : 'append to';
    _logger.log(`[DRY RUN] Would ${opVerb} file: ${targetPath}`);
    return {
      output: { path: targetPath, bytes: 0 },
      status: 'success',
    };
  }

  switch (step.op) {
    case 'read': {
      const file = Bun.file(targetPath);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${targetPath}`);
      }
      const content = await file.text();
      return {
        output: content,
        status: 'success',
      };
    }

    case 'write': {
      if (!step.content) {
        throw new Error('Content is required for write operation');
      }
      const content = ExpressionEvaluator.evaluateString(step.content, context);

      // Ensure parent directory exists
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      await Bun.write(targetPath, content);
      return {
        output: { path: targetPath, bytes: content.length },
        status: 'success',
      };
    }

    case 'append': {
      if (!step.content) {
        throw new Error('Content is required for append operation');
      }
      const content = ExpressionEvaluator.evaluateString(step.content, context);

      // Ensure parent directory exists
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.appendFileSync(targetPath, content);

      return {
        output: { path: targetPath, bytes: content.length },
        status: 'success',
      };
    }

    default:
      throw new Error(`Unknown file operation: ${step.op}`);
  }
}

/**
 * Execute an HTTP request step
 */
async function executeRequestStep(
  step: RequestStep,
  context: ExpressionContext,
  _logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  const url = ExpressionEvaluator.evaluateString(step.url, context);

  // Validate URL to prevent SSRF
  await validateRemoteUrl(url, { allowInsecure: step.allowInsecure });

  // Evaluate headers
  const headers: Record<string, string> = {};
  if (step.headers) {
    for (const [key, value] of Object.entries(step.headers)) {
      headers[key] = ExpressionEvaluator.evaluateString(value, context);
    }
  }

  // Evaluate body
  let body: string | undefined;
  if (step.body) {
    const evaluatedBody = ExpressionEvaluator.evaluateObject(step.body, context);

    const contentType = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'content-type'
    )?.[1];

    if (contentType?.includes('application/x-www-form-urlencoded')) {
      if (typeof evaluatedBody === 'object' && evaluatedBody !== null) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(evaluatedBody)) {
          params.append(key, String(value));
        }
        body = params.toString();
      } else {
        body = String(evaluatedBody);
      }
    } else {
      // Default to JSON if not form-encoded and not already a string
      body = typeof evaluatedBody === 'string' ? evaluatedBody : JSON.stringify(evaluatedBody);

      // Auto-set Content-Type to application/json if not already set and body is an object
      if (!contentType && typeof evaluatedBody === 'object' && evaluatedBody !== null) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const maxRedirects = 5;
  let response: Response | undefined;
  let currentUrl = url;
  let currentMethod = step.method;
  let currentBody = body;
  const currentHeaders: Record<string, string> = { ...headers };
  const removeHeader = (name: string) => {
    const target = name.toLowerCase();
    for (const key of Object.keys(currentHeaders)) {
      if (key.toLowerCase() === target) {
        delete currentHeaders[key];
      }
    }
  };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    response = await fetch(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      redirect: 'manual',
      signal: abortSignal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        break;
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`Request exceeded maximum redirects (${maxRedirects})`);
      }

      const nextUrl = new URL(location, currentUrl).href;
      await validateRemoteUrl(nextUrl, { allowInsecure: step.allowInsecure });

      const fromOrigin = new URL(currentUrl).origin;
      const toOrigin = new URL(nextUrl).origin;
      if (fromOrigin !== toOrigin) {
        removeHeader('authorization');
        removeHeader('proxy-authorization');
        removeHeader('cookie');
      }

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod !== 'GET' &&
          currentMethod !== 'HEAD')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
        removeHeader('content-type');
      }

      currentUrl = nextUrl;
      continue;
    }

    break;
  }

  if (!response) {
    throw new Error('Request failed: No response received');
  }

  const responseText = await response.text();
  let responseData: unknown;

  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  return {
    output: {
      status: response.status,
      statusText: response.statusText,
      headers: (() => {
        const h: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          h[k] = v;
        });
        return h;
      })(),
      data: responseData,
    },
    status: response.ok ? 'success' : 'failed',
    error: response.ok
      ? undefined
      : `HTTP ${response.status}: ${response.statusText}${responseText
        ? `\nResponse Body: ${responseText.substring(0, 500)}${responseText.length > 500 ? '...' : ''}`
        : ''
      }`,
  };
}

/**
 * Execute a human input step
 */
async function executeHumanStep(
  step: HumanStep,
  context: ExpressionContext,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  const message = ExpressionEvaluator.evaluateString(step.message, context);

  // Check if we have a resume answer
  const stepInputs = context.inputs
    ? (context.inputs as Record<string, unknown>)[step.id]
    : undefined;
  if (stepInputs && typeof stepInputs === 'object' && '__answer' in stepInputs) {
    const answer = (stepInputs as Record<string, unknown>).__answer;
    return {
      output:
        step.inputType === 'confirm'
          ? answer === true ||
          (typeof answer === 'string' &&
            (answer.toLowerCase() === 'true' ||
              answer.toLowerCase() === 'yes' ||
              answer.toLowerCase() === 'y'))
          : answer,
      status: 'success',
    };
  }

  // If not a TTY (e.g. MCP server), suspend execution
  if (!process.stdin.isTTY) {
    return {
      output: null,
      status: 'suspended',
      error: message,
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (step.inputType === 'confirm') {
      logger.log(`\n❓ ${message}`);
      const answer = (await rl.question('Response (Y/n/text): ')).trim();

      const lowerAnswer = answer.toLowerCase();
      if (lowerAnswer === '' || lowerAnswer === 'y' || lowerAnswer === 'yes') {
        return {
          output: true,
          status: 'success',
        };
      }
      if (lowerAnswer === 'n' || lowerAnswer === 'no') {
        return {
          output: false,
          status: 'success',
        };
      }

      // Fallback to text if it's not a clear yes/no
      return {
        output: answer,
        status: 'success',
      };
    }

    // Text input
    logger.log(`\n❓ ${message}`);
    logger.log('Enter your response:');
    const input = await rl.question('');
    return {
      output: input.trim(),
      status: 'success',
    };
  } finally {
    rl.close();
  }
}

/**
 * Execute a sleep step
 */
async function executeSleepStep(
  step: SleepStep,
  context: ExpressionContext,
  _logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  const evaluated = ExpressionEvaluator.evaluate(step.duration.toString(), context);
  const duration = Number(evaluated);

  if (Number.isNaN(duration)) {
    throw new Error(`Invalid sleep duration: ${evaluated}`);
  }

  // For durable sleeps, return waiting status with wake time
  // Threshold: 60s (60000ms) - only durably wait if requested AND long enough
  if (step.durable && duration >= 60000) {
    const wakeAt = new Date(Date.now() + duration).toISOString();
    return {
      output: { durable: true, wakeAt, durationMs: duration },
      status: 'waiting',
    };
  }

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new Error('Step canceled'));
    };
    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, duration);
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        cleanup();
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });

  return {
    output: { slept: duration },
    status: 'success',
  };
}
/**
 * Execute a script step in a safe sandbox
 */
async function executeScriptStep(
  step: ScriptStep,
  context: ExpressionContext,
  _logger: Logger,
  sandbox = SafeSandbox,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  try {
    if (abortSignal?.aborted) {
      throw new Error('Step canceled');
    }
    if (!step.allowInsecure) {
      throw new Error(
        'Script execution is disabled by default because Bun uses an insecure VM sandbox. ' +
        "Set 'allowInsecure: true' on the script step to run it anyway."
      );
    }

    const requireFn = createRequire(import.meta.url);

    const result = await sandbox.execute(
      step.run,
      {
        inputs: context.inputs,
        secrets: context.secrets,
        steps: context.steps,
        env: context.env,
        // biome-ignore lint/suspicious/noExplicitAny: args is dynamic
        args: (context as any).args,
        require: requireFn,
        console,
      },
      {
        timeout: step.timeout,
      }
    );

    return {
      output: result,
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
 * Execute a memory operation (search or store)
 */
async function executeMemoryStep(
  step: MemoryStep,
  context: ExpressionContext,
  logger: Logger,
  memoryDb?: MemoryDb,
  getAdapterFn = getAdapter
): Promise<StepResult> {
  if (!memoryDb) {
    throw new Error('Memory database not initialized');
  }

  try {
    const { adapter, resolvedModel } = getAdapterFn(step.model || 'local');
    if (!adapter.embed) {
      throw new Error(`Provider for model ${step.model || 'local'} does not support embeddings`);
    }

    if (step.op === 'store') {
      const text = step.text ? ExpressionEvaluator.evaluateString(step.text, context) : '';
      if (!text) {
        throw new Error('Text is required for memory store operation');
      }

      logger.log(
        `  💾 Storing in memory: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`
      );
      const embedding = await adapter.embed(text, resolvedModel);
      const metadata = step.metadata
        ? // biome-ignore lint/suspicious/noExplicitAny: metadata typing
        (ExpressionEvaluator.evaluateObject(step.metadata, context) as Record<string, any>)
        : {};

      const id = await memoryDb.store(text, embedding, metadata);
      return {
        output: { id, status: 'stored' },
        status: 'success',
      };
    }

    if (step.op === 'search') {
      const query = step.query ? ExpressionEvaluator.evaluateString(step.query, context) : '';
      if (!query) {
        throw new Error('Query is required for memory search operation');
      }

      logger.log(`  🔍 Recalling memory: "${query}"`);
      const embedding = await adapter.embed(query, resolvedModel);
      const results = await memoryDb.search(embedding, step.limit);

      return {
        output: results,
        status: 'success',
      };
    }

    throw new Error(`Unknown memory operation: ${step.op}`);
  } catch (error) {
    return {
      output: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
