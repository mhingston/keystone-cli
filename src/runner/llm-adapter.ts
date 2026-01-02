import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { EmbeddingModel, LanguageModel } from 'ai';
import type { Config } from '../parser/config-schema';
import { ConfigLoader } from '../utils/config-loader';
import { ConsoleLogger } from '../utils/logger';

// --- Keystone Types & Extensions ---

/**
 * A provider instance in the AI SDK can be a function that returns a language model,
 * or an object with methods for different model types.
 */
export interface ProviderInstance {
  (modelId: string): LanguageModel;
  languageModel?: (modelId: string) => LanguageModel;
  textEmbeddingModel?: (modelId: string) => EmbeddingModel;
  embedding?: (modelId: string) => EmbeddingModel;
  textEmbedding?: (modelId: string) => EmbeddingModel;
}

/**
 * A provider factory is a function that takes configuration options and returns a provider instance.
 */
export type ProviderFactory = (options: Record<string, unknown>) => ProviderInstance;

/**
 * Local embedding model implementation using @xenova/transformers.
 * Maintains the "zero-setup local memory" feature.
 */
class LocalEmbeddingModel {
  readonly specificationVersion = 'v2';
  readonly modelId = 'local-minilm';
  readonly provider = 'local';
  readonly maxEmbeddingsPerCall = 1;
  readonly supportsParallelCalls = false;
  private static pipelinePromise: Promise<any> | null = null;

  private async getPipeline() {
    if (!LocalEmbeddingModel.pipelinePromise) {
      LocalEmbeddingModel.pipelinePromise = (async () => {
        const { pipeline } = await import('@xenova/transformers');
        return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      })() as Promise<any>;
    }
    return LocalEmbeddingModel.pipelinePromise;
  }

  async doEmbed(options: { values: string[]; abortSignal?: AbortSignal }) {
    const pipe = await this.getPipeline();
    const embeddings = await Promise.all(
      options.values.map(async (text) => {
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data) as number[];
      })
    );
    return { embeddings, warnings: [] };
  }

  /**
   * Dispose of the cached pipeline to free memory.
   * Call this when the embedding model is no longer needed.
   */
  static dispose(): void {
    LocalEmbeddingModel.pipelinePromise = null;
  }
}

// Re-export specific AI SDK types
export type { LanguageModel, EmbeddingModel } from 'ai';

const userRequire = createRequire(join(process.cwd(), 'package.json'));

// Lazy-loaded global require to avoid blocking import time
let globalRequire: NodeRequire | undefined;
let globalRequireResolved = false;

function getGlobalRequire(): NodeRequire | undefined {
  if (globalRequireResolved) {
    return globalRequire;
  }
  globalRequireResolved = true;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    globalRequire = createRequire(join(globalRoot, 'package.json'));
  } catch {
    // Global npm root not found - this is expected in some environments (e.g., containers, CI)
    // Global package resolution will be disabled silently
  }
  return globalRequire;
}

// Compatibility types for Keystone
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  reasoning?: { summary?: string }; // Keystone extension
}

export interface LLMResponse {
  message: LLMMessage;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// --- Dynamic Provider Registry ---

export class DynamicProviderRegistry {
  private static loadedProviders = new Map<string, ProviderFactory | ProviderInstance>();

