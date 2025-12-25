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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ExpressionContext } from '../expression/evaluator';
import type { LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './llm-adapter';
import { executeLlmStep } from './llm-executor';
import { MCPClient, type MCPResponse } from './mcp-client';
import { MCPManager } from './mcp-manager';
import { type StepResult, executeStep } from './step-executor';
import type { Logger } from './workflow-runner';

// Mock adapters
// Instead of mutating prototypes (which causes cross-test contamination),
// we use the getAdapterFn parameter to inject a mock adapter factory.

describe('llm-executor', () => {
  const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
  let spawnSpy: ReturnType<typeof spyOn>;
  let initSpy: ReturnType<typeof spyOn>;
  let listToolsSpy: ReturnType<typeof spyOn>;
  let stopSpy: ReturnType<typeof spyOn>;

  const mockChat: LLMAdapter['chat'] = async (messages, _options) => {
    const lastMessage = messages[messages.length - 1];
    const systemMessage = messages.find((m) => m.role === 'system');

    // If there's any tool message, just respond with final message
    if (messages.some((m) => m.role === 'tool')) {
      return {
        message: { role: 'assistant', content: 'LLM Response' },
      };
    }

    if (systemMessage?.content?.includes('IMPORTANT: You must output valid JSON')) {
      return {
        message: { role: 'assistant', content: '```json\n{"foo": "bar"}\n```' },
      };
    }

    if (lastMessage.role === 'user' && lastMessage.content?.includes('trigger tool')) {
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

    if (lastMessage.role === 'user' && lastMessage.content?.includes('trigger adhoc tool')) {
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

    if (lastMessage.role === 'user' && lastMessage.content?.includes('trigger unknown tool')) {
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

    if (lastMessage.role === 'user' && lastMessage.content?.includes('trigger mcp tool')) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-mcp',
              type: 'function',
              function: { name: 'mcp-tool', arguments: '{}' },
            },
          ],
        },
      };
    }

    return {
      message: { role: 'assistant', content: 'LLM Response' },
    };
  };

  // Create a mock adapter factory that doesn't rely on prototype mutation
  const createMockGetAdapter = (chatFn: LLMAdapter['chat'] = mockChat) => {
    return (_modelString: string) => {
      const mockAdapter: LLMAdapter = { chat: chatFn };
      return { adapter: mockAdapter, resolvedModel: 'gpt-4' };
    };
  };

  // Default mock adapter factory using the standard mockChat
  const mockGetAdapter = createMockGetAdapter();

  beforeAll(async () => {
    // Mock spawn to avoid actual process creation
    const mockProcess = Object.assign(new EventEmitter(), {
      stdout: new Readable({
        read() {},
      }),
      stdin: new Writable({
        write(_chunk, _encoding, cb: (error?: Error | null) => void) {
          cb();
        },
      }),
      kill: mock(() => {}),
    });
    spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(
      mockProcess as unknown as child_process.ChildProcess
    );

    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (e) {
      // Ignore error during cleanup
    }
    const agentContent = `---
name: test-agent
model: gpt-4
tools:
  - name: test-tool
    execution:
      type: shell
      run: echo "tool executed with \${{ args.val }}"
---
You are a test agent.`;
    writeFileSync(join(agentsDir, 'test-agent.md'), agentContent);
  });

  beforeEach(() => {
    // Global MCP mocks to avoid hangs
    initSpy = spyOn(MCPClient.prototype, 'initialize').mockResolvedValue({
      jsonrpc: '2.0',
      id: 0,
      result: { protocolVersion: '2024-11-05' },
    } as MCPResponse);
    listToolsSpy = spyOn(MCPClient.prototype, 'listTools').mockResolvedValue([]);
    stopSpy = spyOn(MCPClient.prototype, 'stop').mockReturnValue(undefined);
  });

  afterEach(() => {
    initSpy.mockRestore();
    listToolsSpy.mockRestore();
    stopSpy.mockRestore();
  });

  afterAll(() => {
    spawnSpy.mockRestore();
  });

  it('should execute a simple LLM step', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined, // logger
      undefined, // mcpManager
      undefined, // workflowDir
      undefined, // abortSignal
      mockGetAdapter
    );
    expect(result.status).toBe('success');
    expect(result.output).toBe('LLM Response');
  });

  it('should execute LLM step with tool calls', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger tool',
      needs: [],
      maxIterations: 10,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };

    const executeStepFn = async (s: Step) => {
      if (s.type === 'shell') {
        return { status: 'success' as const, output: { stdout: 'tool result' } };
      }
      return { status: 'success' as const, output: 'ok' };
    };

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined, // logger
      undefined, // mcpManager
      undefined, // workflowDir
      undefined, // abortSignal
      mockGetAdapter
    );
    expect(result.status).toBe('success');
    expect(result.output).toBe('LLM Response');
  });

  it('should log tool call arguments', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger tool',
      needs: [],
      maxIterations: 10,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };

    const executeStepFn = async (s: Step) => {
      if (s.type === 'shell') {
        return { status: 'success' as const, output: { stdout: 'tool result' } };
      }
      return { status: 'success' as const, output: 'ok' };
    };

    const logger: Logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    };

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      logger,
      undefined, // mcpManager
      undefined, // workflowDir
      undefined, // abortSignal
      mockGetAdapter
    );

    // Check if logger.log was called with arguments
    // The tool call from mockChat is { name: 'test-tool', arguments: '{"val": 123}' }
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('🛠️  Tool Call: test-tool {"val":123}')
    );
  });

  it('should support schema for JSON output', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me json',
      needs: [],
      maxIterations: 10,
      outputSchema: {
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
      },
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined, // logger
      undefined, // mcpManager
      undefined, // workflowDir
      undefined, // abortSignal
      mockGetAdapter
    );
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ foo: 'bar' });
  });

  it('should retry if LLM output fails schema validation', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me invalid json',
      needs: [],
      maxIterations: 10,
      outputSchema: { type: 'object' },
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    let attempt = 0;
    const chatMock = mock(async () => {
      attempt++;
      if (attempt === 1) {
        return { message: { role: 'assistant', content: 'Not JSON' } };
      }
      return { message: { role: 'assistant', content: '{"success": true}' } };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(result.status).toBe('success');
    expect(result.output).toEqual({ success: true });
    expect(attempt).toBe(2);
  });

  it('should fail after max iterations if JSON remains invalid', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me invalid json',
      needs: [],
      maxIterations: 3,
      outputSchema: { type: 'object' },
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const chatMock = mock(async () => ({
      message: { role: 'assistant', content: 'Not JSON' },
    })) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    await expect(
      executeLlmStep(
        step,
        context,
        executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
        undefined,
        undefined,
        undefined,
        undefined,
        getAdapter
      )
    ).rejects.toThrow('Max ReAct iterations reached');
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
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    let toolErrorCaptured = false;
    const chatMock = mock(async (messages: LLMMessage[]) => {
      const toolResultMessage = messages.find((m) => m.role === 'tool');
      if (toolResultMessage?.content?.includes('Error: Tool unknown-tool not found')) {
        toolErrorCaptured = true;
        return { message: { role: 'assistant', content: 'Correctly handled error' } };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'unknown-tool', arguments: '{}' },
            },
          ],
        },
      } as LLMResponse;
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(toolErrorCaptured).toBe(true);
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
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const createLocalSpy = spyOn(MCPClient, 'createLocal').mockImplementation(async () => {
      const client = Object.create(MCPClient.prototype);
      spyOn(client, 'initialize').mockRejectedValue(new Error('Connect failed'));
      spyOn(client, 'stop').mockReturnValue(undefined);
      return client;
    });
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      mockGetAdapter
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list tools from MCP server fail-mcp')
    );
    createLocalSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should handle MCP tool call failure', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger mcp tool',
      needs: [],
      maxIterations: 10,
      mcpServers: [{ name: 'test-mcp', command: 'node', args: [] }],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const createLocalSpy = spyOn(MCPClient, 'createLocal').mockImplementation(async () => {
      const client = Object.create(MCPClient.prototype);
      spyOn(client, 'initialize').mockResolvedValue({} as MCPResponse);
      spyOn(client, 'listTools').mockResolvedValue([{ name: 'mcp-tool', inputSchema: {} }]);
      spyOn(client, 'callTool').mockRejectedValue(new Error('Tool failed'));
      spyOn(client, 'stop').mockReturnValue(undefined);
      return client;
    });

    let toolErrorCaptured = false;

    const chatMock = mock(async (messages: LLMMessage[]) => {
      const toolResultMessage = messages.find((m) => m.role === 'tool');
      if (toolResultMessage?.content?.includes('Error: Tool failed')) {
        toolErrorCaptured = true;
        return { message: { role: 'assistant', content: 'Handled tool failure' } };
      }
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'mcp-tool', arguments: '{}' } },
          ],
        },
      };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(toolErrorCaptured).toBe(true);

    createLocalSpy.mockRestore();
  });

  it('should use global MCP servers when useGlobalMcp is true', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'global-mcp': { type: 'local', command: 'node', args: ['server.js'], timeout: 1000 },
      },
      providers: {
        openai: { type: 'openai', api_key_env: 'OPENAI_API_KEY' },
      },
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    });

    const manager = new MCPManager();
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
      useGlobalMcp: true,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const createLocalSpy = spyOn(MCPClient, 'createLocal').mockImplementation(async () => {
      const client = Object.create(MCPClient.prototype);
      spyOn(client, 'initialize').mockResolvedValue({} as MCPResponse);
      spyOn(client, 'listTools').mockResolvedValue([
        { name: 'global-tool', description: 'A global tool', inputSchema: {} },
      ]);
      spyOn(client, 'stop').mockReturnValue(undefined);
      return client;
    });

    let toolFound = false;
    const chatMock = mock(async (_messages: LLMMessage[], options: { tools?: LLMTool[] }) => {
      if (options.tools?.some((t: LLMTool) => t.function.name === 'global-tool')) {
        toolFound = true;
      }
      return { message: { role: 'assistant', content: 'hello' } };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      manager,
      undefined,
      undefined,
      getAdapter
    );

    expect(toolFound).toBe(true);

    createLocalSpy.mockRestore();
    ConfigLoader.clear();
  });

  it('should support ad-hoc tools defined in the step', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger adhoc tool',
      needs: [],
      maxIterations: 10,
      tools: [
        {
          name: 'adhoc-tool',
          execution: {
            id: 'adhoc-step',
            type: 'shell',
            run: 'echo "adhoc"',
          },
        },
      ],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    let toolExecuted = false;
    const executeStepFn = async (s: Step) => {
      if (s.id === 'adhoc-step') {
        toolExecuted = true;
        return { status: 'success' as const, output: { stdout: 'adhoc result' } };
      }
      return { status: 'success' as const, output: 'ok' };
    };

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      mockGetAdapter
    );

    expect(toolExecuted).toBe(true);
  });

  it('should expose handoff tool and execute engine step', async () => {
    let chatCount = 0;
    const handoffChat = mock(async () => {
      chatCount++;
      if (chatCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-handoff',
                type: 'function',
                function: { name: 'handoff', arguments: '{"task":"do it"}' },
              },
            ],
          },
        };
      }
      return {
        message: { role: 'assistant', content: 'done' },
      };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(handoffChat);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger handoff',
      needs: [],
      maxIterations: 5,
      handoff: {
        name: 'handoff',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
        },
        engine: {
          command: 'bun',
          args: ['-e', 'console.log("ok")'],
          env: { PATH: '${{ env.PATH }}' },
          cwd: '.',
          outputSchema: { type: 'object' },
        },
      },
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    let capturedStep: Step | undefined;
    const executeStepFn = mock(async (s: Step) => {
      capturedStep = s;
      return { status: 'success' as const, output: { summary: { ok: true } } };
    });

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(capturedStep?.type).toBe('engine');
    expect(chatCount).toBe(2);
  });

  it('should handle global MCP server name without manager', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
      mcpServers: ['some-global-server'],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console, // Passing console as logger but no manager
      undefined,
      undefined,
      undefined,
      mockGetAdapter
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cannot reference global MCP server 'some-global-server' without MCPManager"
      )
    );
    consoleSpy.mockRestore();
  });

  it('should not add global MCP server if already explicitly listed', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'test-mcp': { type: 'local', command: 'node', args: ['server.js'], timeout: 1000 },
      },
      providers: { openai: { type: 'openai', api_key_env: 'OPENAI_API_KEY' } },
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    });

    const manager = new MCPManager();
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
      useGlobalMcp: true,
      mcpServers: [{ name: 'test-mcp', command: 'node', args: ['local.js'] }],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const createLocalSpy = spyOn(MCPClient, 'createLocal').mockImplementation(async () => {
      const client = Object.create(MCPClient.prototype);
      spyOn(client, 'initialize').mockResolvedValue({} as MCPResponse);
      spyOn(client, 'listTools').mockResolvedValue([]);
      spyOn(client, 'stop').mockReturnValue(undefined);
      return client;
    });

    const chatMock = mock(async () => ({
      message: { role: 'assistant', content: 'hello' },
    })) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const managerSpy = spyOn(manager, 'getGlobalServers');

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      manager,
      undefined,
      undefined,
      getAdapter
    );

    expect(managerSpy).toHaveBeenCalled();
    // It should only have 1 MCP server (the explicit one)
    // We can check this by seeing how many times initialize was called if they were different,
    // but here we just want to ensure it didn't push the global one again.

    // Actually, createLocal will be called for 'test-mcp' (explicitly listed)
    expect(createLocalSpy).toHaveBeenCalledTimes(1);

    createLocalSpy.mockRestore();
    managerSpy.mockRestore();
    ConfigLoader.clear();
  });

  it('should handle object prompts by stringifying them', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: '${{ steps.prev.output }}' as unknown as string,
      needs: [],
      maxIterations: 10,
    };
    const context: ExpressionContext = {
      inputs: {},
      steps: {
        prev: { output: { key: 'value' }, status: 'success' },
      },
    };

    let capturedPrompt = '';
    const chatMock = mock(async (messages: LLMMessage[]) => {
      // console.log('MESSAGES:', JSON.stringify(messages, null, 2));
      capturedPrompt = messages.find((m) => m.role === 'user')?.content || '';
      return { message: { role: 'assistant', content: 'Response' } };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(capturedPrompt).toContain('"key": "value"');
    expect(capturedPrompt).not.toContain('[object Object]');
  });
});
