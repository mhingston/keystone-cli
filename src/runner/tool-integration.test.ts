// Import shared mock setup FIRST (mock.module is in preload, these are the mock references)
import {
  type MockLLMResponse,
  createUnifiedMockModel,
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
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import * as agentParser from '../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import * as llmAdapter from './llm-adapter';
import type { StepResult } from './step-executor';

// Note: mock.module() for llm-adapter is now handled by the preload file

// Dynamic import holder
let executeLlmStep: any;

// Local chat function wrapper
let currentChatFn: (messages: any[], options?: any) => Promise<MockLLMResponse>;

interface MockToolCall {
  function: {
    name: string;
  };
}

describe('llm-executor with tools and MCP', () => {
  let resolveAgentPathSpy: ReturnType<typeof spyOn>;
  let parseAgentSpy: ReturnType<typeof spyOn>;
  let getModelSpy: ReturnType<typeof spyOn>;

  const createMockMcpClient = (
    options: {
      tools?: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
      callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    } = {}
  ) => {
    const listTools = mock(async () => options.tools ?? []);
    const callTool =
      options.callTool || (mock(async () => ({})) as unknown as typeof options.callTool);
    return {
      listTools,
      callTool,
    };
  };
  const createMockMcpManager = (
    options: {
      clients?: Record<string, ReturnType<typeof createMockMcpClient> | undefined>;
    } = {}
  ) => {
    const getClient = mock(async (serverRef: string | { name: string }) => {
      const name = typeof serverRef === 'string' ? serverRef : serverRef.name;
      return options.clients?.[name];
    });
    return { getClient };
  };

  beforeAll(async () => {
    getModelSpy = spyOn(llmAdapter, 'getModel').mockResolvedValue(createUnifiedMockModel() as any);

    // Set up config
    ConfigLoader.setConfig({
      providers: {
        openai: { type: 'openai', package: '@ai-sdk/openai', api_key_env: 'OPENAI_API_KEY' },
      },
      default_provider: 'openai',
      model_mappings: {},
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
      expression: { strict: false },
    } as any);

    // Ensure the mock model is set up
    setupLlmMocks();

    // Dynamic import AFTER mocks are set up
    const module = await import('./executors/llm-executor.ts');
    executeLlmStep = module.executeLlmStep;
  });

  beforeEach(() => {
    resetLlmMocks();

    // jest.restoreAllMocks();
    ConfigLoader.clear();
    // Setup mocks
    setupLlmMocks();

    // Mock agent parser to avoid needing actual agent files
    resolveAgentPathSpy = spyOn(agentParser, 'resolveAgentPath').mockReturnValue('tool-agent.md');
    parseAgentSpy = spyOn(agentParser, 'parseAgent').mockReturnValue({
      name: 'tool-test-agent',
      systemPrompt: 'Test system prompt',
      tools: [
        {
          name: 'agent-tool',
          parameters: { type: 'object', properties: {} },
          execution: { id: 'agent-tool-exec', type: 'shell', run: 'echo "agent tool"' },
        },
      ],
      model: 'gpt-4o',
    } as unknown as Agent);
  });

  afterEach(() => {
    resolveAgentPathSpy?.mockRestore();
    parseAgentSpy?.mockRestore();
    getModelSpy?.mockClear();
  });

  afterAll(() => {
    ConfigLoader.clear();
  });

  it('should merge tools from agent, step and MCP', async () => {
    let capturedTools: MockToolCall[] = [];

    currentChatFn = async (_messages: unknown, options: unknown) => {
      capturedTools = (options as { tools?: MockToolCall[] })?.tools || [];
      return {
        message: { role: 'assistant', content: 'Final response' },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    const mockClient = createMockMcpClient({
      tools: [
        {
          name: 'mcp-tool',
          description: 'MCP tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const mcpManager = createMockMcpManager({
      clients: { 'test-mcp': mockClient },
    });

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'tool-test-agent',
      prompt: 'test',
      needs: [],
      maxIterations: 10,
      tools: [
        {
          name: 'step-tool',
          parameters: { type: 'object', properties: {} },
          execution: { id: 'step-tool-exec', type: 'shell', run: 'echo step' },
        },
      ],
      mcpServers: [{ name: 'test-mcp', command: 'node', args: ['-e', ''] }],
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = async () => ({ status: 'success' as const, output: {} });

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      mcpManager as unknown as { getClient: () => Promise<unknown> },
      undefined,
      undefined
    );

    const toolNames = capturedTools.map((t) => t.function.name);
    expect(toolNames).toContain('agent-tool');
    expect(toolNames).toContain('step-tool');
    expect(toolNames).toContain('mcp-tool');
  });

  it('should execute MCP tool when called', async () => {
    currentChatFn = async () => {
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'mcp-tool', arguments: '{}' },
            },
          ],
        },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    const mockCallTool = mock(async () => ({ result: 'mcp success' }));
    const mockClient = createMockMcpClient({
      tools: [
        {
          name: 'mcp-tool',
          description: 'MCP tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      callTool: mockCallTool,
    });
    const mcpManager = createMockMcpManager({
      clients: { 'test-mcp': mockClient },
    });

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'tool-test-agent',
      prompt: 'test',
      needs: [],
      maxIterations: 2, // Give room for tool execution
      mcpServers: [{ name: 'test-mcp', command: 'node', args: ['-e', ''] }],
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = async () => ({ status: 'success' as const, output: {} });

    // The execution may hit max iterations, but the tool should still be called
    try {
      await executeLlmStep(
        step,
        context,
        executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
        undefined,
        mcpManager as unknown as { getClient: () => Promise<unknown> },
        undefined,
        undefined
      );
    } catch (e) {
      // May throw max iterations error
    }

    // Verify MCP tool was invoked
    expect(mockCallTool).toHaveBeenCalledWith('mcp-tool', {});
  });
});
