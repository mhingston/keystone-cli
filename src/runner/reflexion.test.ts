import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import * as StepExecutor from './step-executor';
import { WorkflowRunner } from './workflow-runner';

// Mock the LLM Adapter

describe('WorkflowRunner Reflexion', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('should attempt to self-correct a failing step using flexion', async () => {
    const workflow: Workflow = {
      name: 'reflexion-test',
      steps: [
        {
          id: 'fail-step',
          type: 'shell',
          run: 'exit 1',
          reflexion: {
            limit: 2,
            hint: 'fix it',
          },
        } as Step,
      ],
    };

    const mockGetAdapter = () => ({
      adapter: {
        chat: async () => ({
          message: {
            content: JSON.stringify({ run: 'echo "fixed"' }),
          },
        }),
        // biome-ignore lint/suspicious/noExplicitAny: mock adapter
      } as any,
      resolvedModel: 'mock-model',
    });

    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      dbPath: ':memory:',
      getAdapter: mockGetAdapter,
    });

    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    const db = (runner as any).db;
    await db.createRun(runner.runId, workflow.name, {});

    const spy = jest.spyOn(StepExecutor, 'executeStep');

    // First call fails, Reflexion logic kicks in (calling mocked getAdapter),
    // then it retries with corrected command.
    spy.mockImplementation(async (step, _context) => {
      // Original failing command
      // biome-ignore lint/suspicious/noExplicitAny: Accessing run property dynamically
      if ((step as any).run === 'exit 1') {
        return { status: 'failed', output: null, error: 'Command failed' };
      }

      // Corrected command from mock
      // biome-ignore lint/suspicious/noExplicitAny: Accessing run property dynamically
      if ((step as any).run === 'echo "fixed"') {
        return { status: 'success', output: 'fixed' };
      }

      return { status: 'failed', output: null, error: 'Unknown step' };
    });

    // biome-ignore lint/suspicious/noExplicitAny: Accessing private property for testing
    await (runner as any).executeStepWithForeach(workflow.steps[0]);

    // Expectations:
    // 1. First execution (fails)
    // 2. Reflexion happens (internal, not executeStep)
    // 3. Second execution (retry with new command)
    expect(spy).toHaveBeenCalledTimes(2);

    // Verify the second call had the corrected command
    // biome-ignore lint/suspicious/noExplicitAny: mock call args typing
    const secondCallArg = spy.mock.calls[1][0] as any;
    expect(secondCallArg.run).toBe('echo "fixed"');

    spy.mockRestore();
  });
});
