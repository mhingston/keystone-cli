import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { WorkflowDb } from '../db/workflow-db';
import type { Workflow } from '../parser/schema';
import { WorkflowParser } from '../parser/workflow-parser';
import { WorkflowRegistry } from '../utils/workflow-registry';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner', () => {
  const dbPath = ':memory:';

  afterAll(() => {
    if (existsSync('test-resume.db')) {
      rmSync('test-resume.db');
    }
    if (existsSync('test-foreach-resume.db')) {
      rmSync('test-foreach-resume.db');
    }
  });

  beforeEach(() => {
    mock.restore();
  });

  const workflow: Workflow = {
    name: 'test-workflow',
    steps: [
      {
        id: 'step1',
        type: 'shell',
        run: 'echo "hello"',
        needs: [],
      },
      {
        id: 'step2',
        type: 'shell',
        run: 'echo "${{ steps.step1.output.stdout.trim() }} world"',
        needs: ['step1'],
      },
    ],
    outputs: {
      final: '${{ steps.step2.output.stdout.trim() }}',
    },
  } as unknown as Workflow;

  it('should run a simple workflow successfully', async () => {
    const runner = new WorkflowRunner(workflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.final).toBe('hello world');
  });

  it('should expose workflow env to shell steps', async () => {
    const envWorkflow: Workflow = {
      name: 'env-workflow',
      inputs: {
        token: { type: 'string', default: 'env-token' },
      },
      env: {
        TOKEN: '${{ inputs.token }}',
      },
      steps: [
        {
          id: 'print',
          type: 'shell',
          run: 'echo $TOKEN',
          needs: [],
        },
      ],
      outputs: {
        token: '${{ steps.print.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(envWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.token).toBe('env-token');
  });

  it('should skip workflow env entries that fail to evaluate', async () => {
    const envWorkflow: Workflow = {
      name: 'env-skip-workflow',
      env: {
        LATER: '${{ steps.after.output.stdout.trim() }}',
      },
      steps: [
        {
          id: 'before',
          type: 'shell',
          run: 'echo "start"',
          needs: [],
        },
        {
          id: 'after',
          type: 'shell',
          run: 'echo "later"',
          needs: ['before'],
        },
      ],
      outputs: {
        first: '${{ steps.before.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(envWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.first).toBe('start');
  });

  it('should handle foreach steps', async () => {
    const foreachWorkflow: Workflow = {
      name: 'foreach-workflow',
      steps: [
        {
          id: 'gen',
          type: 'shell',
          run: 'echo "[1, 2, 3]"',
          transform: 'JSON.parse(output.stdout)',
          needs: [],
        },
        {
          id: 'process',
          type: 'shell',
          run: 'echo "item-${{ item }}"',
          foreach: '${{ steps.gen.output }}',
          needs: ['gen'],
        },
      ],
      outputs: {
        results: '${{ steps.process.output.map(o => o.stdout.trim()) }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(foreachWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.results).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('should handle skip conditions', async () => {
    const skipWorkflow: Workflow = {
      name: 'skip-workflow',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo 1',
          if: '${{ false }}',
          needs: [],
        },
        {
          id: 's2',
          type: 'shell',
          run: 'echo 2',
          needs: ['s1'],
        },
      ],
      outputs: {
        s1_status: '${{ steps.s1.status }}',
      },
    } as unknown as Workflow;
    const runner = new WorkflowRunner(skipWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.s1_status).toBe('skipped');
  });

  it('should execute finally block', async () => {
    let finallyExecuted = false;
    const runnerLogger = {
      log: (msg: string) => {
        if (msg.includes('Finally step fin completed')) {
          finallyExecuted = true;
        }
      },
      error: (msg: string) => console.error(msg),
      warn: (msg: string) => console.warn(msg),
      info: (msg: string) => {},
      debug: (msg: string) => {},
    };

    const finallyWorkflow: Workflow = {
      name: 'finally-workflow',
      steps: [{ id: 's1', type: 'shell', run: 'echo 1', needs: [] }],
      finally: [{ id: 'fin', type: 'shell', run: 'echo finally', needs: [] }],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(finallyWorkflow, { dbPath, logger: runnerLogger });
    await runner.run();
    expect(finallyExecuted).toBe(true);
  });

  it('should apply defaults and validate inputs', async () => {
    const workflowWithInputs: Workflow = {
      name: 'input-wf',
      inputs: {
        name: { type: 'string', default: 'Keystone' },
        count: { type: 'number' },
      },
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "${{ inputs.name }} ${{ inputs.count }}"',
          needs: [],
        },
      ],
    } as unknown as Workflow;

    const runner1 = new WorkflowRunner(workflowWithInputs, { dbPath, inputs: {} });
    await expect(runner1.run()).rejects.toThrow(/Missing required input: count/);

    const runner2 = new WorkflowRunner(workflowWithInputs, { dbPath, inputs: { count: 10 } });
    const outputs = await runner2.run();
    expect(outputs).toBeDefined();
  });

  it('should handle step failure and workflow failure', async () => {
    const failWorkflow: Workflow = {
      name: 'fail-wf',
      steps: [{ id: 'fail', type: 'shell', run: 'exit 1', needs: [] }],
    } as unknown as Workflow;
    const runner = new WorkflowRunner(failWorkflow, { dbPath });
    await expect(runner.run()).rejects.toThrow(/Step fail failed/);
  });

  it('should execute steps in parallel', async () => {
    const parallelWorkflow: Workflow = {
      name: 'parallel-wf',
      steps: [
        { id: 's1', type: 'sleep', duration: 100, needs: [] },
        { id: 's2', type: 'sleep', duration: 100, needs: [] },
      ],
      outputs: {
        done: 'true',
      },
    } as unknown as Workflow;

    const start = Date.now();
    const runner = new WorkflowRunner(parallelWorkflow, { dbPath });
    await runner.run();
    const duration = Date.now() - start;

    // If sequential, it would take > 200ms. If parallel, it should take ~100ms.
    // We use a safe buffer.
    expect(duration).toBeLessThan(180);
    expect(duration).toBeGreaterThanOrEqual(100);
  });

  it('should handle sub-workflows', async () => {
    const childWorkflow: Workflow = {
      name: 'child-wf',
      inputs: {
        val: { type: 'string' },
      },
      steps: [{ id: 'cs1', type: 'shell', run: 'echo "child-${{ inputs.val }}"', needs: [] }],
      outputs: {
        out: '${{ steps.cs1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const parentWorkflow: Workflow = {
      name: 'parent-wf',
      steps: [
        {
          id: 'sub',
          type: 'workflow',
          path: 'child.yaml',
          inputs: { val: 'test' },
          needs: [],
        },
      ],
      outputs: {
        final: '${{ steps.sub.output.out }}',
      },
    } as unknown as Workflow;

    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('child.yaml');
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue(childWorkflow);

    const runner = new WorkflowRunner(parentWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.final).toBe('child-test');
  });

  it('should resume a failed workflow', async () => {
    const resumeDbPath = 'test-resume.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'resume-wf',
      steps: [
        { id: 's1', type: 'shell', run: 'echo "one"', needs: [] },
        { id: 's2', type: 'shell', run: 'exit 1', needs: ['s1'] },
      ],
    } as unknown as Workflow;

    const runner1 = new WorkflowRunner(workflow, { dbPath: resumeDbPath });
    let runId = '';
    try {
      await runner1.run();
    } catch (e) {
      // @ts-ignore
      runId = runner1.runId;
    }

    expect(runId).not.toBe('');

    // "Fix" the workflow for the second run
    const fixedWorkflow: Workflow = {
      name: 'resume-wf',
      steps: [
        { id: 's1', type: 'shell', run: 'echo "one"', needs: [] },
        { id: 's2', type: 'shell', run: 'echo "two"', needs: ['s1'] },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}-${{ steps.s2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    let s1Executed = false;
    const logger = {
      log: (msg: string) => {
        if (msg.includes('Executing step: s1')) s1Executed = true;
      },
      error: () => {},
      warn: () => {},
    };

    const runner2 = new WorkflowRunner(fixedWorkflow, {
      dbPath: resumeDbPath,
      resumeRunId: runId,
      // @ts-ignore
      logger: logger,
    });
    const outputs = await runner2.run();

    expect(outputs.out).toBe('one-two');
    expect(s1Executed).toBe(false); // Should have been skipped
  });

  it('should merge resumeInputs with stored inputs on resume', async () => {
    const resumeDbPath = 'test-merge-inputs.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'merge-wf',
      inputs: {
        initial: { type: 'string' },
        resumed: { type: 'string' },
      },
      steps: [{ id: 's1', type: 'shell', run: 'exit 1', needs: [] }],
      outputs: {
        merged: '${{ inputs.initial }}-${{ inputs.resumed }}',
      },
    } as unknown as Workflow;

    const runner1 = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      inputs: { initial: 'first', resumed: 'pending' },
    });

    let runId = '';
    try {
      await runner1.run();
    } catch (e) {
      runId = runner1.getRunId();
    }

    const fixedWorkflow: Workflow = {
      ...workflow,
      steps: [{ id: 's1', type: 'shell', run: 'echo ok', needs: [] }],
    } as unknown as Workflow;

    const runner2 = new WorkflowRunner(fixedWorkflow, {
      dbPath: resumeDbPath,
      resumeRunId: runId,
      resumeInputs: { resumed: 'second' },
    });

    const outputs = await runner2.run();
    expect(outputs.merged).toBe('first-second');

    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);
  });

  it('should redact secrets from outputs', async () => {
    const workflow: Workflow = {
      name: 'redaction-wf',
      steps: [{ id: 's1', type: 'shell', run: 'echo "Secret is my-super-secret"', needs: [] }],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    // @ts-ignore
    spyOn(WorkflowRunner.prototype, 'loadSecrets').mockReturnValue({
      MY_SECRET: 'my-super-secret',
    });

    const runner = new WorkflowRunner(workflow, { dbPath });
    await runner.run();

    expect(runner.redact('my-super-secret')).toBe('***REDACTED***');
  });

  it('should return run ID', () => {
    const runner = new WorkflowRunner(workflow, { dbPath });
    expect(runner.getRunId()).toBeDefined();
    expect(typeof runner.getRunId()).toBe('string');
  });

  it('should continue even if finally step fails', async () => {
    let finallyFailedLogged = false;
    const runnerLogger = {
      log: () => {},
      error: (msg: string) => {
        if (msg.includes('Finally step fin failed')) {
          finallyFailedLogged = true;
        }
      },
      warn: () => {},
    };

    const failFinallyWorkflow: Workflow = {
      name: 'fail-finally-workflow',
      steps: [{ id: 's1', type: 'shell', run: 'echo 1', needs: [] }],
      finally: [{ id: 'fin', type: 'shell', run: 'exit 1', needs: [] }],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(failFinallyWorkflow, { dbPath, logger: runnerLogger });
    await runner.run();
    expect(finallyFailedLogged).toBe(true);
  });

  it('should retry failed steps', async () => {
    let retryLogged = false;
    const runnerLogger = {
      log: (msg: string) => {
        if (msg.includes('Retry 1/1 for step fail')) {
          retryLogged = true;
        }
      },
      error: () => {},
      warn: () => {},
    };

    const retryWorkflow: Workflow = {
      name: 'retry-workflow',
      steps: [
        {
          id: 'fail',
          type: 'shell',
          run: 'exit 1',
          retry: { count: 1, backoff: 'linear' },
          needs: [],
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(retryWorkflow, { dbPath, logger: runnerLogger });
    try {
      await runner.run();
    } catch (e) {
      // Expected to fail
    }
    expect(retryLogged).toBe(true);
  });

  it('should handle foreach suspension and resume correctly', async () => {
    const resumeDbPath = 'test-foreach-resume.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'foreach-suspend-wf',
      steps: [
        {
          id: 'gen',
          type: 'shell',
          run: 'echo "[1, 2]"',
          transform: 'JSON.parse(output.stdout)',
          needs: [],
        },
        {
          id: 'process',
          type: 'human',
          message: 'Item ${{ item }}',
          foreach: '${{ steps.gen.output }}',
          needs: ['gen'],
        },
      ],
      outputs: {
        results: '${{ steps.process.output }}',
      },
    } as unknown as Workflow;

    // First run - should suspend
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    const runner1 = new WorkflowRunner(workflow, { dbPath: resumeDbPath });
    let suspendedError: unknown;
    try {
      await runner1.run();
    } catch (e) {
      suspendedError = e;
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(suspendedError).toBeDefined();
    expect(
      typeof suspendedError === 'object' && suspendedError !== null && 'name' in suspendedError
        ? (suspendedError as { name: string }).name
        : undefined
    ).toBe('WorkflowSuspendedError');

    const runId = runner1.getRunId();

    // Check DB status - parent should be 'paused' and step should be 'suspended'
    const db = new WorkflowDb(resumeDbPath);
    const run = await db.getRun(runId);
    expect(run?.status).toBe('paused');

    const steps = await db.getStepsByRun(runId);
    const parentStep = steps.find(
      (s: { step_id: string; iteration_index: number | null }) =>
        s.step_id === 'process' && s.iteration_index === null
    );
    expect(parentStep?.status).toBe('suspended');
    db.close();

    // Second run - resume with answers
    const runner2 = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      resumeRunId: runId,
      resumeInputs: {
        process: { __answer: 'ok' },
      },
    });

    const outputs = await runner2.run();
    expect(outputs.results).toEqual(['ok', 'ok']);

    const finalDb = new WorkflowDb(resumeDbPath);
    const finalRun = await finalDb.getRun(runId);
    expect(finalRun?.status).toBe('success');
    finalDb.close();

    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);
  });

  it('should resume a workflow marked as running (crashed process)', async () => {
    const resumeDbPath = 'test-running-resume.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'running-wf',
      steps: [
        { id: 's1', type: 'shell', run: 'echo "one"', needs: [] },
        { id: 's2', type: 'shell', run: 'echo "two"', needs: ['s1'] },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}-${{ steps.s2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    // Manually create a "running" state in the DB
    const db = new WorkflowDb(resumeDbPath);
    const runId = crypto.randomUUID();
    await db.createRun(runId, workflow.name, {});
    await db.updateRunStatus(runId, 'running');

    // Create a completed step 1
    const step1Id = crypto.randomUUID();
    await db.createStep(step1Id, runId, 's1');
    await db.completeStep(step1Id, 'success', { stdout: 'one\n', stderr: '', exitCode: 0 });
    db.close();

    // Verify warnings
    let warningLogged = false;
    const logger = {
      log: () => {},
      error: () => {},
      warn: (msg: string) => {
        if (msg.includes("Resuming a run marked as 'running'")) {
          warningLogged = true;
        }
      },
      info: () => {},
      debug: () => {},
    };

    const runner = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      resumeRunId: runId,
      // @ts-ignore
      logger: logger,
    });

    const outputs = await runner.run();
    expect(outputs.out).toBe('one-two');
    expect(warningLogged).toBe(true);

    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);
  });
});
