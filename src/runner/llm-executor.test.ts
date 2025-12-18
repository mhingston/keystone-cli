import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import type { LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import {
  AnthropicAdapter,
  CopilotAdapter,
  type LLMMessage,
  type LLMResponse,
  type LLMTool,
  OpenAIAdapter,
} from './llm-adapter';
import { executeLlmStep } from './llm-executor';
import { MCPClient, type MCPResponse } from './mcp-client';
import { MCPManager } from './mcp-manager';
import type { StepResult } from './step-executor';

// Mock adapters
const originalOpenAIChat = OpenAIAdapter.prototype.chat;
const originalCopilotChat = CopilotAdapter.prototype.chat;
const originalAnthropicChat = AnthropicAdapter.prototype.chat;

describe('llm-executor', () => {
  const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');

  beforeAll(() => {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (e) {}
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

    const mockChat = async (messages: unknown[], _options?: unknown) => {
      const lastMessage = messages[messages.length - 1] as { content?: string };
      const systemMessage = messages.find(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          'role' in m &&
          (m as { role: string }).role === 'system'
      ) as { content?: string } | undefined;

      if (systemMessage?.content?.includes('IMPORTANT: You must output valid JSON')) {
        return {
          message: { role: 'assistant', content: '```json\n{"foo": "bar"}\n```' },
        };
      }

      if (lastMessage?.content?.includes('trigger tool')) {
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

      if (lastMessage?.content?.includes('trigger adhoc tool')) {
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
      return {
        message: { role: 'assistant', content: 'LLM Response' },
      };
    };

    OpenAIAdapter.prototype.chat = mock(mockChat) as unknown as typeof originalOpenAIChat;
    CopilotAdapter.prototype.chat = mock(mockChat) as unknown as typeof originalCopilotChat;
    AnthropicAdapter.prototype.chat = mock(mockChat) as unknown as typeof originalAnthropicChat;
  });

  afterAll(() => {
    OpenAIAdapter.prototype.chat = originalOpenAIChat;
    CopilotAdapter.prototype.chat = originalCopilotChat;
    AnthropicAdapter.prototype.chat = originalAnthropicChat;
  });

  it('should execute a simple LLM step', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
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
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );
    expect(result.status).toBe('success');
    expect(result.output).toBe('LLM Response');
  });

  it('should support schema for JSON output', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me json',
      needs: [],
      schema: {
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
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ foo: 'bar' });
  });

  it('should throw error if JSON parsing fails for schema', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'give me invalid json',
      needs: [],
      schema: { type: 'object' },
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    // Mock response with invalid JSON
    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const originalCopilotChatInner = CopilotAdapter.prototype.chat;
    const originalAnthropicChatInner = AnthropicAdapter.prototype.chat;

    const mockChat = mock(async () => ({
      message: { role: 'assistant', content: 'Not JSON' },
    })) as unknown as typeof originalOpenAIChat;

    OpenAIAdapter.prototype.chat = mockChat;
    CopilotAdapter.prototype.chat = mockChat;
    AnthropicAdapter.prototype.chat = mockChat;

    await expect(
      executeLlmStep(
        step,
        context,
        executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
      )
    ).rejects.toThrow(/Failed to parse LLM output as JSON/);

    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
    CopilotAdapter.prototype.chat = originalCopilotChatInner;
    AnthropicAdapter.prototype.chat = originalAnthropicChatInner;
  });

  it('should handle tool not found', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger unknown tool',
      needs: [],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    let toolErrorCaptured = false;
    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const originalCopilotChatInner = CopilotAdapter.prototype.chat;
    const originalAnthropicChatInner = AnthropicAdapter.prototype.chat;

    const mockChat = mock(async (messages: LLMMessage[]) => {
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
    }) as unknown as typeof originalOpenAIChat;

    OpenAIAdapter.prototype.chat = mockChat;
    CopilotAdapter.prototype.chat = mockChat;
    AnthropicAdapter.prototype.chat = mockChat;

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );

    expect(toolErrorCaptured).toBe(true);
    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
    CopilotAdapter.prototype.chat = originalCopilotChatInner;
    AnthropicAdapter.prototype.chat = originalAnthropicChatInner;
  });

  it('should handle MCP connection failure', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      mcpServers: [{ name: 'fail-mcp', command: 'node', args: [] }],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const spy = spyOn(MCPClient.prototype, 'initialize').mockRejectedValue(
      new Error('Connect failed')
    );
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect to MCP server fail-mcp')
    );
    spy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should handle MCP tool call failure', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger mcp tool',
      needs: [],
      mcpServers: [{ name: 'test-mcp', command: 'node', args: [] }],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const initSpy = spyOn(MCPClient.prototype, 'initialize').mockResolvedValue({} as MCPResponse);
    const listSpy = spyOn(MCPClient.prototype, 'listTools').mockResolvedValue([
      { name: 'mcp-tool', inputSchema: {} },
    ]);
    const callSpy = spyOn(MCPClient.prototype, 'callTool').mockRejectedValue(
      new Error('Tool failed')
    );

    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const originalCopilotChatInner = CopilotAdapter.prototype.chat;
    const originalAnthropicChatInner = AnthropicAdapter.prototype.chat;
    let toolErrorCaptured = false;

    const mockChat = mock(async (messages: LLMMessage[]) => {
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
    }) as unknown as typeof originalOpenAIChat;

    OpenAIAdapter.prototype.chat = mockChat;
    CopilotAdapter.prototype.chat = mockChat;
    AnthropicAdapter.prototype.chat = mockChat;

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );

    expect(toolErrorCaptured).toBe(true);

    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
    CopilotAdapter.prototype.chat = originalCopilotChatInner;
    AnthropicAdapter.prototype.chat = originalAnthropicChatInner;
    initSpy.mockRestore();
    listSpy.mockRestore();
    callSpy.mockRestore();
  });

  it('should use global MCP servers when useGlobalMcp is true', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'global-mcp': { command: 'node', args: ['server.js'] },
      },
      providers: {
        openai: { apiKey: 'test' },
      },
      model_mappings: {},
      default_provider: 'openai',
    });

    const manager = new MCPManager();
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      useGlobalMcp: true,
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const initSpy = spyOn(MCPClient.prototype, 'initialize').mockResolvedValue({} as MCPResponse);
    const listSpy = spyOn(MCPClient.prototype, 'listTools').mockResolvedValue([
      { name: 'global-tool', description: 'A global tool', inputSchema: {} },
    ]);

    let toolFound = false;
    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const mockChat = mock(async (_messages: LLMMessage[], options: { tools?: LLMTool[] }) => {
      if (options.tools?.some((t: LLMTool) => t.function.name === 'global-tool')) {
        toolFound = true;
      }
      return { message: { role: 'assistant', content: 'hello' } };
    }) as unknown as typeof originalOpenAIChat;

    OpenAIAdapter.prototype.chat = mockChat;

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      manager
    );

    expect(toolFound).toBe(true);

    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
    initSpy.mockRestore();
    listSpy.mockRestore();
    ConfigLoader.clear();
  });

  it('should support ad-hoc tools defined in the step', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'trigger adhoc tool',
      needs: [],
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
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );

    expect(toolExecuted).toBe(true);
  });

  it('should handle global MCP server name without manager', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      mcpServers: ['some-global-server'],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console // Passing console as logger but no manager
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
        'test-mcp': { command: 'node', args: ['server.js'] },
      },
      providers: { openai: { apiKey: 'test' } },
      model_mappings: {},
      default_provider: 'openai',
    });

    const manager = new MCPManager();
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'hello',
      needs: [],
      useGlobalMcp: true,
      mcpServers: [{ name: 'test-mcp', command: 'node', args: ['local.js'] }],
    };
    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    const initSpy = spyOn(MCPClient.prototype, 'initialize').mockResolvedValue({} as MCPResponse);
    const listSpy = spyOn(MCPClient.prototype, 'listTools').mockResolvedValue([]);

    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const mockChat = mock(async () => ({
      message: { role: 'assistant', content: 'hello' },
    })) as unknown as typeof originalOpenAIChat;
    OpenAIAdapter.prototype.chat = mockChat;

    const managerSpy = spyOn(manager, 'getGlobalServers');

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
      console,
      manager
    );

    expect(managerSpy).toHaveBeenCalled();
    // It should only have 1 MCP server (the explicit one)
    // We can check this by seeing how many times initialize was called if they were different,
    // but here we just want to ensure it didn't push the global one again.

    // Actually, initialize will be called for 'test-mcp' (explicitly listed)
    expect(initSpy).toHaveBeenCalledTimes(1);

    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
    initSpy.mockRestore();
    listSpy.mockRestore();
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
    };
    const context: ExpressionContext = {
      inputs: {},
      steps: {
        prev: { output: { key: 'value' }, status: 'success' },
      },
    };

    let capturedPrompt = '';
    const originalOpenAIChatInner = OpenAIAdapter.prototype.chat;
    const mockChat = mock(async (messages: LLMMessage[]) => {
      // console.log('MESSAGES:', JSON.stringify(messages, null, 2));
      capturedPrompt = messages.find((m) => m.role === 'user')?.content || '';
      return { message: { role: 'assistant', content: 'Response' } };
    }) as unknown as typeof originalOpenAIChat;
    OpenAIAdapter.prototype.chat = mockChat;
    CopilotAdapter.prototype.chat = mockChat;
    AnthropicAdapter.prototype.chat = mockChat;

    const executeStepFn = mock(async () => ({ status: 'success' as const, output: 'ok' }));

    await executeLlmStep(
      step,
      context,
      executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>
    );

    expect(capturedPrompt).toContain('"key": "value"');
    expect(capturedPrompt).not.toContain('[object Object]');

    OpenAIAdapter.prototype.chat = originalOpenAIChatInner;
  });
});
