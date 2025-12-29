import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { MemoryDb } from '../db/memory-db';
import { WorkflowDb } from '../db/workflow-db';
import type { Workflow } from '../parser/schema';
import { container } from '../utils/container';
import { ConsoleLogger } from '../utils/logger';
import { WorkflowRunner } from './workflow-runner';

describe('Workflow Memoization Leak (Args Check)', () => {
  const dbPath = 'test-memoization-leak.db';

  container.register('logger', new ConsoleLogger());
  container.register('db', new WorkflowDb(dbPath));
  container.register('memoryDb', new MemoryDb());

  afterEach(() => {
    if (existsSync(dbPath)) {
      rmSync(dbPath);
    }
  });

  it('should NOT collide for shell steps with same command but different args', async () => {
    const workflow: Workflow = {
      name: 'memoize-args-wf',
      inputs: {
        arg: { type: 'string' },
      },
      steps: [
        {
          id: 's1',
          type: 'shell',
          args: ['echo', '${{ inputs.arg }}'],
          allowInsecure: true,
          memoize: true,
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    let executeCount = 0;
    const trackedExecuteStep = async (step: any, context: any, logger: any, options: any) => {
      if (step.id === 's1') executeCount++;
      const { executeStep } = await import('./step-executor');
      return executeStep(step, context, logger, options);
    };

    // Run 1: arg=A
    const runner1 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { arg: 'A' },
      executeStep: trackedExecuteStep,
    });
    const out1 = await runner1.run();
    expect(out1.out).toBe('A');
    expect(executeCount).toBe(1);

    // Run 2: arg=A -> Cache Hit
    const runner2 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { arg: 'A' },
      executeStep: trackedExecuteStep,
    });
    executeCount = 0;
    const out2 = await runner2.run();
    expect(out2.out).toBe('A');
    expect(executeCount).toBe(0); // Memoized

    // Run 3: arg=B -> Execute (Must not collide with A)
    const runner3 = new WorkflowRunner(workflow, {
      dbPath,
      inputs: { arg: 'B' },
      executeStep: trackedExecuteStep,
    });
    executeCount = 0;
    const out3 = await runner3.run();
    expect(out3.out).toBe('B');
    expect(executeCount).toBe(1); // Should execute because args are different!
  });
});
