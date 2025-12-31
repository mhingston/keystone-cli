/**
 * LLM Test Setup - Helper for setting up LLM mocks
 *
 * This file provides helpers to mock the LLM adapter using spyOn, allowing
 * tests to opt-in to mocking rather than having it applied globally.
 */
import { mock, spyOn } from 'bun:test';
import * as llmAdapter from '../llm-adapter';

// Create singleton mock functions that all test files share
export const mockGetModel = mock();
export const mockGetEmbeddingModel = mock();
export const mockResetProviderRegistry = mock();
export const mockDynamicProviderRegistry = { getProvider: mock() };

// Shared types for test responses
export interface MockLLMResponse {
  message: {
    role: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Global current chat function that tests can set
let _currentChatFn: (messages: any[], options?: any) => Promise<MockLLMResponse> = async () => ({
  message: { role: 'assistant', content: 'Default mock response' },
});

export function setCurrentChatFn(fn: typeof _currentChatFn) {
  _currentChatFn = fn;
}

export function getCurrentChatFn() {
  return _currentChatFn;
}

/**
 * Creates a unified mock model that simulates AI SDK LanguageModel behavior.
 */
export function createUnifiedMockModel() {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async (options: any) => {
      const mapMessages = (prompt: any[]) =>
        prompt.flatMap((m: any) => {
          let content = m.content || '';
          if (Array.isArray(m.content)) {
            const toolResults = m.content.filter((p: any) => p && p.type === 'tool-result');
            if (toolResults.length > 0) {
              return toolResults.map((tr: any) => ({
                role: 'tool',
                tool_call_id: tr.toolCallId,
                content: JSON.stringify(tr.result),
              }));
            }
            const textParts = m.content
              .filter((p: any) => p && p.type === 'text')
              .map((p: any) => p.text)
              .join('');
            if (textParts) content = textParts;
          }
          return [
            {
              role: m.role,
              content: typeof content === 'string' ? content : JSON.stringify(content),
            },
          ];
        });

      const messages = mapMessages(options.prompt || options.input || []);
      const tools = (options.tools || options.mode?.tools)?.map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || t.inputSchema,
        },
      }));

      const response = await _currentChatFn(messages, { tools });

      const toolCalls = response.message.tool_calls?.map((tc: any) => ({
        type: 'tool-call' as const,
        toolCallId: tc.id,
        toolName: tc.function.name,
        args:
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
      }));

      const finalToolCalls = toolCalls && toolCalls.length > 0 ? toolCalls : undefined;
      const text = response.message.content || ' ';

      // Internal AI SDK v6.0.3+ seems to expect 'content' on the result object
      // during generateText processing, even if not in the official v2 spec.
      const content: any[] = [];
      if (text) {
        content.push({ type: 'text', text });
      }
      if (finalToolCalls && finalToolCalls.length > 0) {
        for (const tc of finalToolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            input: JSON.stringify(tc.args), // Add required input field
          });
        }
      }

      return {
        text,
        content,
        toolCalls: finalToolCalls,
        finishReason: finalToolCalls ? 'tool-calls' : 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
        rawResponse: { headers: {} },
        responseMessages: [
          {
            role: 'assistant',
            content,
          },
        ],
      } as any;
    },
    doStream: async (options: any) => {
      const mapMessages = (prompt: any[]) =>
        prompt.flatMap((m: any) => {
          let content = m.content || '';
          if (Array.isArray(m.content)) {
            const toolResults = m.content.filter((p: any) => p && p.type === 'tool-result');
            if (toolResults.length > 0) {
              return toolResults.map((tr: any) => ({
                role: 'tool',
                tool_call_id: tr.toolCallId,
                content: JSON.stringify(tr.result),
              }));
            }
            const textParts = m.content
              .filter((p: any) => p && p.type === 'text')
              .map((p: any) => p.text)
              .join('');
            if (textParts) content = textParts;
          }
          return [
            {
              role: m.role,
              content: typeof content === 'string' ? content : JSON.stringify(content),
            },
          ];
        });

      const messages = mapMessages(options.prompt || options.input || []);
      const tools = (options.tools || options.mode?.tools)?.map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || t.inputSchema,
        },
      }));

      const response = await _currentChatFn(messages, { tools });

      const stream = new ReadableStream({
        async start(controller) {
          if (response.message.content) {
            controller.enqueue({
              type: 'text-delta',
              delta: response.message.content,
              text: response.message.content,
            });
          }

          const toolCalls = response.message.tool_calls?.map((tc: any) => ({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            args:
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments,
            id: tc.id,
            name: tc.function.name,
            input:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
          }));

          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              controller.enqueue(tc);
            }
          }

          controller.enqueue({
            type: 'finish',
            finishReason: toolCalls?.length ? 'tool-calls' : 'stop',
            usage: { promptTokens: 10, completionTokens: 5 },
          });

          controller.close();
        },
      });

      return { stream, rawResponse: { headers: {} } };
    },
    doEmbed: async (options: any) => {
      return {
        embeddings: options.values.map(() => [0.1, 0.2, 0.3]),
        usage: { tokens: 5 },
      };
    },
  };
}

/**
 * Sets up the LLM mocks by mocking the provider packages.
 * This allows llm-adapter to run its real logic but return mock models.
 */

import { resetProviderRegistry } from '../llm-adapter';

export function setupLlmMocks() {
  resetProviderRegistry(); // Clear cache to ensure new mock is used

  // Provider factory (e.g. createOpenAI) returns a Provider Instance function
  const mockProviderInstance = (modelId: string) => createUnifiedMockModel();
  const mockProviderFactory = (options?: any) => mockProviderInstance;

  // Add properties that some providers might export (like 'openai' object)
  const mockProviderModule = {
    openai: mockProviderFactory,
    createOpenAI: mockProviderFactory,
    anthropic: mockProviderFactory,
    createAnthropic: mockProviderFactory,
    google: mockProviderFactory,
    createGoogleGenerativeAI: mockProviderFactory,
    default: mockProviderFactory,
  };

  // Mock the provider packages
  mock.module('@ai-sdk/openai', () => mockProviderModule);
  mock.module('@ai-sdk/anthropic', () => mockProviderModule);
  mock.module('@ai-sdk/google', () => mockProviderModule);

  _currentChatFn = async () => ({
    message: { role: 'assistant', content: 'Default mock response' },
  });
}

/**
 * Resets all mocks to default state. Call in afterEach.
 */
export function resetLlmMocks() {
  resetProviderRegistry();
  _currentChatFn = async () => ({
    message: { role: 'assistant', content: 'Default mock response' },
  });
}
