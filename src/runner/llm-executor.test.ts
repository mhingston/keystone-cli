import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ExpressionContext } from '../expression/evaluator';
import type { LlmStep, Step } from '../parser/schema';
import type { LLMAdapter, LLMMessage, LLMResponse, LLMTool } from './llm-adapter';
import { executeLlmStep } from './llm-executor';
import type { MCPServerConfig } from './mcp-manager';
import type { StepResult } from './step-executor';
import { ConsoleLogger, type Logger } from '../utils/logger';
import { parseAgent } from '../parser/agent-parser';
import { ExpressionEvaluator } from '../expression/evaluator';

// Mock adapters
// Instead of mutating prototypes (which causes cross-test contamination),
// we use the getAdapterFn parameter to inject a mock adapter factory.

describe('llm-executor', () => {
  const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
  let spawnSpy: ReturnType<typeof spyOn>;

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
      defaultClient?: ReturnType<typeof createMockMcpClient>;
      errors?: Record<string, Error>;
      globalServers?: MCPServerConfig[];
    } = {}
  ) => {
    const getClient = mock(async (serverRef: string | { name: string }) => {
      const name = typeof serverRef === 'string' ? serverRef : serverRef.name;
      if (options.errors?.[name]) {
        throw options.errors[name];
      }
      if (options.clients && name in options.clients) {
        return options.clients[name];
      }
      return options.defaultClient;
    });
    const getGlobalServers = mock(() => options.globalServers ?? []);
    return { getClient, getGlobalServers };
  };

  beforeAll(async () => {
    // Mock spawn to avoid actual process creation
    const mockProcess = Object.assign(new EventEmitter(), {
      stdout: new Readable({
        read() { },
      }),
      stdin: new Writable({
        write(_chunk, _encoding, cb: (error?: Error | null) => void) {
          cb();
        },
      }),
      kill: mock(() => { }),
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

    const handoffTargetContent = `---
name: handoff-target
model: gpt-4
tools:
  - name: specialist-tool
    execution:
      type: shell
      run: echo "specialist"
---
You are the specialist for \${{ inputs.topic }}.`;
    writeFileSync(join(agentsDir, 'handoff-target.md'), handoffTargetContent);

    const contextAgentContent = `---
name: context-agent
model: gpt-4
---
You are a context-aware agent.`;
    writeFileSync(join(agentsDir, 'context-agent.md'), contextAgentContent);
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
      log: mock(() => { }),
      error: mock(() => { }),
      warn: mock(() => { }),
      info: mock(() => { }),
      debug: mock(() => { }),
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

  it('should accept native structured output tool calls when responseSchema is provided', async () => {
    const outputSchema = {
      type: 'object',
      properties: {
        foo: { type: 'string' },
      },
      required: ['foo'],
    };
    let receivedSchema: unknown;

    const chatMock = mock(async (_messages, options) => {
      receivedSchema = options?.responseSchema;
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'record_output', arguments: '{"foo":"bar"}' },
            },
          ],
        },
      };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me json',
      needs: [],
      maxIterations: 5,
      outputSchema,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

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

    expect(receivedSchema).toEqual(outputSchema);
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ foo: 'bar' });
    expect(executeStepFn).not.toHaveBeenCalled();
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

    const mcpManager = createMockMcpManager({
      errors: { 'fail-mcp': new Error('Connect failed') },
    });
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => { });

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      mcpManager as any,
      undefined,
      undefined,
      mockGetAdapter
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list tools from MCP server fail-mcp')
    );
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

    const mockClient = createMockMcpClient({
      tools: [{ name: 'mcp-tool', inputSchema: {} }],
      callTool: async () => {
        throw new Error('Tool failed');
      },
    });
    const mcpManager = createMockMcpManager({
      clients: { 'test-mcp': mockClient },
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
      mcpManager as any,
      undefined,
      undefined,
      getAdapter
    );

    expect(toolErrorCaptured).toBe(true);
  });

  it('should use global MCP servers when useGlobalMcp is true', async () => {
    const mockClient = createMockMcpClient({
      tools: [{ name: 'global-tool', description: 'A global tool', inputSchema: {} }],
    });
    const manager = createMockMcpManager({
      globalServers: [{ name: 'global-mcp', command: 'node', args: ['server.js'] }],
      defaultClient: mockClient,
    });
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
      manager as any,
      undefined,
      undefined,
      getAdapter
    );

    expect(toolFound).toBe(true);
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
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => { });

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
      expect.stringContaining("Cannot reference global MCP server 'some-global-server' without MCPManager")
    );
    consoleSpy.mockRestore();
  });

  it('should summarize messages when history is too long', async () => {
    let summaryAttempted = false;
    const chatMock = mock(async (messages: LLMMessage[]) => {
      if (messages.find((m) => m.name === 'context_summary')) {
        summaryAttempted = true;
      }
      return { message: { role: 'assistant', content: 'Resuming' } };
    }) as unknown as LLMAdapter['chat'];

    const getAdapter = (modelString: string) => {
      const mockAdapter: LLMAdapter = {
        chat: async (messages, options) => {
          if (messages[0].role === 'system' && messages[0].content?.includes('Summarize')) {
            return { message: { role: 'assistant', content: 'Summary text' } };
          }
          return chatMock(messages, options);
        },
      };
      return { adapter: mockAdapter, resolvedModel: 'gpt-4' };
    };

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'continue',
      needs: [],
      maxIterations: 1,
      maxMessageHistory: 4, // Allow at least one non-system message before summarization
      contextStrategy: 'summary',
    };

    const context: ExpressionContext = {
      inputs: {},
      steps: {
        l1: {
          output: {
            messages: [
              { role: 'user', content: 'm1' },
              { role: 'assistant', content: 'm2' },
              { role: 'user', content: 'm3' },
            ],
          },
        },
      },
    };

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

    expect(summaryAttempted).toBe(true);
  });

  it('should fall back to truncation if summarization fails', async () => {
    const logger: Logger = {
      log: mock(() => { }),
      error: mock(() => { }),
      warn: mock(() => { }),
      info: mock(() => { }),
      debug: mock(() => { }),
    };

    const getAdapter = (modelString: string) => {
      const mockAdapter: LLMAdapter = {
        chat: async (messages) => {
          if (messages[0].role === 'system' && messages[0].content?.includes('Summarize')) {
            throw new Error('Summary failed');
          }
          return { message: { role: 'assistant', content: 'Truncated response' } };
        },
      };
      return { adapter: mockAdapter, resolvedModel: 'gpt-4' };
    };

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'continue',
      needs: [],
      maxIterations: 1,
      maxMessageHistory: 4,
      contextStrategy: 'summary',
    };

    const context: ExpressionContext = {
      inputs: {},
      steps: {
        l1: {
          output: {
            messages: [
              { role: 'user', content: 'm1' },
              { role: 'assistant', content: 'm2' },
              { role: 'user', content: 'm3' },
            ],
          },
        },
      },
    };

    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      logger,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Context summarization failed'));
  });

  it('should extract thought blocks and emit thought events', async () => {
    const logger: Logger = {
      log: mock(() => { }),
      error: mock(() => { }),
      warn: mock(() => { }),
      info: mock(() => { }),
    };

    const emitEvent = mock(() => { });
    const eventContext = { runId: 'run-1', workflow: 'wf-1' };

    const chatMock = mock(async () => {
      return {
        message: {
          role: 'assistant',
          content: '<thinking>I should do X</thinking>Final answer',
        },
      };
    }) as unknown as LLMAdapter['chat'];

    const getAdapter = () => ({
      adapter: { chat: chatMock },
      resolvedModel: 'gpt-4',
    });

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      maxIterations: 10,
    };

    await executeLlmStep(
      step,
      { inputs: {}, steps: {} },
      mock(async () => ({ status: 'success' as const, output: 'ok' })) as any,
      logger,
      undefined,
      undefined,
      undefined,
      getAdapter as any,
      emitEvent,
      eventContext
    );

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Thought (thinking): I should do X'));
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'llm.thought',
        content: 'I should do X',
        source: 'thinking',
      })
    );
  });


  it('should not add global MCP server if already explicitly listed', async () => {
    const mockClient = createMockMcpClient();
    const manager = createMockMcpManager({
      globalServers: [{ name: 'test-mcp', command: 'node', args: ['server.js'] }],
      defaultClient: mockClient,
    });
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

    const chatMock = mock(async () => ({
      message: { role: 'assistant', content: 'hello' },
    })) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      manager as any,
      undefined,
      undefined,
      getAdapter
    );

    expect(manager.getGlobalServers).toHaveBeenCalled();
    expect(manager.getClient).toHaveBeenCalledTimes(1);
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

  it('should evaluate expressions in agent system prompts', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'handoff-target',
      prompt: 'hello',
      needs: [],
      maxIterations: 3,
    };
    const context: ExpressionContext = { inputs: { topic: 'payments' }, steps: {} };
    let capturedSystem = '';

    const chatMock = mock(async (messages: LLMMessage[]) => {
      const systemMessages = messages.filter((m) => m.role === 'system');
      capturedSystem =
        (systemMessages.find((m) => typeof m.content === 'string')?.content as string) || '';
      return { message: { role: 'assistant', content: 'ok' } };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

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
    expect(capturedSystem).toContain('payments');
    expect(capturedSystem).not.toContain('${{');
  });

  it('should handle streaming chunks with thoughts', async () => {
    const step = {
      id: 'l-stream',
      type: 'llm' as const,
      agent: 'test-agent',
      prompt: 'stream this',
      needs: [],
      maxIterations: 1,
    };

    // We can't easily add 'stream' to LlmStep without changing schema,
    // but we can mock the adapter to stream if onStream is provided.

    const chatMock = mock(async function (messages: LLMMessage[], options: any) {
      if (options.onStream) {
        options.onStream('<thinking>thought</thinking>done');
      }
      return { message: { role: 'assistant', content: '<thinking>thought</thinking>done' } };
    }) as unknown as LLMAdapter['chat'];

    const adapter = {
      chat: chatMock,
    } as any;

    const context: ExpressionContext = { inputs: {}, steps: {} };
    spyOn(process.stdout, 'write').mockImplementation(() => true);

    const emitThought = mock(() => { });

    await executeLlmStep(
      step as any,
      context,
      mock(async () => ({ status: 'success' as const, output: 'ok' })) as any,
      new ConsoleLogger(),
      undefined,
      undefined,
      undefined,
      () => ({ adapter, resolvedModel: 'test-model' }),
      emitThought,
      { runId: 'test-run', workflow: 'test-wf' }
    );

    expect(emitThought).toHaveBeenCalled();
  });

  it('should transfer to allowed agent and swap system prompt/tools', async () => {
    let callCount = 0;
    let sawTransferTool = false;
    let sawOriginalTool = false;
    let sawTargetToolAfter = false;
    let sawOriginalToolAfter = false;
    let sawTargetPrompt = false;

    const chatMock = mock(
      async (messages: LLMMessage[], options: { tools?: LLMTool[] }) => {
        callCount++;
        const toolNames = options.tools?.map((t) => t.function.name) || [];

        if (callCount === 1) {
          sawTransferTool = toolNames.includes('transfer_to_agent');
          sawOriginalTool = toolNames.includes('test-tool');
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-transfer',
                  type: 'function',
                  function: {
                    name: 'transfer_to_agent',
                    arguments: '{"agent_name":"handoff-target"}',
                  },
                },
              ],
            },
          };
        }

        const systemMessages = messages.filter((m) => m.role === 'system');
        sawTargetPrompt = systemMessages.some(
          (m) => typeof m.content === 'string' && m.content.includes('specialist for billing')
        );
        sawTargetToolAfter = toolNames.includes('specialist-tool');
        sawOriginalToolAfter = toolNames.includes('test-tool');

        return {
          message: { role: 'assistant', content: 'done' },
        };
      }
    ) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'handoff',
      needs: [],
      maxIterations: 4,
      allowedHandoffs: ['handoff-target'],
    };
    const context: ExpressionContext = { inputs: { topic: 'billing' }, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

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
    expect(sawTransferTool).toBe(true);
    expect(sawOriginalTool).toBe(true);
    expect(sawTargetToolAfter).toBe(true);
    expect(sawOriginalToolAfter).toBe(false);
    expect(sawTargetPrompt).toBe(true);
  });

  it('should apply context updates from tool output', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'context-agent',
      prompt: 'update context',
      needs: [],
      maxIterations: 4,
      tools: [
        {
          name: 'update-context',
          execution: {
            id: 'update-step',
            type: 'shell',
            run: 'echo update',
          },
        },
        {
          name: 'read-context',
          execution: {
            id: 'read-step',
            type: 'shell',
            run: 'echo read',
          },
        },
      ],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    let sawEnvUpdate = false;
    let sawMemoryUpdate = false;

    const executeStepFn = async (_step: Step, toolContext: ExpressionContext) => {
      if (_step.id === 'update-step') {
        return {
          status: 'success' as const,
          output: {
            __keystone_context: {
              env: { USER_ID: '123' },
              memory: { user: 'Ada' },
            },
            ok: true,
          },
        };
      }
      if (_step.id === 'read-step') {
        sawEnvUpdate = toolContext.env?.USER_ID === '123';
        sawMemoryUpdate = toolContext.memory?.user === 'Ada';
        return { status: 'success' as const, output: { seen: true } };
      }
      return { status: 'success' as const, output: 'ok' };
    };

    let callCount = 0;
    const chatMock = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-update',
                type: 'function',
                function: { name: 'update-context', arguments: '{}' },
              },
              {
                id: 'call-read',
                type: 'function',
                function: { name: 'read-context', arguments: '{}' },
              },
            ],
          },
        };
      }
      return { message: { role: 'assistant', content: 'done' } };
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

    expect(sawEnvUpdate).toBe(true);
    expect(sawMemoryUpdate).toBe(true);
  });
});
