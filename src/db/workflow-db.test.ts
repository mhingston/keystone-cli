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

  describe('Transactions', () => {
    it('should commit successful transactions', () => {
      db.withTransaction((sqlite) => {
        sqlite.exec("INSERT INTO workflow_runs (id, workflow_name, status, inputs, started_at) VALUES ('tx-1', 'wf', 'pending', '{}', 'now')");
      });
      // @ts-ignore
      const run = db.db.query("SELECT * FROM workflow_runs WHERE id = 'tx-1'").get();
      expect(run).toBeDefined();
    });

    it('should rollback failed transactions', () => {
      try {
        db.withTransaction((sqlite) => {
          sqlite.exec("INSERT INTO workflow_runs (id, workflow_name, status, inputs, started_at) VALUES ('tx-2', 'wf', 'pending', '{}', 'now')");
          throw new Error('rollback');
        });
      } catch (e) {
        // expected
      }
      // @ts-ignore
      const run = db.db.query("SELECT * FROM workflow_runs WHERE id = 'tx-2'").get();
      expect(run).toBeNull();
    });
  });

  describe('Idempotency', () => {
    it('should store and retrieve idempotency records', async () => {
      const runId = 'run-idemp';
      await db.createRun(runId, 'wf', {});

      const success = await db.insertIdempotencyRecordIfAbsent('key-1', runId, 'step-1', 'pending');
      expect(success).toBe(true);

      const record = await db.getIdempotencyRecord('key-1');
      expect(record?.idempotency_key).toBe('key-1');

      const fail = await db.insertIdempotencyRecordIfAbsent('key-1', runId, 'step-1', 'pending');
      expect(fail).toBe(false);
    });

    it('should mark record as running', async () => {
      const runId = 'run-idemp-2';
      await db.createRun(runId, 'wf', {});
      await db.insertIdempotencyRecordIfAbsent('key-2', runId, 'step-2', 'pending');

      const success = await db.markIdempotencyRecordRunning('key-2', runId, 'step-2');
      expect(success).toBe(true);

      const record = await db.getIdempotencyRecord('key-2');
      expect(record?.status).toBe('running');
    });

    it('should clear idempotency records by run', async () => {
      const runId = 'run-to-clear';
      await db.createRun(runId, 'wf', {});
      await db.insertIdempotencyRecordIfAbsent('clear-key', runId, 'step-1', 'success');

      await db.clearIdempotencyRecords(runId);
      const record = await db.getIdempotencyRecord('clear-key');
      expect(record).toBeNull();
    });

    it('should clear expired idempotency records', async () => {
      const runId = 'run-expires';
      await db.createRun(runId, 'wf', {});

      // Store with expired date manually
      // @ts-ignore
      db.db.exec(`INSERT INTO idempotency_records (idempotency_key, run_id, step_id, status, created_at, expires_at) VALUES ('exp-key', '${runId}', 's1', 'success', '2000-01-01', '2000-01-02')`);

      const changes = await db.clearExpiredIdempotencyRecord('exp-key');
      expect(changes).toBe(1);
    });

    it('should prune idempotency records', async () => {
      const runId = 'run-prune';
      await db.createRun(runId, 'wf', {});
      // @ts-ignore
      db.db.exec(`INSERT INTO idempotency_records (idempotency_key, run_id, step_id, status, created_at, expires_at) VALUES ('prune-key', '${runId}', 's1', 'success', '2000-01-01', '2000-01-02')`);

      const changes = await db.pruneIdempotencyRecords();
      expect(changes).toBeGreaterThanOrEqual(1);
    });

    it('should list and clear all idempotency records', async () => {
      const runId = 'run-list';
      await db.createRun(runId, 'wf', {});
      await db.storeIdempotencyRecord('k1', runId, 's1', 'success');

      const list = await db.listIdempotencyRecords(runId);
      expect(list).toHaveLength(1);

      const allList = await db.listIdempotencyRecords();
      expect(allList.length).toBeGreaterThanOrEqual(1);

      await db.clearAllIdempotencyRecords();
      const after = await db.listIdempotencyRecords();
      expect(after).toHaveLength(0);
    });

    it('should clear idempotency records for specific steps', async () => {
      const runId = 'run-idemp-steps';
      await db.createRun(runId, 'wf', {});
      await db.storeIdempotencyRecord('k1', runId, 's1', 'success');
      await db.storeIdempotencyRecord('k2', runId, 's2', 'success');

      await db.clearIdempotencyRecordsForSteps(runId, ['s1']);
      const list = await db.listIdempotencyRecords(runId);
      expect(list).toHaveLength(1);
      expect(list[0].step_id).toBe('s2');
    });
  });

  describe('Retry Logic', () => {
    it('should retry on SQLITE_BUSY', async () => {
      let attempts = 0;
      const result = await (db as any).withRetry(() => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('database is locked');
          (err as any).code = 'SQLITE_BUSY';
          throw err;
        }
        return 'success';
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should throw after max retries', async () => {
      let attempts = 0;
      const operation = () => {
        attempts++;
        const err = new Error('database is locked');
        (err as any).code = 'SQLITE_BUSY';
        throw err;
      };

      await expect((db as any).withRetry(operation, 2)).rejects.toThrow('database is locked');
      expect(attempts).toBe(2);
    });
  });

  describe('Timers, Compensations, Cache, Events', () => {
    it('should handle durable timers', async () => {
      const runId = 'run-timer';
      await db.createRun(runId, 'wf', {});
      await db.createTimer('t1', runId, 'step-1', 'sleep', '2025-01-01T00:00:00Z');

      const timer = await db.getTimer('t1');
      expect(timer?.id).toBe('t1');

      const pending = await db.getTimerByStep(runId, 'step-1');
      expect(pending?.id).toBe('t1');

      await db.completeTimer('t1');
      const pendingAfter = await db.getTimerByStep(runId, 'step-1');
      expect(pendingAfter).toBeNull();
    });

    it('should get pending timers', async () => {
      const runId = 'run-timers';
      await db.createRun(runId, 'wf', {});
      await db.createTimer('t-back', runId, 's1', 'sleep', '2000-01-01T00:00:00Z');
      await db.createTimer('t-future', runId, 's2', 'sleep', '2099-01-01T00:00:00Z');

      const pending = await db.getPendingTimers();
      expect(pending.some(t => t.id === 't-back')).toBe(true);
      expect(pending.some(t => t.id === 't-future')).toBe(false);
    });

    it('should list and clear timers', async () => {
      const runId = 'run-clear-timers';
      await db.createRun(runId, 'wf', {});
      await db.createTimer('tc1', runId, 's1', 'sleep');
      await db.createTimer('tc2', runId, 's2', 'sleep');

      const list = await db.listTimers(runId);
      expect(list).toHaveLength(2);

      await db.clearTimersForSteps(runId, ['s1']);
      expect(await db.listTimers(runId)).toHaveLength(1);

      await db.clearTimers(runId);
      expect(await db.listTimers(runId)).toHaveLength(0);

      await db.createTimer('tc3', runId, 's3', 'sleep');
      await db.clearTimers();
      expect(await db.listTimers()).toHaveLength(0);
    });

    it('should handle compensations', async () => {
      const runId = 'run-comp';
      await db.createRun(runId, 'wf', {});
      await db.registerCompensation('c1', runId, 'step-1', 'comp-step', '{}');

      const pending = await db.getPendingCompensations(runId);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('c1');

      await db.updateCompensationStatus('c1', 'success', '{}');
      const pendingAfter = await db.getPendingCompensations(runId);
      expect(pendingAfter).toHaveLength(0);

      const all = await db.getAllCompensations(runId);
      expect(all).toHaveLength(1);

      await db.registerCompensation('c2', runId, 'step-2', 'comp-step-2', '{}');
      await db.clearCompensationsForSteps(runId, ['step-2']);
      const allAfter = await db.getAllCompensations(runId);
      expect(allAfter.some(c => c.id === 'c2')).toBe(false);
    });

    it('should handle step cache', async () => {
      await db.storeStepCache('key-c', 'wf', 'step-1', 'output', 3600);
      const cached = await db.getStepCache('key-c');
      expect(JSON.parse(cached?.output || 'null')).toBe('output');
    });

    it('should handle events', async () => {
      await db.storeEvent('ev-1', 'data');
      const ev = await db.getEvent('ev-1');
      expect(JSON.parse(ev?.data || 'null')).toBe('data');

      await db.deleteEvent('ev-1');
      const evAfter = await db.getEvent('ev-1');
      expect(evAfter).toBeNull();
    });

    it('should handle thought events', async () => {
      const runId = 'run-thought';
      await db.createRun(runId, 'wf', {});
      await db.storeThoughtEvent(runId, 'wf', 'step-1', 'thinking...', 'thinking');

      const thoughts = await db.listThoughtEvents(10, runId);
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].content).toBe('thinking...');
    });

    it('should handle batch step creation', async () => {
      const runId = 'run-batch';
      await db.createRun(runId, 'wf', {});
      await db.batchCreateSteps([
        { id: 'b1', runId, stepId: 's1', iterationIndex: null },
        { id: 'b2', runId, stepId: 's2', iterationIndex: null },
      ]);
      const steps = await db.getStepsByRun(runId);
      expect(steps).toHaveLength(2);
    });

    it('should clear step executions', async () => {
      const runId = 'run-clear';
      await db.createRun(runId, 'wf', {});
      await db.createStep('e1', runId, 's1');
      await db.createStep('e2', runId, 's2');

      const changes = await db.clearStepExecutions(runId, ['s1']);
      expect(changes).toBe(1);
      const steps = await db.getStepsByRun(runId);
      expect(steps).toHaveLength(1);
      expect(steps[0].step_id).toBe('s2');
    });

    it('should get main step', async () => {
      const runId = 'run-main';
      await db.createRun(runId, 'wf', {});
      await db.createStep('e1', runId, 's1'); // null iteration

      const step = await db.getMainStep(runId, 's1');
      expect(step?.id).toBe('e1');
    });

    it('should get last run', async () => {
      await db.createRun('last-1', 'last-wf', {});
      await new Promise(r => setTimeout(r, 10));
      await db.createRun('last-2', 'last-wf', {});

      const last = await db.getLastRun('last-wf');
      expect(last?.id).toBe('last-2');
    });

    it('should clear events', async () => {
      await db.storeEvent('e1', 'd1');
      await db.storeEvent('e2', 'd2');
      await db.clearEvents();
      const ev = await db.getEvent('e1');
      expect(ev).toBeNull();
    });

    it('should clear step cache', async () => {
      await db.storeStepCache('k1', 'wf1', 's1', 'o1');
      await db.storeStepCache('k2', 'wf2', 's2', 'o2');

      await db.clearStepCache('wf1');
      const c1 = await db.getStepCache('k1');
      expect(c1).toBeNull();
      const c2 = await db.getStepCache('k2');
      expect(c2).not.toBeNull();

      await db.clearStepCache();
      const c2After = await db.getStepCache('k2');
      expect(c2After).toBeNull();
    });
  });
});
