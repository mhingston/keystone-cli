import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import type {
  FileStep,
  HumanStep,
  RequestStep,
  ShellStep,
  SleepStep,
  WorkflowStep,
} from '../parser/schema';
import { executeStep } from './step-executor';

// Mock executeLlmStep
mock.module('./llm-executor', () => ({
  // @ts-ignore
  executeLlmStep: mock((_step, _context, _callback) => {
    return Promise.resolve({ status: 'success', output: 'llm-output' });
  }),
}));

interface StepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RequestOutput {
  status: number;
  data: unknown;
}

// Mock node:readline/promises
const mockRl = {
  question: mock(() => Promise.resolve('')),
  close: mock(() => {}),
};

mock.module('node:readline/promises', () => ({
  createInterface: mock(() => mockRl),
}));

describe('step-executor', () => {
  let context: ExpressionContext;

  const tempDir = join(process.cwd(), 'temp-step-test');

  beforeAll(() => {
    try {
      mkdirSync(tempDir, { recursive: true });
    } catch (e) {}
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  });

  beforeEach(() => {
    context = {
      inputs: {},
      steps: {},
    };
  });

  describe('shell', () => {
    it('should execute shell command', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        run: 'echo "hello"',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
      expect((result.output as StepOutput).stdout.trim()).toBe('hello');
    });

    it('should handle shell failure', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        run: 'exit 1',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('exited with code 1');
    });
  });

  describe('file', () => {
    it('should write and read a file', async () => {
      const filePath = join(tempDir, 'test.txt');
      const writeStep: FileStep = {
        id: 'w1',
        type: 'file',
        op: 'write',
        path: filePath,
        content: 'hello file',
      };
      const writeResult = await executeStep(writeStep, context);
      expect(writeResult.status).toBe('success');

      const readStep: FileStep = {
        id: 'r1',
        type: 'file',
        op: 'read',
        path: filePath,
      };
      const readResult = await executeStep(readStep, context);
      expect(readResult.status).toBe('success');
      expect(readResult.output).toBe('hello file');
    });

    it('should append to a file', async () => {
      const filePath = join(tempDir, 'append.txt');
      await executeStep(
        {
          id: 'w1',
          type: 'file',
          op: 'write',
          path: filePath,
          content: 'line 1\n',
        } as FileStep,
        context
      );

      await executeStep(
        {
          id: 'a1',
          type: 'file',
          op: 'append',
          path: filePath,
          content: 'line 2',
        } as FileStep,
        context
      );

      const content = await Bun.file(filePath).text();
      expect(content).toBe('line 1\nline 2');
    });

    it('should fail if file not found on read', async () => {
      const readStep: FileStep = {
        id: 'r1',
        type: 'file',
        op: 'read',
        path: join(tempDir, 'non-existent.txt'),
      };
      const result = await executeStep(readStep, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('File not found');
    });

    it('should fail if content missing on write', async () => {
      // @ts-ignore
      const step: FileStep = { id: 'f1', type: 'file', op: 'write', path: 'test.txt' };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Content is required for write operation');
    });

    it('should fail if content missing on append', async () => {
      // @ts-ignore
      const step: FileStep = { id: 'f1', type: 'file', op: 'append', path: 'test.txt' };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Content is required for append operation');
    });

    it('should fail for unknown file operation', async () => {
      // @ts-ignore
      const step: FileStep = { id: 'f1', type: 'file', op: 'unknown', path: 'test.txt' };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Unknown file operation');
    });
  });

  describe('sleep', () => {
    it('should sleep for a duration', async () => {
      const step: SleepStep = {
        id: 'sl1',
        type: 'sleep',
        duration: 10,
      };
      const start = Date.now();
      const result = await executeStep(step, context);
      const end = Date.now();
      expect(result.status).toBe('success');
      expect(end - start).toBeGreaterThanOrEqual(10);
    });
  });

  describe('request', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // @ts-ignore
      global.fetch = mock();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should perform an HTTP request', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
      expect((result.output as RequestOutput).data).toEqual({ ok: true });
    });

    it('should handle form-urlencoded body', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(new Response('ok'));

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: { key: 'value', foo: 'bar' },
      };

      await executeStep(step, context);

      // @ts-ignore
      const init = global.fetch.mock.calls[0][1];
      expect(init.body).toBe('key=value&foo=bar');
    });

    it('should handle non-object body in form-urlencoded', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(new Response('ok'));

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'raw-body',
      };

      await executeStep(step, context);

      // @ts-ignore
      const init = global.fetch.mock.calls[0][1];
      expect(init.body).toBe('raw-body');
    });

    it('should auto-set JSON content type for object bodies', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(new Response('{}'));

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/post',
        method: 'POST',
        body: { foo: 'bar' },
      };

      await executeStep(step, context);

      // @ts-ignore
      const init = global.fetch.mock.calls[0][1];
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe('{"foo":"bar"}');
    });

    it('should handle non-JSON responses', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(
        new Response('plain text', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      );

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/text',
        method: 'GET',
      };

      const result = await executeStep(step, context);
      // @ts-ignore
      expect(result.output.data).toBe('plain text');
    });

    it('should include response body in error for failed requests', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(
        new Response('{"error": "bad request details"}', {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const step: RequestStep = {
        id: 'req1',
        type: 'request',
        url: 'https://api.example.com/fail',
        method: 'POST',
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('HTTP 400: Bad Request');
      expect(result.error).toContain('Response Body: {"error": "bad request details"}');
    });
  });

  describe('human', () => {
    const originalIsTTY = process.stdin.isTTY;

    beforeEach(() => {
      process.stdin.isTTY = true;
    });

    afterEach(() => {
      process.stdin.isTTY = originalIsTTY;
    });

    it('should handle human confirmation', async () => {
      mockRl.question.mockResolvedValue('\n');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => {} });
      expect(result.status).toBe('success');
      expect(result.output).toBe(true);
      expect(mockRl.question).toHaveBeenCalled();
    });

    it('should handle human text input', async () => {
      mockRl.question.mockResolvedValue('user response');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        message: 'What is your name?',
        inputType: 'text',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => {} });
      expect(result.status).toBe('success');
      expect(result.output).toBe('user response');
    });

    it('should handle human confirmation (yes/no/empty)', async () => {
      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // Test 'yes'
      mockRl.question.mockResolvedValue('yes');
      // @ts-ignore
      let result = await executeStep(step, context, { log: () => {} });
      expect(result.output).toBe(true);

      // Test 'no'
      mockRl.question.mockResolvedValue('no');
      // @ts-ignore
      result = await executeStep(step, context, { log: () => {} });
      expect(result.output).toBe(false);

      // Test empty string (default to true)
      mockRl.question.mockResolvedValue('');
      // @ts-ignore
      result = await executeStep(step, context, { log: () => {} });
      expect(result.output).toBe(true);
    });

    it('should fallback to text in confirm mode', async () => {
      mockRl.question.mockResolvedValue('some custom response');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => {} });
      expect(result.status).toBe('success');
      expect(result.output).toBe('some custom response');
    });

    it('should suspend if not a TTY', async () => {
      process.stdin.isTTY = false;

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => {} });
      expect(result.status).toBe('suspended');
      expect(result.error).toBe('Proceed?');
    });
  });

  describe('workflow', () => {
    it('should call executeWorkflowFn', async () => {
      const step: WorkflowStep = {
        id: 'w1',
        type: 'workflow',
        path: 'child.yaml',
      };
      // @ts-ignore
      const executeWorkflowFn = mock(() =>
        Promise.resolve({ status: 'success', output: 'child-output' })
      );

      // @ts-ignore
      const result = await executeStep(step, context, undefined, executeWorkflowFn);
      expect(result.status).toBe('success');
      expect(result.output).toBe('child-output');
      expect(executeWorkflowFn).toHaveBeenCalled();
    });

    it('should fail if executeWorkflowFn is not provided', async () => {
      const step: WorkflowStep = {
        id: 'w1',
        type: 'workflow',
        path: 'child.yaml',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Workflow executor not provided');
    });
  });

  describe('llm', () => {
    it('should call executeLlmStep', async () => {
      // @ts-ignore
      const step = {
        id: 'l1',
        type: 'llm',
        prompt: 'hello',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
      expect(result.output).toBe('llm-output');
    });
  });

  describe('transform', () => {
    it('should apply transform to output', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        run: 'echo "json string"',
        transform: 'output.stdout.toUpperCase().trim()',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
      expect(result.output).toBe('JSON STRING');
    });

    it('should apply transform with ${{ }} syntax', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        run: 'echo "hello"',
        transform: '${{ output.stdout.trim() + " world" }}',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
      expect(result.output).toBe('hello world');
    });

    it('should handle transform failure', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        run: 'echo "hello"',
        transform: 'nonexistent.property',
      };
      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Transform failed');
    });
  });

  it('should throw error for unknown step type', async () => {
    // @ts-ignore
    const step = {
      id: 'u1',
      type: 'unknown',
    };
    const result = await executeStep(step, context);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Unknown step type');
  });
});
