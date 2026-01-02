// Import shared mock setup FIRST (mock.module is in preload, these are the mock references)
import {
  type MockLLMResponse,
  createUnifiedMockModel,
  mockGetEmbeddingModel,
  mockGetModel,
  resetLlmMocks,
  setCurrentChatFn,
  setupLlmMocks,
} from './__test__/llm-test-setup';

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
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ExpressionContext } from '../expression/evaluator';
import * as agentParser from '../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import * as llmAdapter from './llm-adapter';
import type { StepResult } from './step-executor';

// Note: mock.module() for llm-adapter is now handled by the preload file
// We should NOT mock 'ai' globally here.

// Dynamic import holder
let executeLlmStep: any;

// Local types for tests (matching our shared mock formats)
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | any[];
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface LLMResponse {
  message: LLMMessage;
  usage?: any;
}

// Local chat function wrapper
let currentChatFn: (messages: LLMMessage[], options?: any) => Promise<LLMResponse>;

const setupMockModel = (
  chatFn: (messages: LLMMessage[], options?: any) => Promise<LLMResponse>
) => {
  currentChatFn = chatFn;
  setCurrentChatFn(chatFn as any);
};

describe('llm-executor', () => {
  const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
  let spawnSpy: ReturnType<typeof spyOn>;
  let resolveAgentPathSpy: ReturnType<typeof spyOn>;
  let parseAgentSpy: ReturnType<typeof spyOn>;
  let getModelSpy: ReturnType<typeof spyOn>;

  // Default Mock Chat Logic
  const defaultMockChat = async (messages: LLMMessage[], _options: any) => {
    if (messages.length === 0) {
      return { message: { role: 'assistant', content: 'LLM Response' } };
    }
    const lastMessage = messages[messages.length - 1];
    const systemMessage = messages.find((m) => m.role === 'system');

    // If previous message was 'tool' (tool result), return response
    if (messages.some((m) => m.role === 'tool')) {
      return { message: { role: 'assistant', content: 'LLM Response' } };
    }

    if (systemMessage?.content?.includes('IMPORTANT: You must output valid JSON')) {
      return { message: { role: 'assistant', content: '```json\n{"foo": "bar"}\n```' } };
    }

    if (lastMessage.role === 'user' && typeof lastMessage.content === 'string') {
      if (lastMessage.content.includes('trigger tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'test-tool', arguments: '{"val": 123}' },
              },
            ],
          },
        };
      }
      if (lastMessage.content.includes('trigger adhoc tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-adhoc',
                type: 'function',
                function: { name: 'adhoc-tool', arguments: '{}' },
              },
            ],
          },
        };
      }
      if (lastMessage.content.includes('trigger unknown tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-unknown',
                type: 'function',
                function: { name: 'unknown-tool', arguments: '{}' },
              },
            ],
          },
        };
      }
      if (lastMessage.content.includes('trigger mcp tool')) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-mcp', type: 'function', function: { name: 'mcp-tool', arguments: '{}' } },
            ],
          },
        };
      }
      if (lastMessage.content.includes('stream this')) {
        return { message: { role: 'assistant', content: '<thinking>thought</thinking>done' } };
      }
    }

    return { message: { role: 'assistant', content: 'LLM Response' } };
  };

  const createMockMcpManager = (options: any = {}) => {
    const getClient = mock(async (serverRef: any) => {
      const name = typeof serverRef === 'string' ? serverRef : serverRef.name;
      if (options.errors?.[name]) throw options.errors[name];
      if (options.clients && name in options.clients) return options.clients[name];
      return options.defaultClient;
    });
    const getGlobalServers = mock(() => options.globalServers ?? []);
    return { getClient, getGlobalServers };
  };

  beforeAll(async () => {
    setupLlmMocks();

    const mockProcess = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stdin: new Writable({
        write(_chunk, _encoding, cb) {
          cb();
        },
      }),
      kill: mock(() => {}),
    });
    spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(mockProcess as any);

    // Import after mocks
    const module = await import('./executors/llm-executor.ts');
    executeLlmStep = module.executeLlmStep;
  });

  beforeEach(() => {
    // jest.restoreAllMocks(); // Bun.js doesn't have jest.restoreAllMocks()
    ConfigLoader.clear();
    setupLlmMocks();
    resetLlmMocks();

    // Spy on getModel to return our mock model directly
    getModelSpy = spyOn(llmAdapter, 'getModel').mockResolvedValue(createUnifiedMockModel() as any);

    // Mock agent parser to avoid file dependencies
    resolveAgentPathSpy = spyOn(agentParser, 'resolveAgentPath').mockReturnValue('test-agent.md');
    parseAgentSpy = spyOn(agentParser, 'parseAgent').mockImplementation((path) => {
      if (path?.includes('handoff-target')) {
        return {
          name: 'handoff-target',
          systemPrompt: 'Handoff target prompt',
          tools: [],
          model: 'gpt-4',
        } as any;
      }
      return {
        name: 'test-agent',
        systemPrompt: 'You are a test agent.',
        tools: [
          {
            name: 'test-tool',
            parameters: { type: 'object', properties: { val: { type: 'number' } } },
            execution: { type: 'shell', run: 'echo test' },
          },
        ],
        model: 'gpt-4',
      } as any;
    });
  });

  afterEach(() => {
    resolveAgentPathSpy?.mockRestore();
    parseAgentSpy?.mockRestore();
    getModelSpy?.mockRestore();
  });

  afterAll(() => {
    spawnSpy.mockRestore();
    ConfigLoader.clear();
  });

  it('should execute a simple LLM step', async () => {
    setupMockModel(defaultMockChat as any);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };

    const result = await executeLlmStep(step, context, async () => ({
      status: 'success',
      output: 'ok',
    }));

    expect(result.status).toBe('success');
    expect(result.output).toBe('LLM Response');
  });

  it('should log tool call arguments', async () => {
    setupMockModel(defaultMockChat as any);
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger tool',
      needs: [],
      maxIterations: 10,
    };
    const logger = { log: mock(), error: mock(), warn: mock(), info: mock(), debug: mock() };

    await executeLlmStep(
      step,
      { inputs: {}, steps: {} },
      async () => ({ status: 'success', output: 'ok' }),
      logger
    );

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('  🛠️  Tool Call: test-tool {"val":123}')
    );
  });

  it('should throw error if schema validation fails and JSON cannot be extracted', async () => {
    setupMockModel(defaultMockChat as any);
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'output valid JSON',
      outputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      needs: [],
      maxIterations: 10,
    };

    // Case 1: Model returns text that is NOT valid JSON
    setupMockModel(async () => ({ message: { role: 'assistant', content: 'Not JSON' } }));

    await expect(
      executeLlmStep(step, { inputs: {}, steps: {} }, async () => ({
        status: 'success',
        output: 'ok',
      }))
    ).rejects.toThrow('Failed to extract valid JSON');
  });

  it('should handle tool not found', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger unknown tool',
      needs: [],
      maxIterations: 10,
    };

    const result = await executeLlmStep(step, { inputs: {}, steps: {} }, async () => ({
      status: 'success',
      output: 'ok',
    }));

    expect(result.status).toBe('success');
  });

  it('should handle MCP connection failure', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
      mcpServers: [{ name: 'fail-mcp', command: 'node', args: [] }],
    };
    setupMockModel(defaultMockChat as any);
    const mcpManager = createMockMcpManager({
      errors: { 'fail-mcp': new Error('Connect failed') },
    });
    const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

    await executeLlmStep(
      step,
      { inputs: {}, steps: {} },
      async () => ({ status: 'success', output: 'ok' }),
      console,
      mcpManager as any
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect/list MCP tools for fail-mcp')
    );
    consoleSpy.mockRestore();
  });

  it('should handle streaming chunks with thoughts', async () => {
    setupMockModel(defaultMockChat as any);

    const logger = { log: mock(), error: mock(), warn: mock(), info: mock(), debug: mock() };
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'stream this',
      needs: [],
      maxIterations: 10,
    };

    await executeLlmStep(
      step,
      { inputs: {}, steps: {} },
      async () => ({ status: 'success', output: 'ok' }),
      logger
    );

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('thought'));
  });
});
