import { describe, expect, jest, test } from 'bun:test';
import { executeDynamicStep } from '../../src/runner/executors/dynamic-executor';
import { ConsoleLogger } from '../../src/utils/logger';

describe('Dynamic Executor Security', () => {
  test('enforces recursion depth limit', async () => {
    const mockStep = {
      id: 'test_step',
      type: 'dynamic',
      goal: 'test recursion',
    } as any;

    const mockContext = {};
    const mockExecuteStepFn = jest.fn();
    const logger = new ConsoleLogger();

    await expect(
      executeDynamicStep(mockStep, mockContext, mockExecuteStepFn, logger, {
        runId: 'test_run',
        depth: 11, // Exceeds limit of 10
      } as any)
    ).rejects.toThrow('Maximum workflow recursion depth (10) exceeded');
  });

  test('allows recursion within depth limit', async () => {
    const mockStep = {
      id: 'test_step',
      type: 'dynamic',
      goal: 'test recursion',
      prompt: 'return simple plan',
      // Mocking supervisor agent properties
      agent: 'test',
      maxIterations: 1,
    } as any;

    const mockContext = {};
    // Mock executeStepFn that resolves
    const mockExecuteStepFn = jest
      .fn()
      .mockImplementation(async () => ({ status: 'success', output: {} }));

    // Mock LLM step execution to return a simple plan
    const mockExecuteLlmStep = jest.fn().mockImplementation(async () => ({
      status: 'success',
      output: {
        workflow_id: 'test',
        steps: [],
      },
    }));

    const logger = new ConsoleLogger();

    const result = await executeDynamicStep(mockStep, mockContext, mockExecuteStepFn, logger, {
      runId: 'test_run',
      depth: 5, // Within limit
      executeLlmStep: mockExecuteLlmStep,
    } as any);

    // Should not throw
    expect(result.status).not.toBe('failed');
    // If it returns success or failed (due to plan), it passed the depth check
  });
});
