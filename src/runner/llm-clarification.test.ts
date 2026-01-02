// Import shared mock setup FIRST (mock.module is in preload, these are the mock references)
import {
  type MockLLMResponse,
  createUnifiedMockModel,
  mockGetModel,
  resetLlmMocks,
  setCurrentChatFn,
  setupLlmMocks,
} from './__test__/llm-test-setup';

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ExpressionContext } from '../expression/evaluator';
import * as agentParser from '../parser/agent-parser';
import type { Config } from '../parser/config-schema';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import * as llmAdapter from './llm-adapter';
import type { LLMMessage } from './llm-adapter';
import type { StepResult } from './step-executor';

// Note: mock.module() is now handled by the preload file

// Dynamic import holder
let executeLlmStep: any;

// Local chat function wrapper
let currentChatFn: (messages: any[], options?: any) => Promise<MockLLMResponse>;

describe('LLM Clarification', () => {
  let resolveAgentPathSpy: ReturnType<typeof spyOn>;
  let parseAgentSpy: ReturnType<typeof spyOn>;
  let getModelSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    setupLlmMocks();
    getModelSpy = spyOn(llmAdapter, 'getModel').mockResolvedValue(createUnifiedMockModel() as any);
    const module = await import('./executors/llm-executor.ts');
    executeLlmStep = module.executeLlmStep;
  });

  beforeEach(() => {
    // jest.restoreAllMocks();
    ConfigLoader.clear();
    setupLlmMocks();
    resetLlmMocks();
    resolveAgentPathSpy = spyOn(agentParser, 'resolveAgentPath').mockReturnValue('test-agent.md');
    parseAgentSpy = spyOn(agentParser, 'parseAgent').mockReturnValue({
      name: 'test-agent',
      systemPrompt: 'test system prompt',
      tools: [],
      model: 'gpt-4o',
    } as unknown as Agent);
    ConfigLoader.setConfig({
      default_provider: 'test-provider',
      providers: {
        'test-provider': {
          type: 'openai',
          package: '@ai-sdk/openai',
        },
      },
      model_mappings: {},
    } as unknown as Config);
  });

  afterEach(() => {
    ConfigLoader.clear();
    resolveAgentPathSpy.mockRestore();
    parseAgentSpy.mockRestore();
    getModelSpy?.mockClear();
    resetLlmMocks();
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

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

    let capturedTools: any[] = [];
    currentChatFn = async (messages, options) => {
      capturedTools = options?.tools || [];
      return {
        message: { role: 'assistant', content: 'Final response' },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    await executeLlmStep(step, context, executeStepFn, undefined, undefined, undefined, undefined);

    expect(capturedTools.some((t: any) => t.function.name === 'ask')).toBe(true);
  });

  it('should suspend in non-TTY when ask is called', async () => {
    const originalIsTTY = process.stdin.isTTY;
    // @ts-ignore
    process.stdin.isTTY = false;

    try {
      currentChatFn = async () => {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-ask',
                type: 'function',
                function: {
                  name: 'ask',
                  arguments: '{"question": "What is your name?"}',
                },
              },
            ],
          },
        };
      };
      setCurrentChatFn(currentChatFn as any);

      const step: LlmStep = {
        id: 'test-step',
        type: 'llm',
        agent: 'test-agent',
        prompt: 'test prompt',
        allowClarification: true,
        needs: [],
        maxIterations: 10,
      };

      const context: ExpressionContext = { inputs: {}, steps: {} };
      const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

      const result = await executeLlmStep(
        step,
        context,
        executeStepFn,
        undefined,
        undefined,
        undefined,
        undefined
      );

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

    // Context with answer from a previous suspended state
    const context: ExpressionContext = {
      inputs: {
        'test-step': { __answer: 'My name is Keystone' },
      },
      output: {},
      steps: {
        'test-step': {
          output: {
            question: 'What is your name?',
            messages: [
              { role: 'system', content: 'test system prompt' },
              { role: 'user', content: 'test prompt' },
              {
                role: 'assistant',
                content: '', // Use empty string instead of null for AI SDK compatibility
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

    let receivedMessages: any[] | undefined;
    currentChatFn = async (messages) => {
      receivedMessages = messages;
      return {
        message: { role: 'assistant', content: 'Hello Keystone' },
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    const executeStepFn = mock(async () => ({ output: 'ok', status: 'success' as const }));

    const result = await executeLlmStep(
      step,
      context,
      executeStepFn,
      undefined,
      undefined,
      undefined,
      undefined
    );

    expect(result.output).toBe('Hello Keystone');
    // Verify messages were received by the model
    expect(receivedMessages).toBeDefined();
  });
});
