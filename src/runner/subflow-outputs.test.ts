import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Workflow } from '../parser/schema';
import { WorkflowParser } from '../parser/workflow-parser';
import { WorkflowRegistry } from '../utils/workflow-registry';
import { WorkflowRunner } from './workflow-runner';

describe('Sub-workflow Output Mapping and Contracts', () => {
  const dbPath = ':memory:';

  it('should support workflow output schema validation', async () => {
    const workflow: Workflow = {
      name: 'contract-wf',
      steps: [{ id: 's1', type: 'shell', run: 'echo "hello"', needs: [] }],
      outputs: {
        val: '${{ steps.s1.output.stdout.trim() }}',
      },
      outputSchema: {
        type: 'object',
        properties: {
          val: { type: 'number' }, // Should fail because it's a string
        },
        required: ['val'],
      },
    } as unknown as Workflow;

    const runner = new WorkflowRunner(workflow, { dbPath });
    await expect(runner.run()).rejects.toThrow(/Workflow output validation failed/);
  });

  it('should support namespacing and explicit mapping for sub-workflows', async () => {
    const childWorkflow: Workflow = {
      name: 'child-wf',
      steps: [
        { id: 'cs1', type: 'shell', run: 'echo "v1"', needs: [] },
        { id: 'cs2', type: 'shell', run: 'echo "v2"', needs: [] },
      ],
      outputs: {
        foo: '${{ steps.cs1.output.stdout.trim() }}',
        bar: '${{ steps.cs2.output.stdout.trim() }}',
      },
    } as unknown as Workflow;

    const parentWorkflow: Workflow = {
      name: 'parent-wf',
      steps: [
        {
          id: 'sub',
          type: 'workflow',
          path: 'child.yaml',
          needs: [],
          outputMapping: {
            mappedFoo: 'foo',
            withDefault: { from: 'missing', default: 'fallback' },
          },
        },
      ],
      outputs: {
        foo: '${{ steps.sub.output.mappedFoo }}',
        rawFoo: '${{ steps.sub.output.outputs.foo }}',
        def: '${{ steps.sub.output.withDefault }}',
      },
    } as unknown as Workflow;

    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('child.yaml');
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue(childWorkflow);

    const runner = new WorkflowRunner(parentWorkflow, { dbPath });
    const outputs = await runner.run();

    expect(outputs.foo).toBe('v1');
    expect(outputs.rawFoo).toBe('v1');
    expect(outputs.def).toBe('fallback');
  });

  it('should fail if mapped output is missing and no default is provided', async () => {
    const childWorkflow: Workflow = {
      name: 'child-wf',
      steps: [{ id: 'cs1', type: 'shell', run: 'echo "ok"', needs: [] }],
      outputs: { ok: 'true' },
    } as unknown as Workflow;

    const parentWorkflow: Workflow = {
      name: 'parent-wf',
      steps: [
        {
          id: 'sub',
          type: 'workflow',
          path: 'child.yaml',
          needs: [],
          outputMapping: {
            missing: 'nonexistent',
          },
        },
      ],
    } as unknown as Workflow;

    spyOn(WorkflowRegistry, 'resolvePath').mockReturnValue('child.yaml');
    spyOn(WorkflowParser, 'loadWorkflow').mockReturnValue(childWorkflow);

    const runner = new WorkflowRunner(parentWorkflow, { dbPath });
    await expect(runner.run()).rejects.toThrow(/Sub-workflow output "nonexistent" not found/);
  });
});
