import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
// Removed synchronous file I/O imports - using Bun's async file API instead
import type {
  FileStep,
  HumanStep,
  RequestStep,
  ShellStep,
  SleepStep,
  Step,
  WorkflowStep,
} from '../parser/schema.ts';
import { executeShell } from './shell-executor.ts';
import type { Logger } from './workflow-runner.ts';

import * as readline from 'node:readline/promises';
import { executeLlmStep } from './llm-executor.ts';
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

export interface StepResult {
  output: unknown;
  status: 'success' | 'failed' | 'suspended';
  error?: string;
}

/**
 * Execute a single step based on its type
 */
export async function executeStep(
  step: Step,
  context: ExpressionContext,
  logger: Logger = console,
  executeWorkflowFn?: (step: WorkflowStep, context: ExpressionContext) => Promise<StepResult>,
  mcpManager?: MCPManager,
  workflowDir?: string
): Promise<StepResult> {
  try {
    let result: StepResult;
    switch (step.type) {
      case 'shell':
        result = await executeShellStep(step, context, logger);
        break;
      case 'file':
        result = await executeFileStep(step, context, logger);
        break;
      case 'request':
        result = await executeRequestStep(step, context, logger);
        break;
      case 'human':
        result = await executeHumanStep(step, context, logger);
        break;
      case 'sleep':
        result = await executeSleepStep(step, context, logger);
        break;
      case 'llm':
        result = await executeLlmStep(
          step,
          context,
          (s, c) => executeStep(s, c, logger, executeWorkflowFn, mcpManager, workflowDir),
          logger,
          mcpManager,
          workflowDir
        );
        break;
      case 'workflow':
        if (!executeWorkflowFn) {
          throw new Error('Workflow executor not provided');
        }
        result = await executeWorkflowFn(step, context);
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
  logger: Logger
): Promise<StepResult> {
  const result = await executeShell(step, context, logger);

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

/**
 * Execute a file step (read, write, append)
 */
async function executeFileStep(
  step: FileStep,
  context: ExpressionContext,
  _logger: Logger
): Promise<StepResult> {
  const path = ExpressionEvaluator.evaluateString(step.path, context);

  switch (step.op) {
    case 'read': {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${path}`);
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
      const fs = await import('node:fs/promises');
      const pathModule = await import('node:path');
      const dir = pathModule.dirname(path);
      await fs.mkdir(dir, { recursive: true });

      const bytes = await Bun.write(path, content);
      return {
        output: { path, bytes },
        status: 'success',
      };
    }

    case 'append': {
      if (!step.content) {
        throw new Error('Content is required for append operation');
      }
      const content = ExpressionEvaluator.evaluateString(step.content, context);

      // Ensure parent directory exists
      const fs = await import('node:fs/promises');
      const pathModule = await import('node:path');
      const dir = pathModule.dirname(path);
      await fs.mkdir(dir, { recursive: true });

      // Use Node.js fs for efficient append operation
      await fs.appendFile(path, content, 'utf-8');

      return {
        output: { path, bytes: content.length },
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
  _logger: Logger
): Promise<StepResult> {
  const url = ExpressionEvaluator.evaluateString(step.url, context);

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

  const response = await fetch(url, {
    method: step.method,
    headers,
    body,
  });

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
      headers: Object.fromEntries(response.headers.entries()),
      data: responseData,
    },
    status: response.ok ? 'success' : 'failed',
    error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
  };
}

/**
 * Execute a human input step
 */
async function executeHumanStep(
  step: HumanStep,
  context: ExpressionContext,
  logger: Logger
): Promise<StepResult> {
  const message = ExpressionEvaluator.evaluateString(step.message, context);

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
      logger.log('Press Enter to continue, or Ctrl+C to cancel...');
      await rl.question('');
      return {
        output: true,
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
  _logger: Logger
): Promise<StepResult> {
  const evaluated = ExpressionEvaluator.evaluate(step.duration.toString(), context);
  const duration = Number(evaluated);

  if (Number.isNaN(duration)) {
    throw new Error(`Invalid sleep duration: ${evaluated}`);
  }

  await new Promise((resolve) => setTimeout(resolve, duration));

  return {
    output: { slept: duration },
    status: 'success',
  };
}
