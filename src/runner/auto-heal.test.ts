import { beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import * as StepExecutor from './step-executor';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner Auto-Heal', () => {
  beforeEach(() => {
    jest.fn();
  });

  test('should attempt to auto-heal a failing step', async () => {
    const workflow: Workflow = {
      name: 'auto-heal-test',
      steps: [
        {
          id: 'fail-step',
          type: 'shell',
          run: 'exit 1',
          auto_heal: {
            agent: 'fixer-agent',
            maxAttempts: 1,
          },
        } as Step,
      ],
    };

    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      dbPath: ':memory:',
    });

    const db = (runner as unknown as { db: any }).db;
    await db.createRun(runner.runId, workflow.name, {});

    const spy = jest.spyOn(StepExecutor, 'executeStep');

    spy.mockImplementation(async (step, _context) => {
      if (step.id === 'fail-step-healer') {
        return {
          status: 'success',
          output: { run: 'echo "fixed"' },
        };
      }

      if (step.id === 'fail-step') {
        if ((step as unknown as { run: string }).run === 'echo "fixed"') {
          return { status: 'success', output: 'fixed' };
        }
        return { status: 'failed', output: null, error: 'Command failed' };
      }

      return { status: 'failed', output: null, error: 'Unknown step' };
    });

    await (
      runner as unknown as { executeStepWithForeach: (step: Step) => Promise<void> }
    ).executeStepWithForeach(workflow.steps[0]);

    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockRestore();
  });
});
