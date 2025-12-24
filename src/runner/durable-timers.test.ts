import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { WorkflowDb } from '../db/workflow-db';
import { WorkflowRunner } from './workflow-runner';
import { StepStatus, WorkflowStatus } from '../types/status';
import { randomUUID } from 'node:crypto';
import type { Workflow } from '../parser/schema';

describe('Durable Timers Integration', () => {
    const dbPath = 'test-timers.db';
    let db: WorkflowDb;

    beforeAll(() => {
        db = new WorkflowDb(dbPath);
    });

    afterAll(() => {
        db.close();
        try {
            const { rmSync } = require('node:fs');
            rmSync(dbPath);
        } catch { }
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
            } as any,
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
            } as any,
        ],
    };

    it('should suspend a durable sleep step and create a timer', async () => {
        const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
        const runId = runner.getRunId();

        try {
            await runner.run();
        } catch (error: any) {
            expect(error.name).toBe('WorkflowWaitingError');
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

        const wakeAt = new Date(timer!.wake_at!);
        expect(wakeAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should persist human waits without scheduling', async () => {
        const runner = new WorkflowRunner(humanWorkflow, { dbPath });
        const runId = runner.getRunId();

        try {
            await runner.run();
        } catch (error: any) {
            expect(error.name).toBe('WorkflowSuspendedError');
            expect(error.stepId).toBe('approve');
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
        const runId = runner.getRunId();

        // Start it once to get it waiting
        try { await runner.run(); } catch { }

        // Now try to resume with a new runner instance
        const resumeRunner = new WorkflowRunner(sleepWorkflow, {
            dbPath,
            resumeRunId: runId
        });

        try {
            await resumeRunner.run();
        } catch (error: any) {
            expect(error.name).toBe('WorkflowWaitingError');
            expect(error.stepId).toBe('wait');
        }

        const steps = await db.getStepsByRun(runId);
        expect(steps[0].status).toBe(StepStatus.WAITING);
    });

    it('should NOT create duplicate timers on resume', async () => {
        const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
        const runId = runner.getRunId();
        try { await runner.run(); } catch { }

        const timersBefore = await db.listTimers(runId);
        expect(timersBefore).toHaveLength(1);

        const resumeRunner = new WorkflowRunner(sleepWorkflow, { dbPath, resumeRunId: runId });
        try { await resumeRunner.run(); } catch { }

        const timersAfter = await db.listTimers(runId);
        // After fix, it should NOT create a new timer if one is already pending
        expect(timersAfter).toHaveLength(1);
    });

    it('should resume and COMPLETE a waiting run if the timer has elapsed', async () => {
        const runner = new WorkflowRunner(sleepWorkflow, { dbPath });
        const runId = runner.getRunId();

        try { await runner.run(); } catch { }

        const timer = await db.getTimerByStep(runId, 'wait');
        expect(timer).toBeDefined();

        // Manually backdate the timer in the DB to simulate elapsed time
        const pastDate = new Date(Date.now() - 1000).toISOString();
        const { Database } = require('bun:sqlite');
        const sqlite = new Database(dbPath);
        sqlite.prepare('UPDATE durable_timers SET wake_at = ? WHERE id = ?').run(pastDate, timer!.id);
        sqlite.close();

        const resumeRunner = new WorkflowRunner(sleepWorkflow, {
            dbPath,
            resumeRunId: runId
        });

        const outputs = await resumeRunner.run();
        expect(outputs).toBeDefined();

        const run = await db.getRun(runId);
        expect(run?.status).toBe(WorkflowStatus.SUCCESS);

        const steps = await db.getStepsByRun(runId);
        expect(steps[0].status).toBe(StepStatus.SUCCESS);

        const finalTimer = await db.getTimer(timer!.id);
        expect(finalTimer?.completed_at).not.toBeNull();
    });
});
