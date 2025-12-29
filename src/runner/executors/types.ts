import type { MemoryDb } from '../../db/memory-db.ts';
import type { WorkflowDb } from '../../db/workflow-db.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import type { WorkflowStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { SafeSandbox } from '../../utils/sandbox.ts';
import type { WorkflowEvent } from '../events.ts';
import type { getAdapter } from '../llm-adapter.ts';
import type { MCPManager } from '../mcp-manager.ts';
import type { executeLlmStep } from './llm-executor.ts';

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

export interface StepExecutorOptions {
  executeWorkflowFn?: (
    step: WorkflowStep,
    context: ExpressionContext,
    abortSignal?: AbortSignal
  ) => Promise<StepResult>;
  mcpManager?: MCPManager;
  db?: WorkflowDb;
  memoryDb?: MemoryDb;
  runId?: string;
  stepExecutionId?: string;
  artifactRoot?: string;
  workflowDir?: string;
  workflowName?: string;
  redactForStorage?: (value: unknown) => unknown;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  debug?: boolean;
  allowInsecure?: boolean;
  emitEvent?: (event: WorkflowEvent) => void;
  getAdapter?: typeof getAdapter;
  executeStep?: any; // To avoid circular dependency
  executeLlmStep?: typeof executeLlmStep;
  sandbox?: typeof SafeSandbox;
}
