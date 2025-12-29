import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import * as StepExecutor from './step-executor';
import { WorkflowRunner } from './workflow-runner';

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
      } as any,
      resolvedModel: 'mock-model',
    });

    const spy = jest.fn();

    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      dbPath: ':memory:',
      getAdapter: mockGetAdapter,
      executeStep: spy as any,
    });

    const db = (runner as any).db;
    await db.createRun(runner.runId, workflow.name, {});

    // First call fails, Reflexion logic kicks in (calling mocked getAdapter),
    // then it retries with corrected command.
    spy.mockImplementation(async (step: any) => {
      if (step.run === 'exit 1') {
        return { status: 'failed', output: null, error: 'Command failed' };
      }

      if (step.run === 'echo "fixed"') {
        return { status: 'success', output: 'fixed' };
      }

      return { status: 'failed', output: null, error: 'Unknown step' };
    });

    await (runner as any).executeStepWithForeach(workflow.steps[0]);

    // Expectations:
    // 1. First execution (fails)
    // 2. Reflexion happens (internal, not executeStep)
    // 3. Second execution (retry with new command)
    expect(spy).toHaveBeenCalledTimes(2);

    // Verify the second call had the corrected command
    const secondCallArg = spy.mock.calls[1][0] as any;
    expect(secondCallArg.run).toBe('echo "fixed"');
  });
});
