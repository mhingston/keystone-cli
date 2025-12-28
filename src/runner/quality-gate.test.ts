import { describe, expect, mock, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner qualityGate', () => {
  test('should refine output until the quality gate approves', async () => {
    const workflow: Workflow = {
      name: 'quality-gate-test',
      outputs: {
        final: '${{ steps.generate.output }}',
      },
      steps: [
        {
          id: 'generate',
          type: 'llm',
          agent: 'test-agent',
          prompt: 'draft the content',
          qualityGate: {
            agent: 'reviewer',
            maxAttempts: 1,
          },
        } as Step,
      ],
    };

    let draftAttempt = 0;
    let reviewAttempt = 0;

    const executeStepMock = mock(async (step: Step) => {
      if (step.id === 'generate') {
        draftAttempt += 1;
        return {
          status: 'success',
          output: draftAttempt === 1 ? 'draft v1' : 'draft v2',
        };
      }

      if (step.id === 'generate-quality-review') {
        reviewAttempt += 1;
        return {
          status: 'success',
          output: {
            approved: reviewAttempt > 1,
            issues: reviewAttempt > 1 ? [] : ['Needs more detail'],
            suggestions: reviewAttempt > 1 ? [] : ['Expand the draft'],
          },
        };
      }

      return { status: 'failed', output: null, error: 'Unexpected step' };
    });

    const runner = new WorkflowRunner(workflow, {
      dbPath: ':memory:',
      executeStep: executeStepMock as unknown as typeof import('./step-executor').executeStep,
      logger: {
        log: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
      },
    });

    const outputs = await runner.run();

    expect(outputs.final).toBe('draft v2');
    expect(executeStepMock).toHaveBeenCalledTimes(4);
  });
});
