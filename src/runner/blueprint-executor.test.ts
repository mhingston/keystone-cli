import { describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import type { Blueprint, BlueprintStep, Step } from '../parser/schema';
import type { Logger } from '../utils/logger';
import { executeBlueprintStep } from './executors/blueprint-executor.ts';
import type { executeLlmStep } from './executors/llm-executor.ts';
import type { StepResult } from './step-executor';

describe('BlueprintExecutor', () => {
  const tempDir = path.join(process.cwd(), '.tmp-blueprint-test');

  it('should generate and persist a blueprint', async () => {
    mkdirSync(tempDir, { recursive: true });

    const mockStep: BlueprintStep = {
      id: 'test_blueprint',
      type: 'blueprint',
      prompt: 'Build a todo app',
      needs: [],
      agent: 'keystone-architect',
    };

    const mockBlueprint: Blueprint = {
      architecture: { description: 'Todo Architecture' },
      files: [{ path: 'todo.ts', purpose: 'logic' }],
    };

    const mockExecuteLlmStep = mock(async () => ({
      status: 'success',
      output: mockBlueprint,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })) as unknown as typeof executeLlmStep;

    const mockExecuteStep = mock(async () => ({ status: 'success', output: null }) as StepResult);

    const context: ExpressionContext = { steps: {}, inputs: {}, env: {}, secrets: {} };
    const logger: Logger = {
      log: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
    };

    try {
      const result = await executeBlueprintStep(mockStep, context, mockExecuteStep, logger, {
        artifactRoot: tempDir,
        runId: 'test-run',
        executeLlmStep: mockExecuteLlmStep,
      });

      expect(result.status).toBe('success');
      expect(result.output).toMatchObject(mockBlueprint);
      const output = result.output as Blueprint & { __hash: string; __artifactPath: string };
      expect(output.__hash).toBeDefined();

      expect(existsSync(output.__artifactPath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
