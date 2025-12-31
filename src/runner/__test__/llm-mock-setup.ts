/**
 * Shared test mock setup for LLM adapter
 *
 * This file provides a unified mock model and setup utilities for tests
 * that need to mock the LLM adapter without affecting other test files.
 *
 * Usage:
 * 1. Import this at the top of your test file BEFORE any SUT imports
 * 2. Call setupLlmAdapterMocks() before your tests
 * 3. Use setCurrentChatFn() to control mock responses
 */
import { mock } from 'bun:test';

// Mock response type
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

// Shared mock getModel function
export const mockGetModel = mock();
export const mockGetEmbeddingModel = mock();

// Current chat function - set this in your test to control responses
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
 * This is used as the return value for mockGetModel.
 */
export function createUnifiedMockModel() {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options: any) => {
      // Convert AI SDK prompt format to our test format
      const mapMessages = (prompt: any[]) =>
        prompt.flatMap((m: any) => {
          let content = m.content;
          if (Array.isArray(m.content)) {
            const toolResults = m.content.filter((p: any) => p.type === 'tool-result');
            if (toolResults.length > 0) {
              return toolResults.map((tr: any) => ({
                role: 'tool',
                tool_call_id: tr.toolCallId,
                content: JSON.stringify(tr.result),
              }));
            }
            const textParts = m.content
              .filter((p: any) => p.type === 'text')
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

      const messages = mapMessages(options.prompt || options.input);
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
            type: 'tool-call',
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
  };
}

/**
 * Sets up the LLM adapter module mocks.
 * Call this at the TOP of your test file, before any imports of the SUT.
 */
export function setupLlmAdapterMocks() {
  mock.module('../llm-adapter', () => ({
    getModel: mockGetModel,
    getEmbeddingModel: mockGetEmbeddingModel,
    DynamicProviderRegistry: { getProvider: mock() },
  }));

  // Also mock with relative paths that might be used
  mock.module('./llm-adapter', () => ({
    getModel: mockGetModel,
    getEmbeddingModel: mockGetEmbeddingModel,
    DynamicProviderRegistry: { getProvider: mock() },
  }));

  // Reset mocks to use the unified model
  mockGetModel.mockReset();
  mockGetModel.mockResolvedValue(createUnifiedMockModel());
}

/**
 * Resets all mocks to default state. Call in afterEach if needed.
 */
export function resetLlmMocks() {
  mockGetModel.mockReset();
  mockGetModel.mockResolvedValue(createUnifiedMockModel());
  _currentChatFn = async () => ({
    message: { role: 'assistant', content: 'Default mock response' },
  });
}
