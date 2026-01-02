import * as readlinePromises from 'node:readline/promises';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { HumanStep, SleepStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import { type StepResult, WorkflowSuspendedError, WorkflowWaitingError } from './types.ts';

// Global lock to ensure only one human input prompt is active at any time
let terminalLock: Promise<void> = Promise.resolve();

/**
 * Execute a human input step
 */
export async function executeHumanStep(
  step: HumanStep,
  context: ExpressionContext,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  const message = ExpressionEvaluator.evaluateString(step.message, context);

  // Check if we already have input for this step in context.inputs (from previous suspension)
  const stepInputs = (context.inputs as Record<string, any>)?.[step.id];
  if (stepInputs && stepInputs.__answer !== undefined) {
    logger.log(`  ✓ Received human input: ${stepInputs.__answer}`);
    return {
      status: 'success',
      output: stepInputs.__answer,
    };
  }

  const inputType = step.inputType || 'text';
  if (!process.stdin.isTTY) {
    logger.log(`  ⏳ Suspending for human input: ${message}`);
    throw new WorkflowSuspendedError(message, step.id, inputType);
  }

  // Acquire terminal lock to prevent overlapping readline sessions
  const myTurn = terminalLock.then(() => {});
  terminalLock = myTurn.then(async () => {
    // Settle time before starting a new prompt to clear any trailing input/echo
    await new Promise((r) => setTimeout(r, 150));
  });

  await myTurn;

  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Clear visual clutter
    process.stdout.write(
      '\n--------------------------------------------------------------------------------\n'
    );
    const prompt = inputType === 'confirm' ? `${message} [Y/n] ` : `${message} `;
    const answer = await rl.question(prompt);

    if (inputType === 'confirm') {
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        return { status: 'success', output: true };
      }
      if (['y', 'yes', 'true', '1'].includes(normalized)) {
        return { status: 'success', output: true };
      }
      if (['n', 'no', 'false', '0'].includes(normalized)) {
        return { status: 'success', output: false };
      }
      return { status: 'success', output: answer.trim() };
    }

    return { status: 'success', output: answer };
  } finally {
    rl.close();
    // Wait for rl to fully release stdin
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Execute a sleep step
 */
export async function executeSleepStep(
  step: SleepStep,
  context: ExpressionContext,
  logger: Logger,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }

  let durationMs = 0;
  let wakeAt: string | undefined;

  // Check if this is a resume of a durable sleep
  const previousOutput = (context.steps as Record<string, any>)?.[step.id]?.output;
  if (
    step.durable &&
    previousOutput &&
    typeof previousOutput === 'object' &&
    'wakeAt' in previousOutput
  ) {
    wakeAt = previousOutput.wakeAt as string;
    const untilDate = new Date(wakeAt);
    if (!Number.isNaN(untilDate.getTime())) {
      durationMs = untilDate.getTime() - Date.now();
    }
  }

  if (wakeAt) {
    // Already handled by resume logic above
  } else if (step.until) {
    const untilStr = ExpressionEvaluator.evaluateString(step.until, context);
    const untilDate = new Date(untilStr);
    if (Number.isNaN(untilDate.getTime())) {
      throw new Error(`Invalid 'until' date format: ${untilStr}`);
    }
    wakeAt = untilDate.toISOString();
    durationMs = untilDate.getTime() - Date.now();
  } else if (step.duration) {
    let duration: string;
    if (typeof step.duration === 'number') {
      duration = `${step.duration}ms`;
    } else {
      duration = ExpressionEvaluator.evaluateString(step.duration, context);
    }

    // Parse duration (e.g., "10s", "1m", "1h", "50ms")
    const match = duration.match(/^(\d+)([smh]|ms)$/);
    if (!match) {
      throw new Error(
        `Invalid duration format: ${duration}. Expected e.g. "10s", "1m", "1h", "50ms"`
      );
    }
    const val = Number.parseInt(match[1], 10);
    const unit = match[2];
    durationMs = val * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000);
    wakeAt = new Date(Date.now() + durationMs).toISOString();
  } else {
    throw new Error("Sleep step requires either 'duration' or 'until'");
  }

  if (durationMs <= 0) {
    logger.log('  ✓ Sleep duration already passed or is zero');
    return { status: 'success', output: 'slept' };
  }

  logger.log(`  ⏳ Sleeping until ${wakeAt} (${Math.round(durationMs / 1000)}s remaining)`);

  if (step.durable) {
    throw new WorkflowWaitingError(`Sleeping until ${wakeAt}`, step.id, wakeAt);
  }

  await Bun.sleep(durationMs);
  return { status: 'success', output: 'slept' };
}
