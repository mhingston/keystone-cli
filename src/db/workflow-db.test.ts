import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowDb } from './workflow-db';

describe('WorkflowDb', () => {
  const dbPath = ':memory:';
  let db: WorkflowDb;

  beforeAll(() => {
    db = new WorkflowDb(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it('should create and retrieve a run', async () => {
    const runId = 'run-1';
    await db.createRun(runId, 'test-wf', { input: 1 });
    const run = await db.getRun(runId);
    expect(run).toBeDefined();
    expect(run?.workflow_name).toBe('test-wf');
    expect(JSON.parse(run?.inputs || '{}')).toEqual({ input: 1 });
  });

  it('should update run status', async () => {
    const runId = 'run-2';
    await db.createRun(runId, 'test-wf', {});
    await db.updateRunStatus(runId, 'success', { result: 'ok' });
    const run = await db.getRun(runId);
    expect(run?.status).toBe('success');
    expect(JSON.parse(run?.outputs || '{}')).toEqual({ result: 'ok' });
  });

  it('should create and list steps', async () => {
    const runId = 'run-3';
    await db.createRun(runId, 'test-wf', {});
    const stepId = 'step-a';
    await db.createStep('exec-1', runId, stepId);
    await db.startStep('exec-1');
    await db.completeStep('exec-1', 'success', { out: 'val' });

    const steps = await db.getStepsByRun(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0].step_id).toBe(stepId);
    expect(steps[0].status).toBe('success');
  });

  it('should persist falsy outputs', async () => {
    const runId = 'run-falsy';
    await db.createRun(runId, 'test-wf', {});

    await db.createStep('exec-false', runId, 'step-false');
    await db.startStep('exec-false');
    await db.completeStep('exec-false', 'success', false);

    await db.createStep('exec-zero', runId, 'step-zero');
    await db.startStep('exec-zero');
    await db.completeStep('exec-zero', 'success', 0);

    await db.createStep('exec-empty', runId, 'step-empty');
    await db.startStep('exec-empty');
    await db.completeStep('exec-empty', 'success', '');

    const steps = await db.getStepsByRun(runId);
    const outputsById = Object.fromEntries(steps.map((step) => [step.step_id, step.output]));

    expect(JSON.parse(outputsById['step-false'] || 'null')).toBe(false);
    expect(JSON.parse(outputsById['step-zero'] || 'null')).toBe(0);
    expect(JSON.parse(outputsById['step-empty'] || 'null')).toBe('');
  });

  it('should handle iterations in steps', async () => {
    const runId = 'run-4';
    await db.createRun(runId, 'test-wf', {});
    await db.createStep('exec-i0', runId, 'loop', 0);
    await db.createStep('exec-i1', runId, 'loop', 1);

    const step0 = await db.getStepByIteration(runId, 'loop', 0);
    expect(step0).toBeDefined();
    expect(step0?.iteration_index).toBe(0);

    const steps = await db.getStepsByRun(runId);
    expect(steps).toHaveLength(2);
  });

  it('should increment retry count', async () => {
    const runId = 'run-5';
    await db.createRun(runId, 'test-wf', {});
    await db.createStep('exec-r', runId, 'retry-step');
    await db.incrementRetry('exec-r');
    await db.incrementRetry('exec-r');

    const steps = await db.getStepsByRun(runId);
    expect(steps[0].retry_count).toBe(2);
  });

  it('should list runs with limit', async () => {
    await db.createRun('run-l1', 'wf', {});
    await db.createRun('run-l2', 'wf', {});
    const runs = await db.listRuns(1);
    expect(runs).toHaveLength(1);
  });

  it('should vacuum the database', async () => {
    await db.vacuum();
    // If it doesn't throw, it's successful
  });

  it('should prune old runs', async () => {
    const runId = 'old-run';
    await db.createRun(runId, 'test-wf', {});

    // We can't easily change the date via public API,
    // but we can check that it doesn't delete recent runs
    const deleted = await db.pruneRuns(30);
    expect(deleted).toBe(0);

    const run = await db.getRun(runId);
    expect(run).toBeDefined();
  });

  it('should retrieve successful runs', async () => {
    // pending run
    await db.createRun('run-s1', 'my-wf', { i: 1 });

    // successful run
    await db.createRun('run-s2', 'my-wf', { i: 2 });
    await db.updateRunStatus('run-s2', 'success', { o: 2 });
    await new Promise((r) => setTimeout(r, 10));

    // failed run
    await db.createRun('run-s3', 'my-wf', { i: 3 });
    await db.updateRunStatus('run-s3', 'failed', undefined, 'err');
    await new Promise((r) => setTimeout(r, 10));

    // another successful run
    await db.createRun('run-s4', 'my-wf', { i: 4 });
    await db.updateRunStatus('run-s4', 'success', { o: 4 });

    const runs = await db.getSuccessfulRuns('my-wf', 5);
    expect(runs).toHaveLength(2);
    // ordered by started_at DESC, so run-s4 then run-s2
    expect(runs[0].id).toBe('run-s4');
    expect(JSON.parse(runs[0].outputs || '{}')).toEqual({ o: 4 });
    expect(runs[1].id).toBe('run-s2');

    // Limit check
    const limitedOne = await db.getSuccessfulRuns('my-wf', 1);
    expect(limitedOne).toHaveLength(1);
    expect(limitedOne[0].id).toBe('run-s4');
  });
});
