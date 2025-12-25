import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import type { LlmStep, Step } from '../parser/schema';
import type { LLMAdapter } from './llm-adapter';
import { executeLlmStep } from './llm-executor';

describe('Standard Tools Integration', () => {
  const createMockGetAdapter = (chatFn: LLMAdapter['chat']) => {
    return (_modelString: string) => ({
      adapter: { chat: chatFn } as LLMAdapter,
      resolvedModel: 'gpt-4o',
    });
  };

  beforeAll(() => {
    // Ensure .keystone/workflows/agents exists
    const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
    // Create test-agent.md
    writeFileSync(
      join(agentsDir, 'test-agent.md'),
      `---
name: test-agent
model: gpt-4o
---
System prompt`,
      'utf8'
    );
  });

  afterAll(() => {
    // Cleanup test-agent.md
    const agentPath = join(process.cwd(), '.keystone', 'workflows', 'agents', 'test-agent.md');
    if (existsSync(agentPath)) {
      rmSync(agentPath);
    }
  });

  it('should inject standard tools when useStandardTools is true', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock
    let capturedTools: any[] = [];

    const chatMock = mock(async (messages, options) => {
      capturedTools = options.tools || [];
      return {
        message: {
          role: 'assistant',
          content: 'I will read the file',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'test.txt' }),
              },
            },
          ],
        },
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    const step: LlmStep = {
      id: 'l1',
      type: 'llm',
      agent: 'test-agent',
      needs: [],
      prompt: 'read test.txt',
      useStandardTools: true,
      maxIterations: 1,
    };

    const context: ExpressionContext = { inputs: {}, steps: {} };
    const executeStepFn = mock(async (s: Step) => {
      return { status: 'success', output: 'file content' };
    });

    // We catch the "Max iterations reached" error because we set maxIterations to 1
    // but we can still check if tools were injected and the tool call was made.
    try {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      await executeLlmStep(
        step,
        context,
        executeStepFn as any,
        undefined,
        undefined,
        undefined,
        undefined,
        getAdapter
      );
    } catch (e) {
      if ((e as Error).message !== 'Max ReAct iterations reached') throw e;
    }

    expect(capturedTools.some((t) => t.function.name === 'read_file')).toBe(true);
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

    // The execution should not throw, but it should return a tool error message to the LLM
    // However, in our mock, we want to see if executeStepFn was called.
    // Actually, in llm-executor.ts, it pushes a "Security Error" message if check fails and continues loop.

    let securityErrorMessage = '';
    const chatMock = mock(async (messages) => {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'tool') {
        securityErrorMessage = lastMessage.content;
        return {
          message: { role: 'assistant', content: 'stop' },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          // biome-ignore lint/suspicious/noExplicitAny: mock
        } as any;
      }
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' },
            },
          ],
        },
        // biome-ignore lint/suspicious/noExplicitAny: mock
      } as any;
    }) as unknown as LLMAdapter['chat'];
    const getAdapter = createMockGetAdapter(chatMock);

    // biome-ignore lint/suspicious/noExplicitAny: mock
    await executeLlmStep(
      step,
      context,
      executeStepFn as any,
      undefined,
      undefined,
      undefined,
      undefined,
      getAdapter
    );

    expect(securityErrorMessage).toContain('Security Error');
    expect(executeStepFn).not.toHaveBeenCalled();
  });
});
