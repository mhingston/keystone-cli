// Import shared mock setup FIRST (mock.module is in preload, these are the mock references)
import {
  createUnifiedMockModel,
  mockGetModel,
  resetLlmMocks,
  setCurrentChatFn,
  setupLlmMocks,
} from './__test__/llm-test-setup';

import { beforeAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import type { Step, Workflow } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';

// Note: mock.module() for llm-adapter is now handled by the preload file
// We should NOT mock 'ai' globally as it breaks other tests using the real ai SDK.
// Instead, we use a mock model that the real ai SDK calls.

// Dynamic import holder
let WorkflowRunner: any;

describe('WorkflowRunner Reflexion', () => {
  beforeAll(async () => {
    // Set up config
    ConfigLoader.setConfig({
      providers: {
        openai: { type: 'openai', package: '@ai-sdk/openai', api_key_env: 'OPENAI_API_KEY' },
      },
      default_provider: 'openai',
      model_mappings: {},
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
      expression: { strict: false },
    } as any);

    mockGetModel.mockResolvedValue(createUnifiedMockModel());
    setupLlmMocks();

    setCurrentChatFn(async () => ({
      message: { role: 'assistant', content: JSON.stringify({ run: 'echo "fixed"' }) },
    }));

    // Import after mocks
    const module = await import('./workflow-runner');
    WorkflowRunner = module.WorkflowRunner;
  });

  beforeEach(() => {
    ConfigLoader.clear();
    jest.restoreAllMocks();
    setupLlmMocks();
    setupLlmMocks();
    resetLlmMocks();
    setCurrentChatFn(async () => ({
      message: { role: 'assistant', content: JSON.stringify({ run: 'echo "fixed"' }) },
    }));
  });

  test('should attempt to self-correct a failing step using reflexion', async () => {
    const workflow: Workflow = {
      name: 'reflexion-test',
      steps: [
        {
          id: 'fail-step',
          type: 'shell',
          run: 'exit 1',
          reflexion: {
            limit: 2,
            hint: 'fix it',
          },
        } as Step,
      ],
    };

    const spy = jest.fn();

    const runner = new WorkflowRunner(workflow, {
      logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, info: () => {} },
      dbPath: ':memory:',
      executeStep: spy as any,
    });

    const db = (runner as any).db;
    await db.createRun(runner.runId, workflow.name, {});

    // First call fails, Reflexion logic kicks in (calling mocked generateText),
    // then it retries with corrected command.
    spy.mockImplementation(async (step: any) => {
      if (step.run === 'exit 1') {
        return { status: 'failed', output: null, error: 'Command failed' };
      }

      if (step.run === 'echo "fixed"') {
        return { status: 'success', output: 'fixed' };
      }

      return { status: 'failed', output: null, error: 'Unknown step' };
    });

    await (runner as any).executeStepWithForeach(workflow.steps[0]);

    // Expectations:
    // 1. First execution (fails)
    // 2. Reflexion happens (internal, not executeStep)
    // 3. Second execution (retry with new command)
    expect(spy).toHaveBeenCalledTimes(2);

    // Verify the second call had the corrected command
    const secondCallArg = spy.mock.calls[1][0] as any;
    expect(secondCallArg.run).toBe('echo "fixed"');
  });
});
