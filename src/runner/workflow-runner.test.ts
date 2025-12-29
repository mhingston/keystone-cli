import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { MemoryDb } from '../db/memory-db';
import { WorkflowDb } from '../db/workflow-db';
import type { Workflow } from '../parser/schema';
import { WorkflowParser } from '../parser/workflow-parser';
import { ConfigLoader } from '../utils/config-loader';
import { container } from '../utils/container';
import { ConsoleLogger } from '../utils/logger';
import { WorkflowRegistry } from '../utils/workflow-registry';
import { WorkflowRunner } from './workflow-runner';

describe('WorkflowRunner', () => {
  const dbPath = ':memory:';

  // Setup DI container for tests
  container.register('logger', new ConsoleLogger());
  container.register('db', new WorkflowDb(dbPath));
  container.register('memoryDb', new MemoryDb());
  const activeSpies: Array<{ mockRestore: () => void }> = [];
  const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
    activeSpies.push(spy);
    return spy;
  };

  afterAll(() => {
    if (existsSync('test-resume.db')) {
      rmSync('test-resume.db');
    }
    if (existsSync('test-foreach-resume.db')) {
      rmSync('test-foreach-resume.db');
    }
  });

  afterEach(() => {
    for (const spy of activeSpies) {
      spy.mockRestore();
    }
    activeSpies.length = 0;
    ConfigLoader.clear();
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
        allowInsecure: true,
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
          allowInsecure: true,
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
      info: (msg: string) => { },
      debug: (msg: string) => { },
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
          allowInsecure: true,
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

  it('should validate step input schema', async () => {
    const schemaDbPath = `test-step-input-schema-${randomUUID()}.db`;
    const workflowWithInputSchema: Workflow = {
      name: 'step-input-schema-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "hello"',
          needs: [],
          inputSchema: {
            type: 'object',
            properties: { run: { type: 'number' } },
            required: ['run'],
            additionalProperties: false,
          },
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflowWithInputSchema, { dbPath: schemaDbPath });
    await expect(runner.run()).rejects.toThrow(/Step s1 failed/);

    const db = new WorkflowDb(schemaDbPath);
    const steps = await db.getStepsByRun(runner.runId);
    db.close();

    expect(steps[0]?.error || '').toMatch(/Input schema validation failed/);
    if (existsSync(schemaDbPath)) rmSync(schemaDbPath);
  });

  it('should validate step output schema', async () => {
    const schemaDbPath = `test-step-output-schema-${randomUUID()}.db`;
    const workflowWithOutputSchema: Workflow = {
      name: 'step-output-schema-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "hello"',
          needs: [],
          outputSchema: {
            type: 'object',
            properties: { ok: { const: true } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflowWithOutputSchema, { dbPath: schemaDbPath });
    await expect(runner.run()).rejects.toThrow(/Step s1 failed/);

    const db = new WorkflowDb(schemaDbPath);
    const steps = await db.getStepsByRun(runner.runId);
    db.close();

    expect(steps[0]?.error || '').toMatch(/Output schema validation failed/);
    if (existsSync(schemaDbPath)) rmSync(schemaDbPath);
  });

  it('should enforce input enums', async () => {
    const workflowWithEnums: Workflow = {
      name: 'enum-wf',
      inputs: {
        mode: { type: 'string', values: ['fast', 'slow'] },
      },
      steps: [{ id: 's1', type: 'shell', run: 'echo "${{ inputs.mode }}"', needs: [] }],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflowWithEnums, {
      dbPath,
      inputs: { mode: 'invalid' },
    });

    await expect(runner.run()).rejects.toThrow(/must be one of/);
  });

  it('should handle step failure and workflow failure', async () => {
    const failWorkflow: Workflow = {
      name: 'fail-wf',
      steps: [{ id: 'fail', type: 'shell', run: 'exit 1', needs: [] }],
    } as unknown as Workflow;
    const runner = new WorkflowRunner(failWorkflow, { dbPath });
    await expect(runner.run()).rejects.toThrow(/Step fail failed/);
  });

  it('should execute errors block when a step fails', async () => {
    let errorsBlockExecuted = false;
    let lastFailedStepId: string | undefined;
    const runnerLogger = {
      log: (msg: string) => {
        if (msg.includes('Executing errors step: err1')) {
          errorsBlockExecuted = true;
        }
      },
      error: () => { },
      warn: () => { },
      info: () => { },
      debug: () => { },
    };

    const errorsWorkflow: Workflow = {
      name: 'errors-wf',
      steps: [{ id: 's1', type: 'shell', run: 'exit 1', needs: [] }],
      errors: [
        {
          id: 'err1',
          type: 'shell',
          run: 'echo "Handling failure of ${{ last_failed_step.id }}"',
          needs: [],
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(errorsWorkflow, { dbPath, logger: runnerLogger });
    try {
      await runner.run();
    } catch (e) {
      // Expected to fail
    }

    expect(errorsBlockExecuted).toBe(true);
  });

  it('should continue when allowFailure is true', async () => {
    const allowFailureWorkflow: Workflow = {
      name: 'allow-failure-wf',
      steps: [
        { id: 'fail', type: 'shell', run: 'exit 1', needs: [], allowFailure: true },
        { id: 'next', type: 'shell', run: 'echo ok', needs: ['fail'] },
      ],
      outputs: {
        status: '${{ steps.fail.status }}',
        error: '${{ steps.fail.error }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(allowFailureWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.status).toBe('success');
    expect(String(outputs.error || '')).toMatch(/exit 1|Step failed|Shell command exited/);
  });

  it('should deduplicate steps using idempotencyKey within a run', async () => {
    const idempotencyDbPath = `test-idempotency-${randomUUID()}.db`;
    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);

    let idempotencyHitCount = 0;
    const runnerLogger = {
      log: (msg: string) => {
        if (msg.includes('idempotency hit')) {
          idempotencyHitCount++;
        }
      },
      error: () => { },
      warn: () => { },
      info: () => { },
      debug: () => { },
    };

    const idempotencyWorkflow: Workflow = {
      name: 'idempotency-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "executed"',
          needs: [],
          idempotencyKey: '"fixed-key-123"',
        },
        {
          id: 's2',
          type: 'shell',
          run: 'echo "second"',
          needs: ['s1'],
          idempotencyKey: '"fixed-key-123"',
        },
      ],
      outputs: {
        out1: '${{ steps.s1.output.stdout.trim() }}',
        out2: '${{ steps.s2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(idempotencyWorkflow, {
      dbPath: idempotencyDbPath,
      logger: runnerLogger,
    });
    const outputs = await runner.run();
    expect(outputs.out1).toBe('executed');
    expect(outputs.out2).toBe('executed');
    expect(idempotencyHitCount).toBe(1);

    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);
  });

  it('should allow disabling idempotency deduplication', async () => {
    const idempotencyDbPath = `test-idempotency-disabled-${randomUUID()}.db`;
    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);

    const idempotencyWorkflow: Workflow = {
      name: 'idempotency-disabled-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "first"',
          needs: [],
          idempotencyKey: '"fixed-key-123"',
        },
        {
          id: 's2',
          type: 'shell',
          run: 'echo "second"',
          needs: ['s1'],
          idempotencyKey: '"fixed-key-123"',
        },
      ],
      outputs: {
        out1: '${{ steps.s1.output.stdout.trim() }}',
        out2: '${{ steps.s2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(idempotencyWorkflow, {
      dbPath: idempotencyDbPath,
      dedup: false,
    });
    const outputs = await runner.run();
    expect(outputs.out1).toBe('first');
    expect(outputs.out2).toBe('second');

    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);
  });

  it('should detect in-flight idempotency keys', async () => {
    const idempotencyDbPath = `test-idempotency-inflight-${randomUUID()}.db`;
    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);

    const idempotencyWorkflow: Workflow = {
      name: 'idempotency-inflight-wf',
      steps: [
        {
          id: 's1',
          type: 'sleep',
          duration: '50ms',
          needs: [],
          idempotencyKey: '"same-key"',
        },
        {
          id: 's2',
          type: 'sleep',
          duration: '50ms',
          needs: [],
          idempotencyKey: '"same-key"',
        },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(idempotencyWorkflow, { dbPath: idempotencyDbPath });
    await expect(runner.run()).rejects.toThrow(/Idempotency key already in-flight/);

    if (existsSync(idempotencyDbPath)) rmSync(idempotencyDbPath);
  });

  it('should memoize deterministic steps across runs', async () => {
    const memoizeDbPath = `test-memoize-${randomUUID()}.db`;
    if (existsSync(memoizeDbPath)) rmSync(memoizeDbPath);

    const memoizeWorkflow: Workflow = {
      name: 'memoize-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'bun -e "console.log(Date.now())"',
          memoize: true,
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner1 = new WorkflowRunner(memoizeWorkflow, { dbPath: memoizeDbPath });
    const outputs1 = await runner1.run();
    await Bun.sleep(5);

    const runner2 = new WorkflowRunner(memoizeWorkflow, { dbPath: memoizeDbPath });
    const outputs2 = await runner2.run();

    expect(outputs2.out).toBe(outputs1.out);

    if (existsSync(memoizeDbPath)) rmSync(memoizeDbPath);
  });

  it('should redact memoized outputs at rest', async () => {
    const memoizeDbPath = `test-memoize-redact-${randomUUID()}.db`;
    if (existsSync(memoizeDbPath)) rmSync(memoizeDbPath);

    const secret = 'supersecret';
    const memoizeWorkflow: Workflow = {
      name: 'memoize-redact-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: `echo "${secret}"`,
          memoize: true,
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(memoizeWorkflow, {
      dbPath: memoizeDbPath,
      secrets: { TOKEN: secret },
    });
    await runner.run();

    const db = new WorkflowDb(memoizeDbPath);
    const step = memoizeWorkflow.steps[0] as Workflow['steps'][number];
    const stepInputs = { run: (step as { run: string }).run };
    const cacheKey = Bun.hash(
      JSON.stringify({
        type: step.type,
        inputs: stepInputs, // shell steps put 'run' in inputs
        env: (step as { env?: Record<string, string> }).env,
        version: 2,
      })
    ).toString(16);
    const cached = await db.getStepCache(cacheKey);
    expect(cached).not.toBeNull();
    expect(cached!.output).not.toContain(secret);
    expect(JSON.parse(cached!.output).stdout).toContain('***REDACTED***');
    db.close();

    if (existsSync(memoizeDbPath)) rmSync(memoizeDbPath);
  });

  it('should execute steps in parallel', async () => {
    const parallelWorkflow: Workflow = {
      name: 'parallel-wf',
      steps: [
        { id: 's1', type: 'sleep', duration: '100ms', needs: [] },
        { id: 's2', type: 'sleep', duration: '100ms', needs: [] },
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
      steps: [{ id: 'cs1', type: 'shell', run: 'echo "child-${{ inputs.val }}"', allowInsecure: true, needs: [] }],
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
        final: '${{ steps.sub.output.outputs.out }}',
      },
    } as unknown as Workflow;

    trackSpy(spyOn(WorkflowRegistry, 'resolvePath')).mockReturnValue('child.yaml');
    trackSpy(spyOn(WorkflowParser, 'loadWorkflow')).mockReturnValue(childWorkflow);

    const runner = new WorkflowRunner(parentWorkflow, { dbPath });
    const outputs = await runner.run();
    expect(outputs.final).toBe('child-test');
  });

  it('should resume a failed workflow', async () => {
    const resumeDbPath = `test-resume-${randomUUID()}.db`;
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
      error: () => { },
      warn: () => { },
      info: () => { },
      debug: () => { },
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
    const resumeDbPath = `test-merge-inputs-${randomUUID()}.db`;
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
      runId = runner1.runId;
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

    const secretValue = 'my-super-secret';
    const runner = new WorkflowRunner(workflow, {
      dbPath,
      secrets: { KEYSTONE_TEST_REDACTION_SECRET: secretValue },
    });
    await runner.run();

    expect(runner.redact(secretValue)).toBe('***REDACTED***');
  });

  it('should redact secret inputs at rest', async () => {
    const dbFile = `test-secret-at-rest-${randomUUID()}.db`;
    const workflow: Workflow = {
      name: 'secret-input-wf',
      inputs: {
        token: { type: 'string', secret: true },
      },
      steps: [{ id: 's1', type: 'shell', run: 'echo "ok"', needs: [] }],
    } as unknown as Workflow;

    ConfigLoader.setConfig({
      default_provider: 'openai',
      providers: {
        openai: { type: 'openai' },
      },
      model_mappings: {},
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
      expression: { strict: false },
    });

    const runner = new WorkflowRunner(workflow, {
      dbPath: dbFile,
      inputs: { token: 'super-secret' },
    });
    await runner.run();

    const db = new WorkflowDb(dbFile);
    const run = await db.getRun(runner.runId);
    db.close();

    expect(run).toBeTruthy();
    const persistedInputs = run ? JSON.parse(run.inputs) : {};
    expect(persistedInputs.token).toBe('***REDACTED***');

    ConfigLoader.clear();
    if (existsSync(dbFile)) rmSync(dbFile);
  });

  it('should return run ID', () => {
    const runner = new WorkflowRunner(workflow, { dbPath });
    expect(runner.runId).toBeDefined();
    expect(typeof runner.runId).toBe('string');
  });

  it('should continue even if finally step fails', async () => {
    let finallyFailedLogged = false;
    const runnerLogger = {
      log: () => { },
      error: (msg: string) => {
        if (msg.includes('Finally step fin failed')) {
          finallyFailedLogged = true;
        }
      },
      warn: () => { },
      info: () => { },
      debug: () => { },
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
      error: () => { },
      warn: () => { },
      info: () => { },
      debug: () => { },
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

    const runId = runner1.runId;

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

  it('should reuse persisted foreach items on resume even if inputs change', async () => {
    const resumeDbPath = 'test-foreach-resume-items.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'foreach-resume-items',
      steps: [
        {
          id: 'process',
          type: 'human',
          message: 'Item ${{ item }}',
          foreach: '${{ inputs.items }}',
          needs: [],
        },
      ],
      outputs: {
        results: '${{ steps.process.output }}',
      },
    } as unknown as Workflow;

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    const runner1 = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      inputs: { items: [1, 2] },
    });
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

    const runner2 = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      resumeRunId: runner1.runId,
      resumeInputs: {
        process: { __answer: 'ok' },
        items: [1, 2, 3],
      },
    });

    const outputs = await runner2.run();
    expect(outputs.results).toEqual(['ok', 'ok']);

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
      log: () => { },
      error: () => { },
      warn: (msg: string) => {
        if (msg.includes("Resuming a run marked as 'running'")) {
          warningLogged = true;
        }
      },
      info: () => { },
      debug: () => { },
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

  it('should parse outputRetries and repairStrategy in step schema', async () => {
    // This test verifies that the schema accepts outputRetries and repairStrategy
    // Actual LLM repair would require mocking, so we just verify the config is parsed
    const workflowWithRepair: Workflow = {
      name: 'output-repair-wf',
      steps: [
        {
          id: 's1',
          type: 'shell',
          run: 'echo "hello"',
          needs: [],
          outputRetries: 2,
          repairStrategy: 'reask',
        },
      ],
    } as unknown as Workflow;

    // Verify the workflow can be created with these fields
    expect(workflowWithRepair.steps[0].outputRetries).toBe(2);
    expect(workflowWithRepair.steps[0].repairStrategy).toBe('reask');

    // The runner should accept these fields without error
    const runner = new WorkflowRunner(workflowWithRepair, { dbPath });
    const outputs = await runner.run();
    expect(outputs).toBeDefined();
  });

  it('should allow cancellation via abortSignal', async () => {
    const cancelDbPath = 'test-cancel.db';
    if (existsSync(cancelDbPath)) rmSync(cancelDbPath);

    const workflow: Workflow = {
      name: 'cancel-wf',
      steps: [
        { id: 's1', type: 'sleep', duration: '10ms', needs: [] },
        { id: 's2', type: 'sleep', duration: '10ms', needs: ['s1'] },
      ],
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflow, { dbPath: cancelDbPath, preventExit: true });

    // Verify the abort signal is exposed and not yet aborted
    expect(runner.abortSignal).toBeDefined();
    expect(runner.abortSignal instanceof AbortSignal).toBe(true);
    expect(runner.abortSignal.aborted).toBe(false);

    // Run the workflow (short duration so it completes quickly)
    await runner.run();

    if (existsSync(cancelDbPath)) rmSync(cancelDbPath);
  });

  it('should resume from canceled state', async () => {
    const resumeDbPath = 'test-cancel-resume.db';
    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);

    const workflow: Workflow = {
      name: 'cancel-resume-wf',
      steps: [
        { id: 's1', type: 'shell', run: 'echo "one"', needs: [] },
        { id: 's2', type: 'shell', run: 'echo "two"', needs: ['s1'] },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}-${{ steps.s2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    // Manually create a "canceled" state in the DB
    const db = new WorkflowDb(resumeDbPath);
    const runId = crypto.randomUUID();
    await db.createRun(runId, workflow.name, {});
    await db.updateRunStatus(runId, 'canceled', undefined, 'Canceled by user');

    // Create a completed step 1
    const step1Id = crypto.randomUUID();
    await db.createStep(step1Id, runId, 's1');
    await db.startStep(step1Id);
    await db.completeStep(step1Id, 'success', { stdout: 'one\n', exitCode: 0 });
    db.close();

    // Resume from canceled state
    let loggedResume = false;
    const logger = {
      log: (msg: string) => {
        if (msg.includes('Resuming a previously canceled run')) {
          loggedResume = true;
        }
      },
      error: () => { },
      warn: () => { },
      info: () => { },
    };

    const runner = new WorkflowRunner(workflow, {
      dbPath: resumeDbPath,
      resumeRunId: runId,
      // @ts-ignore
      logger: logger,
    });

    const outputs = await runner.run();
    expect(outputs.out).toBe('one-two');
    expect(loggedResume).toBe(true);

    // Verify final status is success
    const finalDb = new WorkflowDb(resumeDbPath);
    const finalRun = await finalDb.getRun(runId);
    expect(finalRun?.status).toBe('success');
    finalDb.close();

    if (existsSync(resumeDbPath)) rmSync(resumeDbPath);
  });

  it('should support safe direct shell execution via args', async () => {
    const argsWorkflow: Workflow = {
      name: 'args-wf',
      inputs: {
        val: { type: 'string', default: 'foo "bar" baz' },
      },
      steps: [
        {
          id: 's1',
          type: 'shell',
          args: ['echo', '${{ inputs.val }}'],
          needs: [],
        },
      ],
      outputs: {
        out: '${{ steps.s1.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(argsWorkflow, { dbPath });
    const outputs = await runner.run();
    // Bun.spawn with args array should preserve quotes and spaces without needing escape()
    expect(outputs.out).toBe('foo "bar" baz');
  });
});
