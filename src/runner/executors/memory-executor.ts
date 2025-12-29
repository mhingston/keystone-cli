import type { MemoryDb } from '../../db/memory-db.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { MemoryStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { StepExecutorOptions, StepResult } from './types.ts';

/**
 * Execute a memory step (setting/deleting keys in memory)
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
  const memoryDb = options.memoryDb;
  if (!memoryDb) {
    throw new Error('Memory database not initialized');
  }

  const requestedModel = step.model || 'local';
  if (!requestedModel.toLowerCase().startsWith('local')) {
    throw new Error(`Memory steps only support local embeddings (requested: ${requestedModel})`);
  }

  const adapterResult = options.getAdapter ? options.getAdapter(requestedModel) : null;
  const adapter = adapterResult?.adapter;
  const resolvedModel = adapterResult?.resolvedModel ?? requestedModel;
  if (!resolvedModel.toLowerCase().startsWith('local')) {
    throw new Error(`Memory steps only support local embeddings (requested: ${resolvedModel})`);
  }
  if (!adapter || !adapter.embed) {
    throw new Error(`Model ${resolvedModel} does not support embeddings`);
  }

  switch (step.op) {
    case 'store': {
      const text = ExpressionEvaluator.evaluateString(step.text || '', context);
      if (!text) throw new Error('Text is required for memory store operation');

      const embedding = await adapter.embed(text, undefined, { signal: abortSignal });
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

      const embedding = await adapter.embed(query, undefined, { signal: abortSignal });
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
}
