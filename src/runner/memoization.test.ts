import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { MemoryDb } from '../db/memory-db';
import { WorkflowDb } from '../db/workflow-db';
import { ExpressionEvaluator } from '../expression/evaluator';
import type { Workflow } from '../parser/schema';
import { container } from '../utils/container';
import { ConsoleLogger } from '../utils/logger';
import { getAdapter } from './llm-adapter';
import { WorkflowRunner } from './workflow-runner';

describe('Workflow Memoization (Auto-Hashing)', () => {
  const dbPath = 'test-memoization.db';

  // Setup DI
  container.register('logger', new ConsoleLogger());
  container.register('db', new WorkflowDb(dbPath));
  container.register('memoryDb', new MemoryDb());

  afterEach(() => {
    if (existsSync(dbPath)) {
      rmSync(dbPath);
    }
  });

  const mockExecuteLlmStep = async (step: any, context: any) => {
    const model = ExpressionEvaluator.evaluateString(step.model, context);
    const prompt = ExpressionEvaluator.evaluateString(step.prompt, context);
    return {
      output: `Executed with model: ${model}, prompt: ${prompt}`,
      status: 'success' as const,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20,
      },
    };
  };

  it('should memoize LLM steps based on resolved model and prompt', async () => {
    const workflow: Workflow = {
      name: 'memoize-llm-wf',
      inputs: {
        model: { type: 'string' },
        prompt: { type: 'string' },
      },
      steps: [
        {
          id: 's1',
          type: 'llm',
          agent: 'mock-agent',
          // Dynamic model and prompt
          model: '${{ inputs.model }}',
          prompt: '${{ inputs.prompt }}',
          memoize: true,
          provider: 'openai',
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output }}',
      },
    } as unknown as Workflow;

    // Run 1: model=gpt-4, prompt=hello
    const runner1 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { model: 'gpt-4', prompt: 'hello' },
      executeLlmStep: mockExecuteLlmStep,
    });

    // Spy on DB to see if cache was checked/hit
    const db = new WorkflowDb(dbPath); // Use same DB file
    // We can't easily spy on the internal DB instance of the runner, but we can verify the result
    // Or we can inject the DB.

    const outputs1 = await runner1.run();
    expect(outputs1.out).toBe('Executed with model: gpt-4, prompt: hello');

    // Run 2: SAME inputs -> Should be CACHED
    // We start a new runner (representing a new process/run)
    const runner2 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { model: 'gpt-4', prompt: 'hello' },
      executeLlmStep: mockExecuteLlmStep,
    });

    // We can check if `executeLlmStep` was called.
    let called = false;
    const trackingExecute = async (s: any, c: any) => {
      called = true;
      return mockExecuteLlmStep(s, c);
    };

    // Override the executor for runner2 to track calls
    // @ts-ignore - hacking private property or constructor option
    // Actually we passed it in constructor option.
    const runner2Tracked = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { model: 'gpt-4', prompt: 'hello' },
      executeLlmStep: trackingExecute,
    });

    const outputs2 = await runner2Tracked.run();
    expect(outputs2.out).toBe('Executed with model: gpt-4, prompt: hello');
    expect(called).toBe(false); // Should be skipped due to cache hit processing

    // Run 3: DIFFERENT model -> Should EXECUTE
    const runner3Tracked = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { model: 'gpt-3.5-turbo', prompt: 'hello' },
      executeLlmStep: trackingExecute,
    });

    called = false; // Reset
    const outputs3 = await runner3Tracked.run();
    expect(outputs3.out).toBe('Executed with model: gpt-3.5-turbo, prompt: hello');
    expect(called).toBe(true); // Should execute because cache key is different
  });

  it('should memoize shell steps based on resolved commands', async () => {
    const workflow: Workflow = {
      name: 'memoize-shell-wf',
      inputs: {
        val: { type: 'string' },
      },
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo ${{ inputs.val }}',
          allowInsecure: true,
          memoize: true,
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    // Run 1: val=A
    const runner1 = new WorkflowRunner(workflow, { dbPath, inputs: { val: 'A' } });
    const out1 = await runner1.run();
    expect(out1.out).toBe('A');

    // Wait to ensure timestamp change if that mattered (it shouldn't for hash)

    // Run 2: val=A -> Cache Hit
    // Using a way to detect execution: we can check the time it takes, or side effects.
    // Ideally we'd spy on executeStep.
    // Let's pass a custom executeStep?
    // WorkflowRunner uses `executeStep` imported or option.

    let executed = false;
    const trackedExecuteStep = async (step: any, context: any, logger: any, options: any) => {
      if (step.id === 's1') executed = true;
      // Delegate to real executor for shell
      const { executeStep } = await import('./step-executor');
      return executeStep(step, context, logger, options);
    };

    const runner2 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { val: 'A' },
      executeStep: trackedExecuteStep,
      dedup: false, // disable dedup to ensure global memoize is the one working?
      // actually dedup is per-run, memoize is global.
      // If dedup is on, it might skip due to dedup if we reuse runId?
      // But we create new runner -> new runId.
    });

    executed = false;
    const out2 = await runner2.run();
    expect(out2.out).toBe('A');
    expect(executed).toBe(false); // Should be memoized

    // Run 3: val=B -> Execute
    const runner3 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { val: 'B' },
      executeStep: trackedExecuteStep,
    });

    executed = false;
    const out3 = await runner3.run();
    expect(out3.out).toBe('B');
    expect(executed).toBe(true);
  });
});
