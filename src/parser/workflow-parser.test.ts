import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from './schema';
import { WorkflowParser } from './workflow-parser';

describe('WorkflowParser', () => {
  const tempDir = join(process.cwd(), 'temp-test-workflows');
  try {
    mkdirSync(tempDir, { recursive: true });
  } catch (e) {
    // Ignore existing dir error
  }

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup error
    }
  });
  describe('topologicalSort', () => {
    test('should sort simple dependencies', () => {
      const workflow = {
        steps: [
          { id: 'step1', type: 'shell', run: 'echo 1', needs: [] },
          { id: 'step2', type: 'shell', run: 'echo 2', needs: ['step1'] },
          { id: 'step3', type: 'shell', run: 'echo 3', needs: ['step2'] },
        ],
      } as unknown as Workflow;
      expect(WorkflowParser.topologicalSort(workflow)).toEqual(['step1', 'step2', 'step3']);
    });

    test('should handle parallel branches', () => {
      const workflow = {
        steps: [
          { id: 'step1', type: 'shell', run: 'echo 1', needs: [] },
          { id: 'step2a', type: 'shell', run: 'echo 2a', needs: ['step1'] },
          { id: 'step2b', type: 'shell', run: 'echo 2b', needs: ['step1'] },
          { id: 'step3', type: 'shell', run: 'echo 3', needs: ['step2a', 'step2b'] },
        ],
      } as unknown as Workflow;
      const result = WorkflowParser.topologicalSort(workflow);
      expect(result[0]).toBe('step1');
      expect(new Set([result[1], result[2]])).toEqual(new Set(['step2a', 'step2b']));
      expect(result[3]).toBe('step3');
    });

    test('should throw on circular dependencies', () => {
      const workflow = {
        steps: [
          { id: 'step1', type: 'shell', run: 'echo 1', needs: ['step2'] },
          { id: 'step2', type: 'shell', run: 'echo 2', needs: ['step1'] },
        ],
      } as unknown as Workflow;
      expect(() => WorkflowParser.topologicalSort(workflow)).toThrow(/circular dependency/i);
    });

    test('should throw on missing dependencies', () => {
      const workflow = {
        steps: [{ id: 'step1', type: 'shell', run: 'echo 1', needs: ['non-existent'] }],
      } as unknown as Workflow;
      expect(() => WorkflowParser.topologicalSort(workflow)).toThrow(
        /depends on non-existent step/
      );
    });
  });

  describe('loadWorkflow', () => {
    test('should load valid workflow', () => {
      const content = `
name: example-workflow
steps:
  - id: step1
    type: shell
    run: echo hello
`;
      const filePath = join(tempDir, 'valid.yaml');
      writeFileSync(filePath, content);
      const workflow = WorkflowParser.loadWorkflow(filePath);
      expect(workflow.name).toBe('example-workflow');
      expect(workflow.steps.length).toBeGreaterThan(0);
    });

    test('should throw on invalid schema', () => {
      const content = `
name: invalid
steps:
  - id: step1
    type: invalid-type
`;
      const filePath = join(tempDir, 'invalid.yaml');
      writeFileSync(filePath, content);
      expect(() => WorkflowParser.loadWorkflow(filePath)).toThrow(/Invalid workflow schema/);
    });

    test('should throw on non-existent file', () => {
      expect(() => WorkflowParser.loadWorkflow('non-existent.yaml')).toThrow(
        /Failed to parse workflow/
      );
    });

    test('should validate DAG during load', () => {
      const content = `
name: circular
steps:
  - id: step1
    type: shell
    run: echo 1
    needs: [step2]
  - id: step2
    type: shell
    run: echo 2
    needs: [step1]
`;
      const filePath = join(tempDir, 'circular.yaml');
      writeFileSync(filePath, content);
      expect(() => WorkflowParser.loadWorkflow(filePath)).toThrow(/Circular dependency detected/);
    });

    test('should validate finally block Step ID conflicts', () => {
      const content = `
name: conflict
steps:
  - id: step1
    type: shell
    run: echo 1
finally:
  - id: step1
    type: shell
    run: echo finally
`;
      const filePath = join(tempDir, 'conflict.yaml');
      writeFileSync(filePath, content);
      expect(() => WorkflowParser.loadWorkflow(filePath)).toThrow(/conflicts with main steps/);
    });

    test('should validate duplicate finally block Step IDs', () => {
      const content = `
name: finally-dup
steps:
  - id: step1
    type: shell
    run: echo 1
finally:
  - id: fin1
    type: shell
    run: echo f1
  - id: fin1
    type: shell
    run: echo f2
`;
      const filePath = join(tempDir, 'finally-dup.yaml');
      writeFileSync(filePath, content);
      expect(() => WorkflowParser.loadWorkflow(filePath)).toThrow(
        /Duplicate Step ID "fin1" in finally block/
      );
    });

    test('should throw on non-existent agents in LLM steps', () => {
      const content = `
name: llm-agent
steps:
  - id: step1
    type: llm
    agent: non-existent-agent
    prompt: hello
`;
      const filePath = join(tempDir, 'llm-agent.yaml');
      writeFileSync(filePath, content);

      expect(() => WorkflowParser.loadWorkflow(filePath)).toThrow(
        /Agent "non-existent-agent" referenced in step "step1" not found/
      );
    });

    test('should resolve implicit dependencies from expressions', () => {
      const content = `
name: implicit-deps
steps:
  - id: ask_name
    type: human
    message: "What is your name?"
  - id: greet
    type: shell
    run: echo "Hello, \${{ steps.ask_name.output }}!"
`;
      const filePath = join(tempDir, 'implicit-deps.yaml');
      writeFileSync(filePath, content);

      const workflow = WorkflowParser.loadWorkflow(filePath);
      const greetStep = workflow.steps.find((s) => s.id === 'greet');
      expect(greetStep?.needs).toContain('ask_name');
    });

    test('should resolve implicit dependencies in finally block', () => {
      const content = `
name: finally-implicit
steps:
  - id: step1
    type: shell
    run: echo 1
finally:
  - id: cleanup
    type: shell
    run: echo "Cleaning up after \${{ steps.step1.output }}"
`;
      const filePath = join(tempDir, 'finally-implicit.yaml');
      writeFileSync(filePath, content);

      const workflow = WorkflowParser.loadWorkflow(filePath);
      const cleanupStep = workflow.finally?.find((s) => s.id === 'cleanup');
      expect(cleanupStep?.needs).toContain('step1');
    });
  });
});
