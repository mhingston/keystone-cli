import type { WorkflowDb } from '../../db/workflow-db.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { WaitStep } from '../../parser/schema.ts';
import { container } from '../../utils/container.ts';
import type { Logger } from '../../utils/logger.ts';
import type { StepExecutorOptions, StepResult } from './types.ts';

/**
 * Execute a wait step (waiting for an external event)
 */
export async function executeWaitStep(
  step: WaitStep,
  context: ExpressionContext,
  logger: Logger,
  options: StepExecutorOptions
): Promise<StepResult> {
  if (options.abortSignal?.aborted) {
    throw new Error('Wait operation aborted');
  }
  const eventName = ExpressionEvaluator.evaluateString(step.event, context);
  const db = options.db ?? container.resolveOptional<WorkflowDb>('db');
  if (!db) {
    throw new Error('Workflow database not initialized');
  }

  const event = await db.getEvent(eventName);

  if (event) {
    logger.log(`  ✓ Event '${eventName}' occurred`);

    // If oneShot is true (default), consume the event
    if (step.oneShot !== false) {
      await db.deleteEvent(eventName);
      logger.log(`  🗑️ One-shot event '${eventName}' consumed`);
    }

    let output = null;
    if (event.data) {
      try {
        output = JSON.parse(event.data);
      } catch {
        output = event.data;
      }
    }
    return {
      status: 'success',
      output,
    };
  }

  // Not occurred, suspend
  logger.log(`  ⏳ Waiting for event: ${eventName}`);
  return {
    status: 'suspended',
    output: { event: eventName },
    error: `Waiting for event: ${eventName}`,
  };
}