  static async getProvider(
    providerName: string,
    config: Config['providers'][string]
  ): Promise<ProviderFactory | ProviderInstance> {
    if (DynamicProviderRegistry.loadedProviders.has(providerName)) {
      return DynamicProviderRegistry.loadedProviders.get(providerName) as
        | ProviderFactory
        | ProviderInstance;
    }

    // 1. Custom Script
    if (config.script) {
      const scriptPath = join(process.cwd(), config.script);
      try {
        const module = await import(scriptPath);
        if (!module.default) {
          throw new Error(`Custom provider script '${scriptPath}' must export a default function.`);
        }
        DynamicProviderRegistry.loadedProviders.set(providerName, module.default);
        return module.default;
      } catch (err) {
        throw new Error(
          `Failed to load custom provider script '${scriptPath}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 2. Package
    if (config.package) {
      try {
        let pkg: any;
        try {
          // Try local project first
          const localPath = userRequire.resolve(config.package);
          pkg = await import(localPath);
        } catch {
          try {
            const pkgPath = userRequire.resolve(config.package);
            pkg = await import(pkgPath);
          } catch {
            // Try global if local resolution fails
            const globalReq = getGlobalRequire();
            if (globalReq) {
              try {
                const globalPkgPath = globalReq.resolve(config.package);
                pkg = await import(globalPkgPath);
              } catch {
                throw new Error(
                  `Failed to resolve package '${config.package}' locally or globally.`
                );
              }
            } else {
              throw new Error(`Failed to resolve package '${config.package}' locally.`);
            }
          }
        }

        // If a specific factory is configured, try to use it first
        const factoryKey = config.factory || config.type || 'default';
        if (pkg[factoryKey] && typeof pkg[factoryKey] === 'function') {
          DynamicProviderRegistry.loadedProviders.set(providerName, pkg[factoryKey]);
          return pkg[factoryKey];
        }

        // Discovery fallback: Search for common factory patterns case-insensitively
        const searchTerms = [
          `create${providerName.replace(/[-_]/g, '')}provider`,
          `create${providerName.split(/[-_]/)[0]}provider`,
          providerName.replace(/[-_]/g, ''),
          providerName.split(/[-_]/)[0],
        ];

        const allKeys = Object.keys(pkg);
        for (const key of allKeys) {
          const lowerKey = key.toLowerCase();
          if (
            searchTerms.some(
              (term) =>
                lowerKey === term ||
                lowerKey === `create${term}provider` ||
                lowerKey.includes(`${term}provider`)
            )
          ) {
            if (typeof pkg[key] === 'function') {
              DynamicProviderRegistry.loadedProviders.set(providerName, pkg[key]);
              return pkg[key];
            }
          }
        }

        if (pkg.default && typeof pkg.default === 'function') {
          DynamicProviderRegistry.loadedProviders.set(providerName, pkg.default);
          return pkg.default;
        }

        const firstFn = Object.values(pkg).find((v) => typeof v === 'function');
        if (firstFn) {
          DynamicProviderRegistry.loadedProviders.set(providerName, firstFn as any);
          return firstFn as any;
        }

        throw new Error(
          `Could not find a valid factory function in package '${config.package}'. Available keys: ${allKeys.join(', ')}`
        );
      } catch (err) {
        throw new Error(
          `Failed to load provider package '${config.package}': ${err instanceof Error ? err.message : String(err)}. Please run 'npm install -g ${config.package}' or 'npm install ${config.package}'.`
        );
      }
    }

    throw new Error(
      `Provider '${providerName}' must have a 'package' or 'script' configured in your keystone settings.`
    );
  }
}

export function resetProviderRegistry(): void {
  // @ts-ignore: private static property access for test cleanup
  DynamicProviderRegistry.loadedProviders.clear();
}

async function prepareProvider(
  model: string
): Promise<{ provider: ProviderInstance; resolvedModel: string }> {
  const providerName = ConfigLoader.getProviderForModel(model);
  const config = ConfigLoader.load();
  const providerConfig = config.providers[providerName];

  if (!providerConfig) {
    throw new Error(
      `Provider configuration not found for: ${providerName}. Ensure it is defined in your keystone configuration.`
    );
  }

  // Pure BYOP: Load provider factory from user configuration
  const providerFactory = await DynamicProviderRegistry.getProvider(providerName, providerConfig);

  // Initialize provider with AuthManager secrets
  const options: Record<string, unknown> = {};

  if (providerConfig.base_url) {
    options.baseURL = providerConfig.base_url;
  }

  // Fallback to env var lookup via ConfigLoader if not found above
  if (!options.apiKey && providerConfig.api_key_env) {
    options.apiKey = ConfigLoader.getSecret(providerConfig.api_key_env);
  }

  // Create the provider instance
  const provider =
    typeof providerFactory === 'function'
      ? (providerFactory as ProviderFactory)(options)
      : providerFactory;

  if (!provider) {
    throw new Error(
      `Provider factory for '${providerName}' returned undefined. Check your provider implementation.`
    );
  }

  // Resolve model name (strip prefix if typical "provider:model" format)
  let resolvedModel = model;
  if (model.includes(':')) {
    const [prefix, ...rest] = model.split(':');
    if (config.providers[prefix]) {
      resolvedModel = rest.join(':');
    }
  }

  return { provider, resolvedModel };
}

export async function getModel(model: string): Promise<LanguageModel> {
  const configValues = ConfigLoader.load();
  if (configValues.logging?.suppress_ai_sdk_warnings) {
    process.env.AI_SDK_LOG_WARNINGS = 'false';
  }

  const { provider, resolvedModel } = await prepareProvider(model);

  // AI SDK convention: provider(modelId)
  if (typeof provider === 'function') {
    // Prefer explicit .chat() or .chatModel() if available to ensure correct protocol (Chat vs Completion)
    if (typeof (provider as any).chat === 'function') {
      return (provider as any).chat(resolvedModel);
    }
    if (typeof (provider as any).chatModel === 'function') {
      return (provider as any).chatModel(resolvedModel);
    }
    return (provider as any)(resolvedModel);
  }

  // Fallback for objects that aren't callable but have standard methods
  if (typeof (provider as any).languageModel === 'function') {
    return (provider as any).languageModel(resolvedModel);
  }
  if (typeof (provider as any).chatModel === 'function') {
    return (provider as any).chatModel(resolvedModel);
  }

  const keys = Object.keys(provider as any);
  const type = typeof provider;
  throw new Error(
    `Provider for model '${model}' is not a function (type: ${type}) and has no .languageModel() method. Available keys: ${keys.join(', ')}`
  );
}

export async function getEmbeddingModel(model: string): Promise<EmbeddingModel> {
  const configValues = ConfigLoader.load();
  if (configValues.logging?.suppress_ai_sdk_warnings) {
    process.env.AI_SDK_LOG_WARNINGS = 'false';
  }

  // 1. Check for local fallback
  if (model === 'local' || model === 'keystone-local') {
    return new LocalEmbeddingModel();
  }

  try {
    const { provider, resolvedModel } = await prepareProvider(model);

    // AI SDK convention: provider.textEmbeddingModel(modelId) OR provider.embedding(modelId)
    // We check all known variations to be safe with different provider implementations or versions
    if (typeof provider.textEmbeddingModel === 'function') {
      return provider.textEmbeddingModel(resolvedModel);
    }
    if (typeof provider.embedding === 'function') {
      return provider.embedding(resolvedModel);
    }
    if (typeof provider.textEmbedding === 'function') {
      return provider.textEmbedding(resolvedModel);
    }
  } catch (err) {
    // If explicit provider setup fails AND it's a default attempt, fallback to local
    const config = ConfigLoader.load();
    if (model === config.embedding_model || !model) {
      new ConsoleLogger().warn(
        `⚠️  Embedding provider for '${model}' failed, falling back to local embeddings: ${err instanceof Error ? err.message : String(err)}`
      );
      return new LocalEmbeddingModel();
    }
    throw err;
  }

  // Some providers might just return the model directly if called, but usually that's for LanguageModel.
  // We assume standard AI SDK provider structure here.
  throw new Error(
    `Provider for model '${model}' does not support embeddings (no .textEmbeddingModel, .embedding, or .textEmbedding method found).`
  );
}

/**
 * Dispose of the local embedding model's cached pipeline to free memory.
 * Call this during graceful shutdown or when embeddings are no longer needed.
 */
export function disposeLocalEmbeddingModel(): void {
  LocalEmbeddingModel.dispose();
}
