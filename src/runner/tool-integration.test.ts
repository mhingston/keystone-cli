import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import type { LlmStep, Step } from '../parser/schema';
import type { LLMAdapter } from './llm-adapter';
import { executeLlmStep } from './llm-executor';
import { MCPClient, type MCPResponse } from './mcp-client';
import type { StepResult } from './step-executor';

interface MockToolCall {
  function: {
    name: string;
  };
}

describe('llm-executor with tools and MCP', () => {
  const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
  const agentPath = join(agentsDir, 'tool-test-agent.md');
  const createMockGetAdapter = (chatFn: LLMAdapter['chat']) => {
    return (_modelString: string) => ({
      adapter: { chat: chatFn } as LLMAdapter,
      resolvedModel: 'gpt-4',
    });
  };

  beforeAll(() => {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (e) {
      // Ignore error
    }
    const agentContent = `---
name: tool-test-agent
tools:
  - name: agent-tool
    execution:
      id: agent-tool-exec
      type: shell
      run: echo "agent tool"
---
Test system prompt`;
    writeFileSync(agentPath, agentContent);
  });

  afterAll(() => {
    try {
      unlinkSync(agentPath);
    } catch (e) {
      // Ignore error
    }
  });

  it('should merge tools from agent, step and MCP', async () => {
    let capturedTools: MockToolCall[] = [];

    const mockChat = mock(async (_messages: unknown, options: unknown) => {
      capturedTools = (options as { tools?: MockToolCall[] })?.tools || [];
      return {
        message: { role: 'assistant', content: 'Final response' },
      };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(mockChat);

    // Use mock.module for MCPClient
    const originalInitialize = MCPClient.prototype.initialize;
    const originalListTools = MCPClient.prototype.listTools;
    const originalStop = MCPClient.prototype.stop;

    const mockInitialize = mock(async () => ({}) as MCPResponse);
    const mockListTools = mock(async () => [
      {
        name: 'mcp-tool',
        description: 'MCP tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    const mockStop = mock(() => {});

    MCPClient.prototype.initialize = mockInitialize;
    MCPClient.prototype.listTools = mockListTools;
    MCPClient.prototype.stop = mockStop;

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
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    const toolNames = capturedTools.map((t) => t.function.name);
    expect(toolNames).toContain('agent-tool');
    expect(toolNames).toContain('step-tool');
    expect(toolNames).toContain('mcp-tool');

    MCPClient.prototype.initialize = originalInitialize;
    MCPClient.prototype.listTools = originalListTools;
    MCPClient.prototype.stop = originalStop;
  });

  it('should execute MCP tool when called', async () => {
    let chatCount = 0;

    const mockChat = mock(async () => {
      chatCount++;
      if (chatCount === 1) {
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
      }
      return {
        message: { role: 'assistant', content: 'Done' },
      };
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(mockChat);

    const originalInitialize = MCPClient.prototype.initialize;
    const originalListTools = MCPClient.prototype.listTools;
    const originalCallTool = MCPClient.prototype.callTool;
    const originalStop = MCPClient.prototype.stop;

    const mockInitialize = mock(async () => ({}) as MCPResponse);
    const mockListTools = mock(async () => [
      {
        name: 'mcp-tool',
        description: 'MCP tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    const mockCallTool = mock(async () => ({ result: 'mcp success' }));
    const mockStop = mock(() => {});

    MCPClient.prototype.initialize = mockInitialize;
    MCPClient.prototype.listTools = mockListTools;
    MCPClient.prototype.callTool = mockCallTool;
    MCPClient.prototype.stop = mockStop;

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'tool-test-agent',
      prompt: 'test',
      needs: [],
      maxIterations: 10,
      mcpServers: [{ name: 'test-mcp', command: 'node', args: ['-e', ''] }],
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = async () => ({ status: 'success' as const, output: {} });

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

    expect(mockCallTool).toHaveBeenCalledWith('mcp-tool', {});
    expect(chatCount).toBe(2);

    MCPClient.prototype.initialize = originalInitialize;
    MCPClient.prototype.listTools = originalListTools;
    MCPClient.prototype.callTool = originalCallTool;
    MCPClient.prototype.stop = originalStop;
  });
});
