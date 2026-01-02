import { embed } from 'ai';
import { MemoryDb } from '../../db/memory-db.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { MemoryStep } from '../../parser/schema.ts';
import { ConfigLoader } from '../../utils/config-loader.ts';
import type { Logger } from '../../utils/logger.ts';
import { getEmbeddingModel } from '../llm-adapter.ts';
import type { StepExecutorOptions, StepResult } from './types.ts';

/**
 * Execute a memory step (storing/searching embeddings in memory)
 */
export async function executeMemoryStep(
  step: MemoryStep,
  context: ExpressionContext,
  _logger: Logger,
  options: StepExecutorOptions
): Promise<StepResult> {
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) {
    throw new Error('Memory operation aborted');
  }
  const memoryDbFromOptions = options.memoryDb;
  if (!memoryDbFromOptions && !options.memoryDb) {
    // We'll initialize it below if not provided
  }

  // Get embedding model and dimension from config or step
  const config = ConfigLoader.load();
  const modelName = step.model || config.embedding_model;

  if (!modelName) {
    throw new Error(
      'No embedding model configured. Set embedding_model in config or specify model in step.'
    );
  }

  // Resolve provider dimension
  const providerName = ConfigLoader.getProviderForModel(modelName);
  const providerConfig = config.providers[providerName];
  const dimension = providerConfig?.embedding_dimension || config.embedding_dimension || 384;

  const memoryDb = memoryDbFromOptions || new MemoryDb('.keystone/memory.db', dimension);

  try {
    // Helper to get embedding using AI SDK
    const getEmbedding = async (text: string): Promise<number[]> => {
      const model = await getEmbeddingModel(modelName);
      const result = await embed({
        model,
        value: text,
        abortSignal,
      });
      return result.embedding;
    };

    switch (step.op) {
      case 'store': {
        const text = ExpressionEvaluator.evaluateString(step.text || '', context);
        if (!text) throw new Error('Text is required for memory store operation');

        const embedding = await getEmbedding(text);
        const metadata = step.metadata || {};
        const id = await memoryDb.store(text, embedding, metadata as Record<string, unknown>);

        return {
          output: { id, status: 'stored' },
          status: 'success',
        };
      }
      case 'search': {
        const query = ExpressionEvaluator.evaluateString(step.query || '', context);
        if (!query) throw new Error('Query is required for memory search operation');

        const embedding = await getEmbedding(query);
        const limit = step.limit || 5;
        const results = await memoryDb.search(embedding, limit);

        return {
          output: results,
          status: 'success',
        };
      }
      default:
        throw new Error(`Unknown memory operation: ${(step as any).op}`);
    }
  } finally {
    // Only close if we created it ourselves
    if (!memoryDbFromOptions) {
      memoryDb.close();
    }
  }
}
