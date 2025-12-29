import type { ExpressionContext } from '../../expression/evaluator.ts';
import type { JoinStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { StepResult } from './types.ts';

/**
 * Execute a join step
 */
export async function executeJoinStep(
  step: JoinStep,
  context: ExpressionContext,
  _logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Join operation aborted');
  }
  // Join step logic:
  // It aggregates outputs from its 'needs'.
  // Since the runner ensures dependencies are met (or processed),
  // we just need to collect the results from context.steps.

  const inputs: Record<string, unknown> = {};
  const statusMap: Record<string, string> = {};
  const realStatusMap: Record<string, 'success' | 'failed'> = {}; // Status considering allowFailure errors
  const errors: string[] = [];

  for (const depId of step.needs) {
    const depContext = (context.steps as Record<string, any>)?.[depId];
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
  const condition = step.condition || 'all';
  const total = step.needs.length;
  // Use realStatusMap to count successes/failures
  const successCount = Object.values(realStatusMap).filter((s) => s === 'success').length;

  let passed = false;

  if (condition === 'all') {
    passed = successCount === total;
  } else if (condition === 'any') {
    passed = successCount > 0;
  } else if (typeof condition === 'number') {
    passed = successCount >= condition;
  }

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
