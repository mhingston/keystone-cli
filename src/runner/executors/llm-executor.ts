import { streamText } from 'ai';
import type { ExpressionContext } from '../../expression/evaluator';
import { ExpressionEvaluator } from '../../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../../parser/agent-parser';
import type { LlmStep, Step } from '../../parser/schema';
import { ITERATIONS, LIMITS } from '../../utils/constants';
import { ContextInjector } from '../../utils/context-injector';
import { extractJson } from '../../utils/json-parser';
import { ConsoleLogger, type Logger } from '../../utils/logger.ts';
import { RedactionBuffer, Redactor } from '../../utils/redactor';
import type { WorkflowEvent } from '../events.ts';
import * as llmAdapter from '../llm-adapter';
import type { LLMMessage } from '../llm-adapter';
import type { MCPManager } from '../mcp-manager';
import { StreamHandler } from './llm/stream-handler';
import { ToolManager } from './llm/tool-manager';
import type { StepResult } from './types.ts';

// --- AI SDK Message Types ---
// (Keep types for mapping)
interface CoreTextPart {
  type: 'text';
  text: string;
}

interface CoreToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: any;
}

interface CoreToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: any;
  isError?: boolean;
}

type CoreContentPart = CoreTextPart | CoreToolCallPart | CoreToolResultPart;

interface CoreSystemMessage {
  role: 'system';
  content: string;
}

interface CoreUserMessage {
  role: 'user';
  content: string | CoreContentPart[];
}

interface CoreAssistantMessage {
  role: 'assistant';
  content: string | CoreContentPart[];
}

interface CoreToolMessage {
  role: 'tool';
  content: CoreToolResultPart[];
}

type CoreMessage = CoreSystemMessage | CoreUserMessage | CoreAssistantMessage | CoreToolMessage;

type LlmEventContext = {
  runId?: string;
  workflow?: string;
};

// --- Mappers ---
function mapToCoreMessages(messages: LLMMessage[]): any[] {
  const coreMessages = messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content || '' };
    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) {
        parts.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id || 'missing-id',
            toolName: tc.function.name || 'missing-name',
            input:
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : tc.function.arguments || {},
          });
        }
      }
      if (parts.length === 0) {
        parts.push({ type: 'text', text: '' });
      }
      return { role: 'assistant', content: parts };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id || 'missing-id',
            toolName: m.name || 'missing-name',
            result: m.content || '',
          },
        ],
      };
    }
    // Handle system or unknown roles
    return { role: 'system', content: m.content || '' };
  });
  return coreMessages;
}

// --- Main Execution Logic ---

