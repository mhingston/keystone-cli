import type { ExpressionContext } from '../../expression/evaluator.ts';
import type { ScriptStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { SafeSandbox } from '../../utils/sandbox.ts';
import { SafeSandbox as DefaultSandbox } from '../../utils/sandbox.ts';
import type { StepResult } from './types.ts';

/**
 * Execute a script step (inline JavaScript)
 */
export async function executeScriptStep(
  step: ScriptStep,
  context: ExpressionContext,
  logger: Logger,
  options: { sandbox?: typeof SafeSandbox; abortSignal?: AbortSignal } = {}
): Promise<StepResult> {
  if (!step.allowInsecure) {
    return {
      status: 'failed',
      output: null,
      error: 'Script execution is disabled by default. Set allowInsecure: true to run scripts.',
    };
  }

  try {
    const sandbox = options.sandbox || DefaultSandbox;
    const result = await sandbox.execute(step.run, context as any, {
      logger,
      signal: options.abortSignal,
    });

    return {
      status: 'success',
      output: result,
    };
  } catch (error) {
    return {
      status: 'failed',
      output: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
