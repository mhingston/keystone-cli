import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { AuthManager } from '../utils/auth-manager';
import { ConfigLoader } from '../utils/config-loader';
import { resetLlmMocks, setupLlmMocks } from './__test__/llm-test-setup';
import {
  DynamicProviderRegistry,
  getEmbeddingModel,
  getModel,
  resetProviderRegistry,
} from './llm-adapter';

// Mocks for AI SDK models
const mockLanguageModel = {
  specificationVersion: 'v1',
  provider: 'test-provider',
  modelId: 'test-model',
  doGenerate: async () => ({}),
  doStream: async () => ({}),
} as any;

const mockEmbeddingModel = {
  specificationVersion: 'v1',
  provider: 'test-provider',
  modelId: 'test-embedding-model',
  doEmbed: async () => ({}),
  doEmbedMany: async () => ({}),
} as any;

describe('LLM Adapter (AI SDK)', () => {
  beforeEach(() => {
    setupLlmMocks();
    ConfigLoader.clear();
    resetProviderRegistry();
    // Reset AuthManager mocks if any
    mock.restore();
  });

  afterEach(() => {
    resetLlmMocks();
    mock.restore();
  });

  describe('getModel', () => {
    it('should load a provider and return a language model', async () => {
      // Mock Config
      ConfigLoader.setConfig({
        default_provider: 'test-provider',
        providers: {
          'test-provider': {
            type: 'openai', // Use standard type to trigger logic
            package: '@ai-sdk/openai', // Use real package name to match mock
          },
        },
        model_mappings: {},
      } as any);

      // With shared setupLlmMocks, we expect 'mock' provider
      const model = (await getModel('model-name')) as any;
      expect(model.modelId).toBe('mock-model');
      expect(model.provider).toBe('mock');
    });

    it('should handle auth token retrieval for standard providers', async () => {
      ConfigLoader.setConfig({
        default_provider: 'openai',
        providers: {
          openai: {
            type: 'openai',
            package: '@ai-sdk/openai',
            api_key_env: 'OPENAI_API_KEY',
          },
        },
        model_mappings: {},
      } as any);

      spyOn(ConfigLoader, 'getSecret').mockReturnValue('fake-token');

      const model = (await getModel('gpt-4')) as any;
      // With global mock, we mostly check it didn't throw and loaded the 'mock' provider
      expect(model.provider).toBe('mock');
      expect(ConfigLoader.getSecret).toHaveBeenCalledWith('OPENAI_API_KEY');
    });
  });

  describe('getEmbeddingModel', () => {
    it('should return an embedding model if supported by provider', async () => {
      ConfigLoader.setConfig({
        default_provider: 'embed-provider',
        providers: {
          'embed-provider': { type: 'custom', package: 'pkg' },
        },
        model_mappings: {},
      } as any);

      const mockProvider = (modelId: string) => mockLanguageModel;
      mockProvider.textEmbeddingModel = (modelId: string) => mockEmbeddingModel;

      spyOn(DynamicProviderRegistry, 'getProvider').mockResolvedValue(() => mockProvider);

      const model = (await getEmbeddingModel('text-embedding-3')) as any;
      expect(model.modelId).toBe(mockEmbeddingModel.modelId);
    });

    it('should throw if provider does not support embeddings', async () => {
      ConfigLoader.setConfig({
        default_provider: 'bad-provider',
        providers: {
          'bad-provider': { type: 'custom', package: 'pkg' },
        },
        model_mappings: {},
      } as any);

      const mockProvider = (modelId: string) => mockLanguageModel;
      // No textEmbeddingModel method

      spyOn(DynamicProviderRegistry, 'getProvider').mockResolvedValue(() => mockProvider);

      // Use a non-default model name to avoid fallback to LocalEmbeddingModel
      await expect(getEmbeddingModel('non-default-model')).rejects.toThrow(
        /does not support embeddings/
      );
    });
  });

  describe('Tool Cases', () => {
    it('should handle assistant response with tool calls and NO content', async () => {
      ConfigLoader.setConfig({
        default_provider: 'test-provider',
        providers: { 'test-provider': { type: 'openai', package: 'test-pkg' } },
        model_mappings: {},
      } as any);

      const mockProvider = (modelId: string) => ({
        ...mockLanguageModel,
        doGenerate: async () => ({
          content: [
            { type: 'tool-call', toolCallId: '1', toolName: 'test', args: {}, input: '{}' },
          ],
          finishReason: 'tool-calls',
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      });
      spyOn(DynamicProviderRegistry, 'getProvider').mockResolvedValue(() => mockProvider);

      const model = (await getModel('model')) as any;
      const result = await model.doGenerate({ input: [], prompt: [], mode: { type: 'regular' } });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('tool-call');
    });
  });
});
