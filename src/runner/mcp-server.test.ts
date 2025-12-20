import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkflowDb } from '../db/workflow-db';
import { WorkflowParser } from '../parser/workflow-parser';
import { WorkflowRegistry } from '../utils/workflow-registry';
import { MCPServer } from './mcp-server';
import { WorkflowSuspendedError } from './step-executor';
import { WorkflowRunner } from './workflow-runner';

describe('MCPServer', () => {
  let db: WorkflowDb;
  let server: MCPServer;

  beforeEach(() => {
    db = new WorkflowDb(':memory:');
    server = new MCPServer(db);
    mock.restore();
  });

  const handleMessage = (msg: unknown) => {
    // @ts-ignore
    return server.handleMessage(msg);
  };

  it('should handle initialize request', async () => {
    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    expect(response?.result?.serverInfo?.name).toBe('keystone-mcp');
  });

  it('should list tools', async () => {
    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(response?.result?.tools).toHaveLength(7);
    // @ts-ignore
    expect(response?.result?.tools?.map((t) => t.name)).toContain('run_workflow');
  });

  it('should call list_workflows tool', async () => {
    spyOn(WorkflowRegistry, 'listWorkflows').mockReturnValue([
      { name: 'test-wf', description: 'Test Workflow' },
    ]);

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_workflows', arguments: {} },
    });

    expect(response?.result?.content?.[0]?.text).toContain('test-wf');
  });

  it('should call run_workflow tool successfully', async () => {
    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('test.yaml');
    // @ts-ignore
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue({
      name: 'test-wf',
      steps: [],
    });

    // Mock WorkflowRunner
    const mockRun = mock(() => Promise.resolve({ result: 'ok' }));
    // @ts-ignore
    spyOn(WorkflowRunner.prototype, 'run').mockImplementation(mockRun);

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'run_workflow',
        arguments: { workflow_name: 'test-wf', inputs: {} },
      },
    });

    expect(JSON.parse(response.result.content[0].text).status).toBe('success');
  });

  it('should handle run_workflow failure', async () => {
    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('test.yaml');
    // @ts-ignore
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue({
      name: 'test-wf',
      steps: [],
    });

    spyOn(WorkflowRunner.prototype, 'run').mockRejectedValue(new Error('workflow failed'));

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'run_workflow',
        arguments: { workflow_name: 'test-wf' },
      },
    });

    expect(response?.result?.isError).toBe(true);
    expect(response?.result?.content?.[0]?.text).toContain('Workflow failed');
  });

  it('should handle workflow suspension in run_workflow', async () => {
    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('test.yaml');
    // @ts-ignore
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue({
      name: 'test-wf',
      steps: [],
    });

    const suspendedError = new WorkflowSuspendedError('Input needed', 'step1', 'text');
    spyOn(WorkflowRunner.prototype, 'run').mockRejectedValue(suspendedError);
    spyOn(WorkflowRunner.prototype, 'getRunId').mockReturnValue('run123');

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'run_workflow',
        arguments: { workflow_name: 'test-wf' },
      },
    });

    const result = JSON.parse(response?.result?.content?.[0]?.text);
    expect(result.status).toBe('paused');
    expect(result.run_id).toBe('run123');
    expect(result.message).toBe('Input needed');
  });

  it('should handle answer_human_input and resume', async () => {
    const runId = 'run-to-resume';
    await db.createRun(runId, 'test-wf', {});
    await db.updateRunStatus(runId, 'paused');
    await db.createStep('step-exec-1', runId, 's1');

    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('test.yaml');
    // @ts-ignore
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue({
      name: 'test-wf',
      steps: [{ id: 's1', type: 'human' }],
    });

    const mockRun = mock(() => Promise.resolve({ result: 'resumed' }));
    // @ts-ignore
    spyOn(WorkflowRunner.prototype, 'run').mockImplementation(mockRun);

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'answer_human_input',
        arguments: { run_id: runId, input: 'my response' },
      },
    });

    expect(JSON.parse(response.result.content[0].text).status).toBe('success');

    // Verify DB was updated
    const steps = db.getStepsByRun(runId);
    expect(steps[0].status).toBe('success');
    expect(steps[0].output).toBeDefined();
    if (steps[0].output) {
      expect(JSON.parse(steps[0].output)).toBe('my response');
    }
  });

  it('should call get_run_logs tool with steps', async () => {
    const runId = 'test-run-with-steps';
    await db.createRun(runId, 'test-wf', {});
    await db.createStep('step-1', runId, 's1');
    await db.completeStep('step-1', 'success', { ok: true });

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_run_logs', arguments: { run_id: runId } },
    });

    const summary = JSON.parse(response?.result?.content?.[0]?.text);
    expect(summary.workflow).toBe('test-wf');
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0].step).toBe('s1');
    expect(summary.steps[0].output).toEqual({ ok: true });
  });

  it('should handle unknown tool', async () => {
    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'unknown_tool', arguments: {} },
    });

    expect(response?.error?.message).toContain('Unknown tool');
  });

  it('should handle unknown method', async () => {
    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'unknown_method',
    });

    expect(response?.error?.message).toContain('Method not found');
  });

  it('should start and handle messages from stdin', async () => {
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const outputStream = new PassThrough();

    // Create a new server for this test to use the streams
    const testServer = new MCPServer(db, input, outputStream);

    const writeSpy = spyOn(outputStream, 'write').mockImplementation(() => true);
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const startPromise = testServer.start();

    // Simulate stdin data
    const message = {
      jsonrpc: '2.0' as const,
      id: 9,
      method: 'initialize',
    };
    input.write(`${JSON.stringify(message)}\n`);

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(writeSpy).toHaveBeenCalled();
    const output = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(output.id).toBe(9);

    input.end();
    await startPromise;

    writeSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should call start_workflow tool and return immediately', async () => {
    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('test.yaml');
    // @ts-ignore
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue({
      name: 'test-wf',
      steps: [],
    });

    // Mock WorkflowRunner - simulate a slow workflow
    const mockRun = mock(
      () => new Promise((resolve) => setTimeout(() => resolve({ result: 'ok' }), 100))
    );
    // @ts-ignore
    spyOn(WorkflowRunner.prototype, 'run').mockImplementation(mockRun);
    spyOn(WorkflowRunner.prototype, 'getRunId').mockReturnValue('async-run-123');

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'start_workflow',
        arguments: { workflow_name: 'test-wf', inputs: {} },
      },
    });

    const result = JSON.parse(response?.result?.content?.[0]?.text);
    expect(result.status).toBe('running');
    expect(result.run_id).toBe('async-run-123');
    expect(result.hint).toContain('get_run_status');
  });

  it('should call get_run_status tool for running workflow', async () => {
    const runId = 'status-test-run';
    await db.createRun(runId, 'test-wf', { foo: 'bar' });
    await db.updateRunStatus(runId, 'running');

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'get_run_status', arguments: { run_id: runId } },
    });

    const status = JSON.parse(response?.result?.content?.[0]?.text);
    expect(status.run_id).toBe(runId);
    expect(status.workflow).toBe('test-wf');
    expect(status.status).toBe('running');
    expect(status.hint).toContain('still running');
  });

  it('should call get_run_status tool for completed workflow', async () => {
    const runId = 'completed-test-run';
    await db.createRun(runId, 'test-wf', {});
    await db.updateRunStatus(runId, 'completed', { output: 'done' });

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'get_run_status', arguments: { run_id: runId } },
    });

    const status = JSON.parse(response?.result?.content?.[0]?.text);
    expect(status.status).toBe('completed');
    expect(status.outputs).toEqual({ output: 'done' });
    expect(status.hint).toBeUndefined();
  });

  it('should call get_run_status tool for failed workflow', async () => {
    const runId = 'failed-test-run';
    await db.createRun(runId, 'test-wf', {});
    await db.updateRunStatus(runId, 'failed', undefined, 'Something went wrong');

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'get_run_status', arguments: { run_id: runId } },
    });

    const status = JSON.parse(response?.result?.content?.[0]?.text);
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Something went wrong');
  });

  it('should call get_run_status tool for paused workflow', async () => {
    const runId = 'paused-test-run';
    await db.createRun(runId, 'test-wf', {});
    await db.updateRunStatus(runId, 'paused');

    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'get_run_status', arguments: { run_id: runId } },
    });

    const status = JSON.parse(response?.result?.content?.[0]?.text);
    expect(status.status).toBe('paused');
    expect(status.hint).toContain('answer_human_input');
  });

  it('should return error for non-existent run in get_run_status', async () => {
    const response = await handleMessage({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'get_run_status', arguments: { run_id: 'non-existent' } },
    });

    expect(response?.error?.message).toContain('not found');
  });
});
