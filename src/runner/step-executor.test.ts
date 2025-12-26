import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import * as dns from 'node:dns/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readlinePromises from 'node:readline/promises';
import type { MemoryDb } from '../db/memory-db';
import type { ExpressionContext } from '../expression/evaluator';
import type {
  EngineStep,
  FileStep,
  HumanStep,
  RequestStep,
  ShellStep,
  SleepStep,
  WorkflowStep,
} from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import type { SafeSandbox } from '../utils/sandbox';
import type { getAdapter } from './llm-adapter';
import type { executeLlmStep } from './llm-executor';
import { executeStep } from './step-executor';

interface StepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RequestOutput {
  status: number;
  data: unknown;
}

const mockRl = {
  question: mock(() => Promise.resolve('')),
  close: mock(() => { }),
};

describe('step-executor', () => {
  let context: ExpressionContext;

  const tempDir = join(process.cwd(), 'temp-step-test');

  beforeAll(() => {
    try {
      mkdirSync(tempDir, { recursive: true });
    } catch (e) {
      // Ignore error
    }
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore error
    }
  });

  beforeEach(() => {
    context = {
      inputs: {},
      steps: {},
    };
  });

  afterEach(() => {
    ConfigLoader.clear();
  });

  describe('shell', () => {
    it('should execute shell command', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        needs: [],
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
        needs: [],
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
        needs: [],
        op: 'write',
        path: filePath,
        content: 'hello file',
      };
      const writeResult = await executeStep(writeStep, context);
      expect(writeResult.status).toBe('success');

      const readStep: FileStep = {
        id: 'r1',
        type: 'file',
        needs: [],
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
          needs: [],
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
          needs: [],
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
        needs: [],
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

    it('should allow file paths outside cwd when allowOutsideCwd is true', async () => {
      const outsidePath = join(tmpdir(), `keystone-test-${Date.now()}.txt`);

      const writeStep: FileStep = {
        id: 'w-outside',
        type: 'file',
        needs: [],
        op: 'write',
        path: outsidePath,
        content: 'outside',
        allowOutsideCwd: true,
      };

      try {
        const writeResult = await executeStep(writeStep, context);
        expect(writeResult.status).toBe('success');

        const content = await Bun.file(outsidePath).text();
        expect(content).toBe('outside');
      } finally {
        try {
          rmSync(outsidePath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });

    it('should block path traversal outside cwd by default', async () => {
      const outsidePath = join(process.cwd(), '..', 'outside.txt');
      const step: FileStep = {
        id: 'f1',
        type: 'file',
        needs: [],
        op: 'read',
        path: outsidePath,
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Access denied');
    });

    it('should block path traversal with .. inside path resolving outside', async () => {
      const outsidePath = 'foo/../../passwd';
      const step: FileStep = {
        id: 'f1',
        type: 'file',
        needs: [],
        op: 'read',
        path: outsidePath,
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Access denied');
    });
  });

  describe('script', () => {
    const mockSandbox = {
      execute: mock((code) => {
        if (code === 'fail') throw new Error('Script failed');
        return Promise.resolve('script-result');
      }),
    };

    it('should fail if allowInsecure is not set', async () => {
      // @ts-ignore
      const step = {
        id: 's1',
        type: 'script',
        run: 'console.log("hello")',
      };
      const result = await executeStep(step, context, undefined, {
        sandbox: mockSandbox as unknown as typeof SafeSandbox,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Script execution is disabled by default');
    });

    it('should execute script if allowInsecure is true', async () => {
      // @ts-ignore
      const step = {
        id: 's1',
        type: 'script',
        run: 'console.log("hello")',
        allowInsecure: true,
      };
      const result = await executeStep(step, context, undefined, {
        sandbox: mockSandbox as unknown as typeof SafeSandbox,
      });
      expect(result.status).toBe('success');
      expect(result.output).toBe('script-result');
    });

    it('should handle script failure', async () => {
      // @ts-ignore
      const step = {
        id: 's1',
        type: 'script',
        run: 'fail',
        allowInsecure: true,
      };
      const result = await executeStep(step, context, undefined, {
        sandbox: mockSandbox as unknown as typeof SafeSandbox,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Script failed');
    });

    it('should inject console that redirects to logger', async () => {
      const logger = { log: mock(() => { }) };
      // @ts-ignore
      const step = {
        id: 's1',
        type: 'script',
        run: 'console.log("hello from script")',
        allowInsecure: true,
      };

      // Use a real sandbox or a very thin mock that actually executes the code
      // SafeSandbox.execute uses ProcessSandbox by default which won't easily let us mock console
      // but we can pass a mock sandbox that we control.
      const mockSandbox = {
        execute: async (code: string, context: any) => {
          if (context.console && typeof context.console.log === 'function') {
            context.console.log('hello from script');
          }
          return 'ok';
        },
      };

      const result = await executeStep(step, context, logger as any, {
        sandbox: mockSandbox as any,
      });

      expect(result.status).toBe('success');
      expect(logger.log).toHaveBeenCalledWith('hello from script');
    });
  });

  describe('engine', () => {
    const artifactRoot = join(tempDir, 'engine-artifacts');

    const setEngineConfig = (
      allowlist: Record<string, { command: string; version: string; versionArgs?: string[] }>
    ) => {
      ConfigLoader.setConfig({
        default_provider: 'openai',
        providers: {},
        model_mappings: {},
        storage: { retention_days: 30, redact_secrets_at_rest: true },
        mcp_servers: {},
        engines: { allowlist, denylist: [] },
        concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
      });
    };

    it('should execute engine command and parse summary', async () => {
      const version = (Bun.version || process.versions?.bun || '') as string;
      setEngineConfig({ bun: { command: 'bun', version } });

      const step: EngineStep = {
        id: 'e1',
        type: 'engine',
        command: 'bun',
        args: ['-e', 'console.log(JSON.stringify({ ok: true }))'],
        env: { PATH: process.env.PATH || '' },
        cwd: process.cwd(),
      };

      const result = await executeStep(step, context, undefined, { artifactRoot });
      expect(result.status).toBe('success');
      const output = result.output as { summary: { ok: boolean }; artifactPath?: string };
      expect(output.summary).toEqual({ ok: true });
      expect(output.artifactPath).toBeTruthy();

      const artifactText = await Bun.file(output.artifactPath as string).text();
      expect(artifactText).toContain('"ok": true');
    });

    it('should fail when engine command is not allowlisted', async () => {
      setEngineConfig({});

      const step: EngineStep = {
        id: 'e1',
        type: 'engine',
        command: 'bun',
        args: ['-e', 'console.log(JSON.stringify({ ok: true }))'],
        env: { PATH: process.env.PATH || '' },
        cwd: process.cwd(),
      };

      const result = await executeStep(step, context, undefined, { artifactRoot });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('allowlist');
    });
  });

  describe('memory', () => {
    const mockMemoryDb = {
      store: mock(() => Promise.resolve('mem-id')),
      search: mock(() => Promise.resolve([{ content: 'found', similarity: 0.9 }])),
    };

    const mockGetAdapter = mock((model) => {
      if (model === 'no-embed') return { adapter: {}, resolvedModel: model };
      return {
        adapter: {
          embed: mock((text) => Promise.resolve([0.1, 0.2, 0.3])),
        },
        resolvedModel: model,
      };
    });

    it('should fail if memoryDb is not provided', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'store', text: 'foo' };
      const result = await executeStep(step, context, undefined, {
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Memory database not initialized');
    });

    it('should fail if adapter does not support embedding', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'store', text: 'foo', model: 'no-embed' };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('does not support embeddings');
    });

    it('should store memory', async () => {
      // @ts-ignore
      const step = {
        id: 'm1',
        type: 'memory',
        op: 'store',
        text: 'foo',
        metadata: { source: 'test' },
      };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('success');
      expect(result.output).toEqual({ id: 'mem-id', status: 'stored' });
      expect(mockMemoryDb.store).toHaveBeenCalledWith('foo', [0.1, 0.2, 0.3], { source: 'test' });
    });

    it('should search memory', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'search', query: 'foo', limit: 5 };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('success');
      expect(result.output).toEqual([{ content: 'found', similarity: 0.9 }]);
      expect(mockMemoryDb.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 5);
    });

    it('should fail store if text is missing', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'store' };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Text is required for memory store operation');
    });

    it('should fail search if query is missing', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'search' };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Query is required for memory search operation');
    });

    it('should fail for unknown memory operation', async () => {
      // @ts-ignore
      const step = { id: 'm1', type: 'memory', op: 'unknown', text: 'foo' };
      // @ts-ignore
      const result = await executeStep(step, context, undefined, {
        memoryDb: mockMemoryDb as unknown as MemoryDb,
        getAdapter: mockGetAdapter as unknown as typeof getAdapter,
      });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Unknown memory operation');
    });
  });

  describe('sleep', () => {
    it('should sleep for a duration', async () => {
      const step: SleepStep = {
        id: 'sl1',
        type: 'sleep',
        needs: [],
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
    let lookupSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // @ts-ignore
      global.fetch = mock();
      lookupSpy = spyOn(dns, 'lookup').mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    });

    afterEach(() => {
      global.fetch = originalFetch;
      lookupSpy.mockRestore();
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
        needs: [],
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
        needs: [],
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
        needs: [],
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
        needs: [],
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
        needs: [],
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
        needs: [],
        url: 'https://api.example.com/fail',
        method: 'POST',
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('HTTP 400: Bad Request');
      expect(result.error).toContain('Response Body: {"error": "bad request details"}');
    });

    it('should drop auth headers on cross-origin redirects', async () => {
      // @ts-ignore
      global.fetch
        .mockResolvedValueOnce(
          new Response('', {
            status: 302,
            headers: { Location: 'https://other.example.com/next' },
          })
        )
        .mockResolvedValueOnce(new Response('ok'));

      const step: RequestStep = {
        id: 'req-redirect',
        type: 'request',
        needs: [],
        url: 'https://api.example.com/start',
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('success');

      // @ts-ignore
      const secondCall = global.fetch.mock.calls[1][1];
      expect(secondCall.headers.Authorization).toBeUndefined();
    });

    it('should allow insecure request when allowInsecure is true', async () => {
      // @ts-ignore
      global.fetch.mockResolvedValue(new Response('ok'));

      const step: RequestStep = {
        id: 'req-insecure',
        type: 'request',
        needs: [],
        url: 'http://localhost/test',
        method: 'GET',
        allowInsecure: true,
      };

      const result = await executeStep(step, context);
      expect(result.status).toBe('success');
    });
  });

  describe('human', () => {
    const originalIsTTY = process.stdin.isTTY;
    let createInterfaceSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      process.stdin.isTTY = true;
      createInterfaceSpy = spyOn(readlinePromises, 'createInterface').mockReturnValue(
        mockRl as unknown as ReturnType<typeof readlinePromises.createInterface>
      );
    });

    afterEach(() => {
      process.stdin.isTTY = originalIsTTY;
      createInterfaceSpy.mockRestore();
    });

    it('should handle human confirmation', async () => {
      mockRl.question.mockResolvedValue('\n');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        needs: [],
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => { } });
      expect(result.status).toBe('success');
      expect(result.output).toBe(true);
      expect(mockRl.question).toHaveBeenCalled();
    });

    it('should handle human text input', async () => {
      mockRl.question.mockResolvedValue('user response');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        needs: [],
        message: 'What is your name?',
        inputType: 'text',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => { } });
      expect(result.status).toBe('success');
      expect(result.output).toBe('user response');
    });

    it('should handle human confirmation (yes/no/empty)', async () => {
      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        needs: [],
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // Test 'yes'
      mockRl.question.mockResolvedValue('yes');
      // @ts-ignore
      let result = await executeStep(step, context, { log: () => { } });
      expect(result.output).toBe(true);

      // Test 'no'
      mockRl.question.mockResolvedValue('no');
      // @ts-ignore
      result = await executeStep(step, context, { log: () => { } });
      expect(result.output).toBe(false);

      // Test empty string (default to true)
      mockRl.question.mockResolvedValue('');
      // @ts-ignore
      result = await executeStep(step, context, { log: () => { } });
      expect(result.output).toBe(true);
    });

    it('should fallback to text in confirm mode', async () => {
      mockRl.question.mockResolvedValue('some custom response');

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        needs: [],
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => { } });
      expect(result.status).toBe('success');
      expect(result.output).toBe('some custom response');
    });

    it('should suspend if not a TTY', async () => {
      process.stdin.isTTY = false;

      const step: HumanStep = {
        id: 'h1',
        type: 'human',
        needs: [],
        message: 'Proceed?',
        inputType: 'confirm',
      };

      // @ts-ignore
      const result = await executeStep(step, context, { log: () => { } });
      expect(result.status).toBe('suspended');
      expect(result.error).toBe('Proceed?');
    });
  });

  describe('workflow', () => {
    it('should call executeWorkflowFn', async () => {
      const step: WorkflowStep = {
        id: 'w1',
        type: 'workflow',
        needs: [],
        path: 'child.yaml',
      };
      // @ts-ignore
      const executeWorkflowFn = mock(() =>
        Promise.resolve({ status: 'success', output: 'child-output' })
      );

      // @ts-ignore
      const result = await executeStep(step, context, undefined, { executeWorkflowFn });
      expect(result.status).toBe('success');
      expect(result.output).toBe('child-output');
      expect(executeWorkflowFn).toHaveBeenCalled();
    });

    it('should fail if executeWorkflowFn is not provided', async () => {
      const step: WorkflowStep = {
        id: 'w1',
        type: 'workflow',
        needs: [],
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
      const executeLlmStepMock = mock(async () => ({
        status: 'success',
        output: 'llm-output',
      })) as unknown as typeof executeLlmStep;
      const result = await executeStep(step, context, undefined, {
        executeLlmStep: executeLlmStepMock,
      });
      expect(result.status).toBe('success');
      expect(result.output).toBe('llm-output');
    });
  });

  describe('transform', () => {
    it('should apply transform to output', async () => {
      const step: ShellStep = {
        id: 's1',
        type: 'shell',
        needs: [],
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
        needs: [],
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
        needs: [],
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
