import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { WorkflowDb } from '../../src/db/workflow-db';
import type { Workflow } from '../../src/parser/schema';
import { WorkflowRunner } from '../../src/runner/workflow-runner';
import { StepStatus } from '../../src/types/status';
import { container } from '../../src/utils/container';
import { ConsoleLogger } from '../../src/utils/logger';

describe('WorkflowState Foreach Restoration', () => {
  const dbPath = `test-foreach-restore-${randomUUID()}.db`;

  container.register('logger', new ConsoleLogger());
  container.register('db', new WorkflowDb(dbPath));

  afterAll(() => {
    if (existsSync(dbPath)) {
      rmSync(dbPath);
    }
  });

  it('should treat a RUNNING foreach step as SUCCESS if all items are success', async () => {
    // 1. Setup DB with a "RUNNING" foreach step but all items completed
    const db = new WorkflowDb(dbPath);
    const runId = randomUUID();
    const stepId = 'foreach_step';
    const parentStepExecId = randomUUID();

    await db.createRun(runId, 'test-workflow', {});
    await db.updateRunStatus(runId, 'running');

    // Create the parent step as RUNNING
    await db.createStep(parentStepExecId, runId, stepId);
    await db.startStep(parentStepExecId);
    // Mark it as RUNNING, and store __foreachItems so expectedCount can be calculated
    const items = [1, 2, 3];
    await db.completeStep(parentStepExecId, StepStatus.RUNNING as any, { __foreachItems: items });

    // Create the item executions as SUCCESS
    for (let i = 0; i < items.length; i++) {
      const itemStepExecId = randomUUID();
      // Correctly pass iteration index to createStep
      await db.createStep(itemStepExecId, runId, stepId, i);
      // We must include output so hydration works and items array is populated
      await db.completeStep(itemStepExecId, StepStatus.SUCCESS, { result: items[i] });
    }

    // 2. Define workflow
    const workflow: Workflow = {
      name: 'test-workflow',
      steps: [
        {
          id: stepId,
          type: 'shell',
          run: 'echo ${{ item }}',
          foreach: '${{ [1, 2, 3] }}',
          needs: [],
        },
        {
          id: 'next_step',
          type: 'shell',
          run: 'echo "done"',
          needs: [stepId],
        },
      ],
      outputs: {
        final: '${{ steps.next_step.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    // 3. Restore via WorkflowRunner
    const runner = new WorkflowRunner(workflow, {
      dbPath,
      resumeRunId: runId,
    });

    // 4. Run - it should skip the foreach step (because it detects it as SUCCESS) and run next-step
    const outputs = await runner.run();
    expect(outputs.final).toBe('done');

    // Verify DB state
    const parentStep = await db.getMainStep(runId, stepId);

    // Since execution was skipped, the DB status should remain RUNNING (the fix is in-memory only)
    expect(parentStep?.status).toBe(StepStatus.RUNNING);

    db.close();
  });
});
