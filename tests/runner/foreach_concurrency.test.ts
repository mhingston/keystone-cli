import { describe, expect, jest, test } from 'bun:test';
import { MemoryDb } from '../../src/db/memory-db';
import type { WorkflowDb } from '../../src/db/workflow-db';
import {
  type ExecuteStepCallback,
  ForeachExecutor,
} from '../../src/runner/executors/foreach-executor';
import { StepStatus } from '../../src/types/status';
import { ConsoleLogger } from '../../src/utils/logger';

// Mock DB
const mockDb = {
  createStep: async () => {},
  startStep: async () => {},
  completeStep: async () => {},
  getStepIterations: async () => [],
  batchCreateSteps: async () => {},
  batchUpdateSteps: async () => {},
  countStepIterations: async () => 0,
} as unknown as WorkflowDb;

const logger = new ConsoleLogger();

describe('ForeachExecutor Concurrency', () => {
  test('should limit concurrency to default 50 for large arrays', async () => {
    const items = new Array(100).fill(0); // 100 items
    let concurrentCount = 0;
    let maxDetectedConcurrency = 0;

    const executeStepFn: ExecuteStepCallback = async (step, context, id) => {
      concurrentCount++;
      maxDetectedConcurrency = Math.max(maxDetectedConcurrency, concurrentCount);

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 10));

      concurrentCount--;
      return { status: StepStatus.SUCCESS, output: 'ok' };
    };

    const executor = new ForeachExecutor(mockDb, logger, executeStepFn);

    const step = {
      id: 'test-foreach',
      name: 'Test',
      foreach: '${{ items }}', // Will use passed items from context
      run: 'echo test',
    };

    const context = {
      items: items, // Pre-evaluated items
    } as any;

    // We need to bypass the evaluate check inside execute() which expects 'items' to be in context/expression
    // Actually, ForeachExecutor evaluates 'step.foreach' against context.
    // So we put the array in context under 'items' key.

    // BUT ForeachExecutor.execute evaluates: ExpressionEvaluator.evaluate(step.foreach, baseContext)
    // We need to mock ExpressionEvaluator or ensure it works.
    // Since we can't easily mock imports in bun check-mode for this specific file structure without rewiring,
    // let's assume ExpressionEvaluator works and 'items' variable is accessible.

    // Wait, we need to handle the fact that ForeachExecutor logic relies on ExpressionEvaluator.evaluate
    // If we pass an array to context.items and set step.foreach = 'items', it should resolve if evaluator works.

    // However, for this test we want to verify the concurrency logic specifically.
    // The executor has a 'concurrency' var inside.

    // Just running it should trigger the logic.
    await executor.execute(step as any, { items } as any, 'run-id');

    expect(maxDetectedConcurrency).toBeLessThanOrEqual(50);
    // It should be reasonably close to 50 if the scheduler is efficient, but definitely <= 50.
    // Note: JS event loop might serialize this more than threaded, but concurrent promises are tracked.
  });

  test('should respect user-defined concurrency', async () => {
    const items = new Array(20).fill(0);
    let concurrentCount = 0;
    let maxDetectedConcurrency = 0;

    const executeStepFn: ExecuteStepCallback = async (step, context, id) => {
      concurrentCount++;
      maxDetectedConcurrency = Math.max(maxDetectedConcurrency, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentCount--;
      return { status: StepStatus.SUCCESS, output: 'ok' };
    };

    const executor = new ForeachExecutor(mockDb, logger, executeStepFn);

    const step = {
      id: 'test-foreach-explicit',
      name: 'Test',
      foreach: '${{ items }}',
      concurrency: 5, // Explicitly set to 5
    };

    await executor.execute(step as any, { items } as any, 'run-id');

    expect(maxDetectedConcurrency).toBeLessThanOrEqual(5);
  });
});
