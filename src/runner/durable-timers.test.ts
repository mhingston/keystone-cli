import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WorkflowDb } from '../db/workflow-db';
import type { Workflow } from '../parser/schema';
import { StepStatus, WorkflowStatus } from '../types/status';
import { WorkflowSuspendedError, WorkflowWaitingError } from './step-executor';
import { WorkflowRunner } from './workflow-runner';

describe('Durable Timers Integration', () => {
  const dbPath = `test-timers-${randomUUID()}.db`;
  let db: WorkflowDb;

  beforeAll(() => {
    db = new WorkflowDb(dbPath);
  });

  afterAll(() => {
    db.close();
    try {
      const { rmSync } = require('node:fs');
      rmSync(dbPath);
    } catch {}
  });

  const sleepWorkflow: Workflow = {
    name: 'sleep-test',
    steps: [
      {
        id: 'wait',
        type: 'sleep',
        duration: 120000, // 2 minutes
        durable: true,
        needs: [],
      },
    ],
  };

  const humanWorkflow: Workflow = {
    name: 'human-test',
    steps: [
      {
        id: 'approve',
        type: 'human',
        message: 'Approve?',
        needs: [],
      },
    ],
  };

  it('should suspend a durable sleep step and create a timer', async () => {
    const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
    const runId = runner.runId;

    try {
      await runner.run();
    } catch (error) {
      if (!(error instanceof WorkflowWaitingError)) {
        throw error;
      }
      expect(error.stepId).toBe('wait');
    }

    const run = await db.getRun(runId);
    expect(run?.status).toBe(WorkflowStatus.PAUSED);

    const steps = await db.getStepsByRun(runId);
    expect(steps[0].status).toBe(StepStatus.WAITING);

    const timer = await db.getTimerByStep(runId, 'wait');
    expect(timer).toBeDefined();
    expect(timer?.timer_type).toBe('sleep');
    expect(timer?.wake_at).not.toBeNull();

    if (!timer?.wake_at) {
      throw new Error('Expected timer wake_at to be set');
    }
    const wakeAt = new Date(timer.wake_at);
    expect(wakeAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('should persist human waits without scheduling', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false; // Ensure human step suspends instead of waiting for input

    const runner = new WorkflowRunner(humanWorkflow, { dbPath });
    const runId = runner.runId;

    try {
      await runner.run();
    } catch (error) {
      if (!(error instanceof WorkflowSuspendedError)) {
        throw error;
      }
      expect(error.stepId).toBe('approve');
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    const run = await db.getRun(runId);
    expect(run?.status).toBe(WorkflowStatus.PAUSED);

    const steps = await db.getStepsByRun(runId);
    expect(steps[0].status).toBe(StepStatus.SUSPENDED);

    const timer = await db.getTimerByStep(runId, 'approve');
    expect(timer).toBeDefined();
    expect(timer?.timer_type).toBe('human');
    expect(timer?.wake_at).toBeNull();

    const pending = await db.getPendingTimers();
    expect(pending.find((t) => t.step_id === 'approve')).toBeUndefined();
  });

  it('should resume a waiting run if the timer has NOT elapsed', async () => {
    const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
    const runId = runner.runId;

    // Start it once to get it waiting
    try {
      await runner.run();
    } catch {}

    // Now try to resume with a new runner instance
    const resumeRunner = new WorkflowRunner(sleepWorkflow, {
      dbPath,
      resumeRunId: runId,
    });

    try {
      await resumeRunner.run();
    } catch (error) {
      if (!(error instanceof WorkflowWaitingError)) {
        throw error;
      }
      expect(error.stepId).toBe('wait');
    }

    const steps = await db.getStepsByRun(runId);
    expect(steps[0].status).toBe(StepStatus.WAITING);
  });

  it('should NOT create duplicate timers on resume', async () => {
    const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
    const runId = runner.runId;
    try {
      await runner.run();
    } catch {}

    const timersBefore = await db.listTimers(runId);
    expect(timersBefore).toHaveLength(1);

    const resumeRunner = new WorkflowRunner(sleepWorkflow, { dbPath, resumeRunId: runId });
    try {
      await resumeRunner.run();
    } catch {}

    const timersAfter = await db.listTimers(runId);
    // After fix, it should NOT create a new timer if one is already pending
    expect(timersAfter).toHaveLength(1);
  });

  it('should resume and COMPLETE a waiting run if the timer has elapsed', async () => {
    const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
    const runId = runner.runId;

    try {
      await runner.run();
    } catch {}

    const timer = await db.getTimerByStep(runId, 'wait');
    expect(timer).toBeDefined();
    if (!timer) {
      throw new Error('Expected timer to be created');
    }

    // Manually backdate the timer in the DB to simulate elapsed time
    const pastDate = new Date(Date.now() - 10000).toISOString();
    const { Database } = require('bun:sqlite');
    const sqlite = new Database(dbPath);
    sqlite.prepare('UPDATE durable_timers SET wake_at = ? WHERE id = ?').run(pastDate, timer.id);

    // Also need to update the step_executions output, as WorkflowState hydrates from there
    const newOutput = JSON.stringify({ durable: true, wakeAt: pastDate, durationMs: 120000 });
    sqlite
      .prepare('UPDATE step_executions SET output = ? WHERE run_id = ? AND step_id = ?')
      .run(newOutput, runId, 'wait');

    sqlite.close();

    const resumeRunner = new WorkflowRunner(sleepWorkflow, {
      dbPath,
      resumeRunId: runId,
    });

    const outputs = await resumeRunner.run();
    expect(outputs).toBeDefined();

    const run = await db.getRun(runId);
    expect(run?.status).toBe(WorkflowStatus.SUCCESS);

    const steps = await db.getStepsByRun(runId);
    const waitStep = steps.find((s) => s.step_id === 'wait' && s.status === StepStatus.SUCCESS);
    expect(waitStep).toBeDefined();
    expect(waitStep?.status).toBe(StepStatus.SUCCESS);

    const finalTimer = await db.getTimer(timer.id);
    expect(finalTimer?.completed_at).not.toBeNull();
  });
});
