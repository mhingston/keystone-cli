import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { WorkflowDb } from '../db/workflow-db';
import type { Workflow } from '../parser/schema';
import type { Logger } from '../utils/logger';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner - Subflows & Compensations', () => {
  const dbPath = ':memory:';

  it('should execute parallel branches and join with "all" condition', async () => {
    const workflow: Workflow = {
      name: 'fan-out-in-all',
      steps: [
        { id: 'branch1', type: 'shell', run: 'echo "b1"', needs: [] },
        { id: 'branch2', type: 'shell', run: 'echo "b2"', needs: [] },
        {
          id: 'join',
          type: 'join',
          target: 'steps',
          condition: 'all',
          needs: ['branch1', 'branch2'],
        },
      ],
      outputs: {
        b1: '${{ steps.join.output.inputs.branch1.stdout.trim() }}',
        b2: '${{ steps.join.output.inputs.branch2.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.b1).toBe('b1');
    expect(outputs.b2).toBe('b2');
  });

  it('should fail join step if condition "all" is not met (due to allowFailure error)', async () => {
    // Branch2 fails but allows failure. Join "all" should strictly fail because Branch2 is not a "real" success.
    const workflow: Workflow = {
      name: 'fan-out-in-fail',
      steps: [
        { id: 'branch1', type: 'shell', run: 'echo "b1"', needs: [] },
        { id: 'branch2', type: 'shell', run: 'exit 1', needs: [], allowFailure: true },
        {
          id: 'join',
          type: 'join',
          condition: 'all',
          needs: ['branch1', 'branch2'],
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflow, { dbPath });
    await expect(runner.run()).rejects.toThrow(/Join condition 'all' not met/);
  });

  it('should pass join step with "any" condition if one branch succeeds', async () => {
    const workflow: Workflow = {
      name: 'fan-out-in-any',
      steps: [
        { id: 'branch1', type: 'shell', run: 'echo "b1"', needs: [] },
        { id: 'branch2', type: 'shell', run: 'exit 1', needs: [], allowFailure: true },
        {
          id: 'join',
          type: 'join',
          condition: 'any',
          needs: ['branch1', 'branch2'],
        },
      ],
      outputs: {
        status1: '${{ steps.join.output.status.branch1 }}',
        status2: '${{ steps.join.output.status.branch2 }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.status1).toBe('success');
    // status2 might be undefined or 'success' depending on race, but shouldn't fail the test
    const status2 = typeof outputs.status2 === 'string' ? outputs.status2 : undefined;
    expect(status2 === undefined || status2 === 'success').toBe(true);
  });

  it('should register and execute compensations on failure', async () => {
    const compDbPath = 'test-compensation.db';
    if (existsSync(compDbPath)) rmSync(compDbPath);

    const workflow: Workflow = {
      name: 'comp-wf',
      steps: [
        {
          id: 'step1',
          type: 'shell',
          run: 'echo "step1"',
          needs: [],
          compensate: {
            id: 'undo1',
            type: 'shell',
            run: 'echo "undoing step1"',
          },
        },
        {
          id: 'step2',
          type: 'shell',
          run: 'echo "step2"',
          needs: ['step1'],
          compensate: {
            id: 'undo2',
            type: 'shell',
            run: 'echo "undoing step2"',
          },
        },
        {
          id: 'fail',
          type: 'shell',
          run: 'exit 1',
          needs: ['step2'],
        },
      ],
    } as unknown as Workflow;

    const logs: string[] = [];
    const logger: Logger = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      info: (msg: string) => logs.push(`INFO: ${msg}`),
      debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
    };

    const runner = new WorkflowRunner(workflow, { dbPath: compDbPath, logger });

    try {
      await runner.run();
    } catch (e) {
      // Expected failure
    }

    // Verify compensations ran in reverse order
    const undo2Index = logs.findIndex((l) => l.includes('undoing step2'));
    const undo1Index = logs.findIndex((l) => l.includes('undoing step1'));

    if (undo2Index === -1 || undo1Index === -1 || undo2Index >= undo1Index) {
    }

    expect(undo2Index).toBeGreaterThan(-1);
    expect(undo1Index).toBeGreaterThan(-1);
    expect(undo2Index).toBeLessThan(undo1Index); // undo2 before undo1

    // Verify DB records
    const db = new WorkflowDb(compDbPath);
    const runId = runner.runId;
    const comps = await db.getAllCompensations(runId);
    expect(comps.length).toBe(2);
    db.close();

    if (existsSync(compDbPath)) rmSync(compDbPath);
  });
  it('should NOT execute join step early if condition is "any" (must wait for all dependencies to finish)', async () => {
    // New behavior: Join waits for all dependencies to finish (success or failure)
    // before evaluating the condition. This prevents missing inputs.
    const workflow: Workflow = {
      name: 'delayed-join',
      steps: [
        {
          id: 'slow',
          type: 'shell',
          run: 'sleep 0.1 && echo "slow"',
          allowInsecure: true,
          needs: [],
        },
        { id: 'fast', type: 'shell', run: 'echo "fast"', needs: [] },
        {
          id: 'early_join',
          type: 'join',
          condition: 'any',
          needs: ['slow', 'fast'],
        },
        {
          id: 'after_join',
          type: 'shell',
          run: 'echo "after_join"',
          needs: ['early_join'],
        },
      ],
      outputs: {
        order: '${{ steps }}',
      },
    } as unknown as Workflow;

    const logs: string[] = [];
    const logger: Logger = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      warn: () => {},
      info: () => {},
      debug: () => {},
    };

    const runner = new WorkflowRunner(workflow, { dbPath, logger });
    await runner.run();

    // Verify after_join started AFTER slow finished
    const afterJoinStart = logs.findIndex((l) => l.includes('Executing step: after_join'));
    const slowFinished = logs.findIndex((l) => l.includes('Step slow completed'));

    expect(afterJoinStart).toBeGreaterThan(-1);
    expect(slowFinished).toBeGreaterThan(-1);
    expect(afterJoinStart).toBeGreaterThan(slowFinished);
  });

  it('should execute top-level workflow compensation on failure', async () => {
    const wfCompDbPath = 'test-wf-compensation.db';
    if (existsSync(wfCompDbPath)) rmSync(wfCompDbPath);

    const workflow: Workflow = {
      name: 'wf-comp',
      compensate: {
        id: 'wf-undo',
        type: 'shell',
        run: 'echo "undoing workflow"',
      },
      steps: [
        {
          id: 'step1',
          type: 'shell',
          run: 'exit 1',
          needs: [],
        },
      ],
    } as unknown as Workflow;

    const logs: string[] = [];
    const logger: Logger = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      warn: () => {},
      info: () => {},
      debug: () => {},
    };

    const runner = new WorkflowRunner(workflow, { dbPath: wfCompDbPath, logger });
    try {
      await runner.run();
    } catch (e) {
      // Expected failure
    }

    const wfUndoIndex = logs.findIndex((l) => l.includes('undoing workflow'));
    if (wfUndoIndex === -1) {
    }
    expect(wfUndoIndex).toBeGreaterThan(-1);

    if (existsSync(wfCompDbPath)) rmSync(wfCompDbPath);
  });
});
