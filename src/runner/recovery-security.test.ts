import { beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner Recovery Security', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('should NOT allow reflexion to overwrite critical step properties', async () => {
    const workflow: Workflow = {
      name: 'reflexion-security-test',
      steps: [
        {
          id: 'fail-step',
          type: 'shell',
          run: 'exit 1',
          reflexion: {
            limit: 2,
          },
        } as Step,
      ],
    };

    const mockGetAdapter = () => ({
      adapter: {
        chat: async () => ({
          message: {
            content: JSON.stringify({
              run: 'echo "fixed"',
              type: 'script', // ATTEMPT TO CHANGE TYPE
              id: 'malicious-id', // ATTEMPT TO CHANGE ID
            }),
          },
        }),
      } as any,
      resolvedModel: 'mock-model',
    });

    const spy = jest.fn();

    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
      dbPath: ':memory:',
      getAdapter: mockGetAdapter,
      executeStep: spy as any,
    });

    const db = (runner as any).db;
    await db.createRun(runner.runId, workflow.name, {});

    spy.mockImplementation(async (step: any) => {
      if (step.run === 'exit 1') {
        return { status: 'failed', output: null, error: 'Command failed' };
      }
      return { status: 'success', output: 'fixed' };
    });

    await (runner as any).executeStepWithForeach(workflow.steps[0]);

    // Expectations:
    // 1. First execution (fails)
    // 2. Reflexion happens
    // 3. Second execution (retry)
    expect(spy).toHaveBeenCalledTimes(2);

    const secondCallArg = spy.mock.calls[1][0] as any;
    expect(secondCallArg.run).toBe('echo "fixed"');
    expect(secondCallArg.type).toBe('shell'); // Should still be shell
    expect(secondCallArg.id).toBe('fail-step'); // Should still be fail-step
  });

  test('should NOT allow auto_heal to overwrite critical step properties', async () => {
    const workflow: Workflow = {
      name: 'autoheal-security-test',
      steps: [
        {
          id: 'fail-step',
          type: 'shell',
          run: 'exit 1',
          auto_heal: {
            maxAttempts: 1,
            agent: 'healer',
          },
        } as Step,
      ],
    };

    const spy = jest.fn();
    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
      dbPath: ':memory:',
      executeStep: spy as any,
    });

    const db = (runner as any).db;
    await db.createRun(runner.runId, workflow.name, {});

    spy.mockImplementation(async (step: any) => {
      if (step.run === 'exit 1') {
        return { status: 'failed', output: null, error: 'Command failed' };
      }
      if (step.id === 'fail-step' && step.run === 'echo "fixed"') {
        return { status: 'success', output: 'fixed' };
      }
      // This is the healer agent call itself
      if (step.id === 'fail-step-healer') {
        return {
          status: 'success',
          output: {
            run: 'echo "fixed"',
            type: 'script', // ATTEMPT TO CHANGE TYPE
            id: 'malicious-id', // ATTEMPT TO CHANGE ID
          },
        };
      }
      return { status: 'failed', error: 'Unexpected step' };
    });

    await (runner as any).executeStepWithForeach(workflow.steps[0]);

    // 1. Initial fail
    // 2. Healer call
    // 3. Retry
    expect(spy).toHaveBeenCalledTimes(3);

    const retryCallArg = spy.mock.calls[2][0] as any;
    expect(retryCallArg.run).toBe('echo "fixed"');
    expect(retryCallArg.type).toBe('shell');
    expect(retryCallArg.id).toBe('fail-step');
  });
});
