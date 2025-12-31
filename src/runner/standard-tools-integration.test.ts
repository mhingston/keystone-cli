// Import shared mock setup FIRST (mock.module is in preload, these are the mock references)
import {
  type MockLLMResponse,
  createUnifiedMockModel,
  mockGetModel,
  resetLlmMocks,
  setCurrentChatFn,
  setupLlmMocks,
} from './__test__/llm-test-setup';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import * as agentParser from '../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import type { StepResult } from './step-executor';

// Note: mock.module() is now handled by the preload file

// Dynamic import holder
let executeLlmStep: any;

// Local chat function wrapper for test-specific overrides
let currentChatFn: (messages: any[], options?: any) => Promise<MockLLMResponse>;

describe('Standard Tools Integration', () => {
  // Test fixtures
  const testDir = join(process.cwd(), '.e2e-tmp', 'standard-tools-test');
  let resolveAgentPathSpy: ReturnType<typeof spyOn>;
  let parseAgentSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    // Setup config before importing the executor
    ConfigLoader.setConfig({
      default_provider: 'test-provider',
      providers: {
        'test-provider': {
          type: 'openai',
          package: '@ai-sdk/openai',
        },
      },
      model_mappings: {},
    } as any);

    // Ensure the mock model is set up
    setupLlmMocks();

    // Dynamic import AFTER mocks are set up
    const module = await import('./executors/llm-executor.ts');
    executeLlmStep = module.executeLlmStep;

    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    writeFileSync(join(testDir, 'test.txt'), 'hello world');
  });

  beforeEach(() => {
    ConfigLoader.clear();
    // Setup mocks for each test
    setupLlmMocks();

    // Mock the agent parser to avoid needing actual agent files
    resolveAgentPathSpy = spyOn(agentParser, 'resolveAgentPath').mockReturnValue(
      'tool-test-agent.md'
    );
    parseAgentSpy = spyOn(agentParser, 'parseAgent').mockReturnValue({
      name: 'tool-test-agent',
      systemPrompt: 'Test agent for standard tools',
      tools: [],
      model: 'gpt-4o',
    } as unknown as Agent);
  });

  afterEach(() => {
    resolveAgentPathSpy?.mockRestore();
    parseAgentSpy?.mockRestore();
    resetLlmMocks();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    ConfigLoader.clear();
  });

  it('should inject standard tools when useStandardTools is true', async () => {
    let capturedTools: any[] = [];
    let callCount = 0;

    currentChatFn = async (messages, options) => {
      callCount++;
      capturedTools = options?.tools || [];

      if (callCount === 1) {
        return {
          message: {
            role: 'assistant',
            content: 'I will read the file',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
              },
            ],
          },
        };
      }

      return {
        message: { role: 'assistant', content: 'the file contents are hello world' },
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'tool-test-agent',
      prompt: 'read test.txt',
      useStandardTools: true,
      needs: [],
      maxIterations: 3,
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async (step: Step) => {
      return { status: 'success' as const, output: 'hello world' };
    });

    try {
      await executeLlmStep(
        step,
        context,
        executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
        undefined,
        undefined,
        undefined,
        undefined
      );
    } catch (e) {
      if ((e as Error).message !== 'Max ReAct iterations reached') throw e;
    }

    expect(capturedTools.some((t: any) => t.function.name === 'read_file')).toBe(true);
    expect(executeStepFn).toHaveBeenCalled();
    const toolStep = executeStepFn.mock.calls[0][0] as Step;
    expect(toolStep.type).toBe('file');
  });

  it('should block risky standard tools without allowInsecure', async () => {
    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      needs: [],
      prompt: 'run risky command',
      useStandardTools: true,
      allowInsecure: false, // Explicitly false
      maxIterations: 2,
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async () => ({ status: 'success', output: '' }));

    // Mock makes a tool call to run_command which should be rejected
    currentChatFn = async () => {
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'run_command', arguments: '{"command":"echo $HOME"}' },
            },
          ],
        },
      };
    };
    setCurrentChatFn(currentChatFn as any);

    // May throw max iterations or complete
    try {
      await executeLlmStep(
        step,
        context,
        executeStepFn as unknown as (step: Step, context: ExpressionContext) => Promise<StepResult>,
        undefined,
        undefined,
        undefined,
        undefined
      );
    } catch (e) {
      // Expected to hit max iterations
    }

    // The key assertion: executeStepFn should NOT have been called for the risky command
    expect(executeStepFn).not.toHaveBeenCalled();
  });
});
