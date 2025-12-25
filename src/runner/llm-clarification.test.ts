import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ExpressionContext } from '../expression/evaluator';
import * as agentParser from '../parser/agent-parser';
import type { Config } from '../parser/config-schema';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import { type LLMMessage, OpenAIAdapter } from './llm-adapter';
import { executeLlmStep } from './llm-executor';

describe('LLM Clarification', () => {
  const originalChat = OpenAIAdapter.prototype.chat;

  beforeEach(() => {
    spyOn(agentParser, 'resolveAgentPath').mockReturnValue('test-agent.md');
    spyOn(agentParser, 'parseAgent').mockReturnValue({
      name: 'test-agent',
      systemPrompt: 'test system prompt',
      tools: [],
      model: 'gpt-4o',
    } as unknown as Agent);

    ConfigLoader.setConfig({
      providers: {
        openai: { type: 'openai', api_key_env: 'OPENAI_API_KEY' },
      },
      default_provider: 'openai',
      model_mappings: {},
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    } as unknown as Config);
  });

  afterEach(() => {
    OpenAIAdapter.prototype.chat = originalChat;
    mock.restore();
  });

  it('should inject ask tool when allowClarification is true', async () => {
    const step: LlmStep = {
      id: 'test-step',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'test prompt',
      allowClarification: true,
      needs: [],
      maxIterations: 10,
    };

    const context: ExpressionContext = {
      inputs: {},
      output: {},
    };

    const chatMock = mock(async () => ({
      message: { role: 'assistant' as const, content: 'Final response' },
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
    OpenAIAdapter.prototype.chat = chatMock;

    const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

    await executeLlmStep(step, context, executeStepFn);

    expect(chatMock).toHaveBeenCalled();
    const calls = chatMock.mock.calls as unknown[][];
    const options = calls[0][1] as { tools?: { function: { name: string } }[] };
    expect(options.tools).toBeDefined();
    expect(options.tools?.some((t) => t.function.name === 'ask')).toBe(true);
  });

  it('should suspend in non-TTY when ask is called', async () => {
    const originalIsTTY = process.stdin.isTTY;
    // Assign directly to match step-executor.test.ts pattern
    // @ts-ignore
    process.stdin.isTTY = false;

    try {
      const step: LlmStep = {
        id: 'test-step',
        type: 'llm',
        agent: 'test-agent',
        prompt: 'test prompt',
        allowClarification: true,
        needs: [],
        maxIterations: 10,
      };

      const context: ExpressionContext = {
        inputs: {},
        output: {},
      };

      const chatMock = mock(async () => ({
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call-ask',
              type: 'function',
              function: { name: 'ask', arguments: '{"question": "What is your name?"}' },
            },
          ],
        },
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
      OpenAIAdapter.prototype.chat = chatMock;

      const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

      const result = await executeLlmStep(step, context, executeStepFn);

      expect(result.status).toBe('suspended');
      const output = result.output as { question: string; messages: unknown[] };
      expect(output.question).toBe('What is your name?');
      expect(output.messages).toBeDefined();
    } finally {
      // @ts-ignore
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('should resume correctly when answer is provided', async () => {
    const step: LlmStep = {
      id: 'test-step',
      type: 'llm',
      agent: 'test-agent',
      prompt: 'test prompt',
      allowClarification: true,
      needs: [],
      maxIterations: 10,
    };

    const context: ExpressionContext = {
      inputs: {
        'test-step': { __answer: 'My name is Keystone' },
      },
      output: {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'wrong prompt' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-wrong',
                type: 'function',
                function: { name: 'ask', arguments: '{"question": "Wrong question"}' },
              },
            ],
          },
        ] as LLMMessage[],
      },
      steps: {
        'test-step': {
          output: {
            messages: [
              { role: 'system', content: 'system prompt' },
              { role: 'user', content: 'test prompt' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-ask',
                    type: 'function',
                    function: { name: 'ask', arguments: '{"question": "What is your name?"}' },
                  },
                ],
              },
            ],
          },
          status: 'suspended',
        },
      },
    };

    const chatMock = mock(async () => ({
      message: { role: 'assistant' as const, content: 'Hello Keystone' },
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
    OpenAIAdapter.prototype.chat = chatMock;

    const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

    const result = await executeLlmStep(step, context, executeStepFn);

    expect(result.output).toBe('Hello Keystone');
    expect(chatMock).toHaveBeenCalled();
    const calls = chatMock.mock.calls as unknown[][];
    const messages = calls[0][0] as {
      role: string;
      content: string | null;
      tool_call_id?: string;
    }[];

    const toolMsg = messages.find((msg) => msg.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe('My name is Keystone');
    expect(toolMsg?.tool_call_id).toBe('call-ask');
  });
});