export async function executeLlmStep(
  step: LlmStep,
  context: ExpressionContext,
  executeStepFn: (step: Step, context: ExpressionContext) => Promise<StepResult>,
  logger: Logger = new ConsoleLogger(),
  mcpManager?: MCPManager,
  workflowDir?: string,
  abortSignal?: AbortSignal,
  emitEvent?: (event: WorkflowEvent) => void,
  eventContext?: LlmEventContext
): Promise<StepResult> {
  const agentName = ExpressionEvaluator.evaluateString(step.agent, context);
  const agentPath = resolveAgentPath(agentName, workflowDir);
  let activeAgent = parseAgent(agentPath);
  const prompt = ExpressionEvaluator.evaluateString(step.prompt, context);

  // Redaction setup
  const redactor = new Redactor(context.secrets || {}, {
    forcedSecrets: context.secretValues || [],
  });
  const redactionBuffer = new RedactionBuffer(redactor);
  const streamHandler = step.outputSchema ? null : new StreamHandler(logger);
  const eventTimestamp = () => new Date().toISOString();

  const emitThought = (content: string, source: 'thinking' | 'reasoning') => {
    if (emitEvent && eventContext?.runId && eventContext?.workflow) {
      emitEvent({
        type: 'llm.thought',
        timestamp: eventTimestamp(),
        runId: eventContext.runId,
        workflow: eventContext.workflow,
        stepId: step.id,
        content,
        source,
      });
    }
  };

  const handleStreamChunk = (chunk: string) => {
    const redactedChunk = redactionBuffer.process(chunk);
    if (!streamHandler) {
      process.stdout.write(redactedChunk);
      return;
    }
    const { text, thoughts } = streamHandler.processChunk(redactedChunk);
    if (text) {
      process.stdout.write(text);
    }
    for (const thought of thoughts) {
      emitThought(thought, 'thinking');
    }
  };

  // State for Agent Handoff Loop
  let currentMessages: LLMMessage[] = [];
  currentMessages.push({ role: 'user', content: prompt });

  // Handle Resume
  const stepState =
    context.steps && typeof context.steps === 'object'
      ? (context.steps as Record<string, { output?: unknown }>)[step.id]
      : undefined;
  const resumeOutput = (stepState?.output as any)?.messages ? stepState?.output : context.output;
  if (resumeOutput && typeof resumeOutput === 'object' && 'messages' in resumeOutput) {
    const resumedMsgs = resumeOutput.messages as LLMMessage[];
    currentMessages = resumedMsgs.filter((m) => m.role !== 'system');
  }

  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let handoffCount = 0;

  try {
    while (true) {
      if (abortSignal?.aborted) throw new Error('Step canceled');

      // Update model based on current active agent
      const providerRaw = step.provider || activeAgent.provider;
      const modelRaw = step.model || activeAgent.model || 'gpt-4o';

      const provider = providerRaw
        ? ExpressionEvaluator.evaluateString(providerRaw, context)
        : undefined;
      const model = ExpressionEvaluator.evaluateString(modelRaw, context);
      const fullModelString = provider ? `${provider}:${model}` : model;

      const languageModel = await llmAdapter.getModel(fullModelString);

      // Build System Prompt
      let systemPrompt = ExpressionEvaluator.evaluateString(activeAgent.systemPrompt, context);
      const projectContext = await ContextInjector.getContext(workflowDir || process.cwd(), []);
      const contextAddition = ContextInjector.generateSystemPromptAddition(projectContext);
      if (contextAddition) {
        systemPrompt = `${contextAddition}\n\n${systemPrompt}`;
      }
      if (step.outputSchema) {
        systemPrompt += `\n\nIMPORTANT: You must output valid JSON that matches the following schema:\n${JSON.stringify(step.outputSchema, null, 2)}`;
      }

      // Tool Management
      const toolManager = new ToolManager({
        step,
        context,
        logger,
        mcpManager,
        workflowDir,
        abortSignal,
      });

      const aiTools = await toolManager.registerTools(activeAgent, executeStepFn);

      let iterations = 0;
      const maxIterations = step.maxIterations || 10;
      let fullText = '';
      let result: any;

      while (iterations < maxIterations) {
        iterations++;
        logger.debug(`[llm-executor] --- Turn ${iterations} ---`);

        // Enforce maxMessageHistory to preventing context window exhaustion
        let messagesForTurn = currentMessages;
        if (step.maxMessageHistory && currentMessages.length > step.maxMessageHistory) {
          // Keep the last N messages
          // Note: This naive slicing might cut off a tool_call that corresponds to a tool_result
          // but robust models should handle it or we accept the degradation for stability.
          messagesForTurn = currentMessages.slice(-step.maxMessageHistory);
          logger.debug(`  ✂️ Pruned context to last ${step.maxMessageHistory} messages`);
        }

        const coreMessages = mapToCoreMessages(messagesForTurn);

        try {
          result = await streamText({
            model: languageModel,
            system: systemPrompt,
            messages: coreMessages,
            tools: aiTools,
            toolChoice: 'auto',
            onChunk: (event: any) => {
              if (event.chunk.type === 'text-delta') {
                handleStreamChunk(event.chunk.textDelta);
              }
            },
            abortSignal,
          } as any);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.error(`[llm-executor] T${iterations} Error: ${errMsg}`);
          fullText = fullText || `Error: ${errMsg}`;
          break;
        }

        let turnText = '';
        const toolCalls: any[] = [];
        let hasError = false;

        try {
          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              turnText += part.textDelta;
              fullText += part.textDelta;
            } else if (part.type === 'tool-call') {
              toolCalls.push(part);
            } else if (part.type === 'error') {
              hasError = true;
              logger.error(`[llm-executor] T${iterations} Stream error: ${part.error}`);
            }

            if (fullText.length > (LIMITS.MAX_RESPONSE_SIZE_BYTES || 10 * 1024 * 1024)) {
              throw new Error(
                `LLM response exceeded maximum size limit (${LIMITS.MAX_RESPONSE_SIZE_BYTES} bytes).`
              );
            }
          }
        } catch (streamError) {
          const sErr = streamError instanceof Error ? streamError.message : String(streamError);
          logger.error(`[llm-executor] T${iterations} Stream threw error: ${sErr}`);
          hasError = true;
          // We might have partial text/tools, but relying on them is dangerous if stream failed.
          // We keep hasError=true to abort the turn below.
        }

        const usage = await result.usage;
        totalUsage.prompt_tokens += usage?.inputTokens ?? 0;
        totalUsage.completion_tokens += usage?.outputTokens ?? 0;
        totalUsage.total_tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

        currentMessages.push({
          role: 'assistant',
          content: turnText,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.toolCallId,
            type: 'function',
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.args || tc.input || {}),
            },
          })),
        });

        if (hasError) {
          logger.error(`[llm-executor] T${iterations} Stream had errors. Aborting turn.`);
          throw new Error(`LLM stream failed: ${fullText || 'Unknown error during streaming'}`);
        }

        if (toolCalls.length > 0) {
          let turnRequiresSuspend = false;
          let turnSuspendData: any = null;

          for (const call of toolCalls) {
            // Execute tool via ToolManager/aiTools
            const tool = aiTools[call.toolName];
            if (tool) {
              try {
                const toolArgs = call.args || call.input || {};
                const toolResult = await tool.execute(toolArgs, { signal: abortSignal });

                currentMessages.push({
                  role: 'tool',
                  content: JSON.stringify(toolResult),
                  tool_call_id: call.toolCallId,
                  name: call.toolName,
                } as any);

                if (toolManager.requiresSuspend) {
                  turnRequiresSuspend = true;
                  turnSuspendData = toolManager.suspendData;
                }
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                currentMessages.push({
                  role: 'tool',
                  content: JSON.stringify({ error: errMsg }),
                  tool_call_id: call.toolCallId,
                  name: call.toolName,
                } as any);
              }
            } else {
              currentMessages.push({
                role: 'tool',
                content: JSON.stringify({ error: `Tool ${call.toolName} not found` }),
                tool_call_id: call.toolCallId,
                name: call.toolName,
              } as any);
            }
          }

          if (turnRequiresSuspend) {
            return {
              output: { messages: currentMessages, ...turnSuspendData },
              status: 'suspended',
              usage: totalUsage,
            };
          }

          if (toolManager.pendingTransfer) {
            activeAgent = toolManager.pendingTransfer;
            logger.log(`  🔄 Handoff to agent: ${activeAgent.name}`);
            handoffCount++;
            if (handoffCount > (ITERATIONS.MAX_AGENT_HANDOFFS || 10)) {
              throw new Error('Maximum agent handoffs exceeded');
            }
            break; // Break loop to restart outer loop with new agent
          }
          // Continue loop for next turn (LLM response to tool results)
        } else {
          // No tool calls, Done.
          if (step.outputSchema) {
            return {
              output: extractJson(fullText),
              status: 'success',
              usage: totalUsage,
            };
          }
          return {
            output: fullText,
            status: 'success',
            usage: totalUsage,
          };
        }
      } // end while iterations

      // If we broke out due to handoff, outer loop continues.
      if (!toolManager.pendingTransfer) {
        // Max iterations reached without completion
        if (step.outputSchema) {
          try {
            return {
              output: extractJson(fullText),
              status: 'success',
              usage: totalUsage,
            };
          } catch (e) {
            // fall through
          }
        }
        return {
          output: fullText,
          status: 'success', // or 'failed' if max iterations implies failure?
          usage: totalUsage,
        };
      }
    } // end while true (agent handoff)
  } catch (error) {
    return {
      output: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      usage: totalUsage,
    };
  }
}
