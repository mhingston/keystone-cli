import { tool as createTool, jsonSchema, streamText } from 'ai';
import type { TextPart, ToolCallPart, ToolResultPart } from 'ai';
import { z } from 'zod';
import type { ExpressionContext } from '../../expression/evaluator';
import { ExpressionEvaluator } from '../../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../../parser/schema';
import { ConfigLoader } from '../../utils/config-loader';
import { LIMITS, LLM } from '../../utils/constants';
import { ContextInjector } from '../../utils/context-injector';
import { extractJson } from '../../utils/json-parser';
import { ConsoleLogger, type Logger } from '../../utils/logger.ts';
import { RedactionBuffer, Redactor } from '../../utils/redactor';
import type { WorkflowEvent } from '../events.ts';
import * as llmAdapter from '../llm-adapter';
import type { LLMMessage, LLMResponse } from '../llm-adapter';
import { MCPClient } from '../mcp-client';
import type { MCPManager, MCPServerConfig } from '../mcp-manager';
import { STANDARD_TOOLS, validateStandardToolSecurity } from '../standard-tools';
import type { StepResult } from './types.ts';

// --- AI SDK Message Types ---
// These types mirror the AI SDK's CoreMessage structure for type safety
// without tightly coupling to AI SDK internals that may change between versions.
// The types are intentionally permissive to handle various AI SDK part types.

interface CoreTextPart {
  type: 'text';
  text: string;
}

interface CoreToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args?: unknown;
  input?: unknown;
}

interface CoreToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: unknown;
  output?: unknown;
}

// Additional AI SDK part types we want to handle gracefully
interface CoreOtherPart {
  type: string;
  [key: string]: unknown;
}

type CoreContentPart = CoreTextPart | CoreToolCallPart | CoreToolResultPart | CoreOtherPart;
type CoreMessageContent = string | CoreContentPart[];

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
  content: CoreMessageContent;
  toolCalls?: ToolCallPart[];
}

interface CoreToolMessage {
  role: 'tool';
  content: CoreContentPart[];
}

type CoreMessage = CoreSystemMessage | CoreUserMessage | CoreAssistantMessage | CoreToolMessage;

// Re-export for local use with shorter names
const { THINKING_OPEN_TAG, THINKING_CLOSE_TAG, TRANSFER_TOOL_NAME, CONTEXT_UPDATE_KEY } = LLM;

type LlmEventContext = {
  runId?: string;
  workflow?: string;
};

// --- Helper Parser Logic (Kept from original) ---

class ThoughtStreamParser {
  private buffer = '';
  private thoughtBuffer = '';
  private inThinking = false;

  process(chunk: string): { output: string; thoughts: string[] } {
    this.buffer += chunk;
    const thoughts: string[] = [];
    let output = '';

    while (this.buffer.length > 0) {
      const lower = this.buffer.toLowerCase();
      if (!this.inThinking) {
        const openIndex = lower.indexOf(THINKING_OPEN_TAG);
        if (openIndex === -1) {
          const keep = Math.max(0, this.buffer.length - (THINKING_OPEN_TAG.length - 1));
          output += this.buffer.slice(0, keep);
          this.buffer = this.buffer.slice(keep);
          break;
        }
        output += this.buffer.slice(0, openIndex);
        this.buffer = this.buffer.slice(openIndex + THINKING_OPEN_TAG.length);
        this.inThinking = true;
        continue;
      }

      const closeIndex = lower.indexOf(THINKING_CLOSE_TAG);
      if (closeIndex === -1) {
        const keep = Math.max(0, this.buffer.length - (THINKING_CLOSE_TAG.length - 1));
        this.thoughtBuffer += this.buffer.slice(0, keep);
        this.buffer = this.buffer.slice(keep);
        break;
      }
      this.thoughtBuffer += this.buffer.slice(0, closeIndex);
      this.buffer = this.buffer.slice(closeIndex + THINKING_CLOSE_TAG.length);
      this.inThinking = false;
      const thought = this.thoughtBuffer.trim();
      if (thought) {
        thoughts.push(thought);
      }
      this.thoughtBuffer = '';
    }

    return { output, thoughts };
  }

  flush(): { output: string; thoughts: string[] } {
    const thoughts: string[] = [];
    let output = '';

    if (this.inThinking) {
      this.thoughtBuffer += this.buffer;
      const thought = this.thoughtBuffer.trim();
      if (thought) {
        thoughts.push(thought);
      }
    } else {
      output = this.buffer;
    }

    this.buffer = '';
    this.thoughtBuffer = '';
    this.inThinking = false;
    return { output, thoughts };
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(value, (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch {
      return String(value);
    }
  }
}

/**
 * Maps Keystone LLMMessage to AI SDK CoreMessage
 */
function mapToCoreMessages(messages: LLMMessage[]): CoreMessage[] {
  return messages.map((m) => {
    if (m.role === 'user') {
      return { role: 'user', content: m.content || '' };
    }
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const toolCalls: ToolCallPart[] = m.tool_calls.map((tc) => ({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        }));
        return { role: 'assistant', content: m.content || '', toolCalls };
      }
      return { role: 'assistant', content: m.content || '' };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id || '',
            toolName: m.name || '',
            result: m.content || '',
          },
        ],
      };
    }
    // Default to system
    return { role: 'system', content: m.content || '' };
  });
}

/**
 * Maps AI SDK CoreMessage to Keystone LLMMessage.
 * Accepts readonly unknown[] to handle AI SDK ResponseMessage[] which varies by SDK version.
 */
function mapFromCoreMessages(messages: readonly unknown[]): LLMMessage[] {
  const keystoneMessages: LLMMessage[] = [];
  for (const rawMsg of messages) {
    // Type guard for message structure
    const msg = rawMsg as { role: string; content?: unknown };
    if (msg.role === 'assistant') {
      const rawContent = msg.content;
      const contentArray = Array.isArray(rawContent)
        ? rawContent
        : [{ type: 'text', text: String(rawContent || '') }];
      const textPart = contentArray.find(
        (p: { type?: string; text?: string }) => p.type === 'text'
      );
      const keystoneMsg: LLMMessage = {
        role: 'assistant',
        content: textPart?.text || '',
      };
      const toolCalls = contentArray.filter((p: { type?: string }) => p.type === 'tool-call');
      if (toolCalls.length > 0) {
        keystoneMsg.tool_calls = toolCalls.map(
          (tc: { toolCallId?: string; toolName?: string; args?: unknown; input?: unknown }) => ({
            id: tc.toolCallId || '',
            type: 'function' as const,
            function: {
              name: tc.toolName || '',
              arguments:
                typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || tc.input || {}),
            },
          })
        );
      }
      keystoneMessages.push(keystoneMsg);
    } else if (msg.role === 'tool') {
      const rawContent = msg.content;
      const contentArray = Array.isArray(rawContent) ? rawContent : [];
      for (const part of contentArray) {
        const typedPart = part as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          result?: unknown;
          output?: unknown;
        };
        if (typedPart.type === 'tool-result') {
          keystoneMessages.push({
            role: 'tool',
            tool_call_id: typedPart.toolCallId,
            name: typedPart.toolName,
            content:
              typeof typedPart.result === 'string'
                ? typedPart.result
                : JSON.stringify(typedPart.result || typedPart.output || ''),
          });
        }
      }
    } else if (msg.role === 'user') {
      keystoneMessages.push({ role: 'user', content: String(msg.content || '') });
    }
  }
  return keystoneMessages;
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

  const providerRaw = step.provider || activeAgent.provider;
  const modelRaw = step.model || activeAgent.model || 'gpt-4o';

  const provider = providerRaw
    ? ExpressionEvaluator.evaluateString(providerRaw, context)
    : undefined;
  const model = ExpressionEvaluator.evaluateString(modelRaw, context);
  const prompt = ExpressionEvaluator.evaluateString(step.prompt, context);

  const fullModelString = provider ? `${provider}:${model}` : model;

  // NOTE: getModel is the new AI SDK factory
  const languageModel = await llmAdapter.getModel(fullModelString);

  // Redaction setup
  const redactor = new Redactor(context.secrets || {}, {
    forcedSecrets: context.secretValues || [],
  });
  const redactionBuffer = new RedactionBuffer(redactor);
  const thoughtStream = step.outputSchema ? null : new ThoughtStreamParser();
  const eventTimestamp = () => new Date().toISOString();

  const emitThought = (content: string, source: 'thinking' | 'reasoning') => {
    const trimmed = redactor.redact(content.trim());
    if (!trimmed) return;
    logger.info(`💭 Thought (${source}): ${trimmed}`);
    if (emitEvent && eventContext?.runId && eventContext?.workflow) {
      emitEvent({
        type: 'llm.thought',
        timestamp: eventTimestamp(),
        runId: eventContext.runId,
        workflow: eventContext.workflow,
        stepId: step.id,
        content: trimmed,
        source,
      });
    }
  };

  const handleStreamChunk = (chunk: string) => {
    const redactedChunk = redactionBuffer.process(chunk);
    if (!thoughtStream) {
      process.stdout.write(redactedChunk);
      return;
    }
    const parsed = thoughtStream.process(redactedChunk);
    if (parsed.output) {
      process.stdout.write(parsed.output);
    }
    for (const thought of parsed.thoughts) {
      emitThought(thought, 'thinking');
    }
  };

  const flushStream = () => {
    const flushed = redactionBuffer.flush();
    if (!thoughtStream) {
      process.stdout.write(flushed);
      return;
    }
    const parsed = thoughtStream.process(flushed);
    if (parsed.output) {
      process.stdout.write(parsed.output);
    }
    for (const thought of parsed.thoughts) {
      emitThought(thought, 'thinking');
    }
    const final = thoughtStream.flush();
    if (final.output) {
      process.stdout.write(final.output);
    }
    for (const thought of final.thoughts) {
      emitThought(thought, 'thinking');
    }
  };

  // State for Agent Handoff Loop
  let currentMessages: LLMMessage[] = [];
  // Initial User Message
  currentMessages.push({ role: 'user', content: prompt });

  // Handle Resume
  const stepState =
    context.steps && typeof context.steps === 'object'
      ? (context.steps as Record<string, { output?: unknown }>)[step.id]
      : undefined;
  const resumeOutput = (stepState?.output as any)?.messages ? stepState?.output : context.output;
  if (resumeOutput && typeof resumeOutput === 'object' && 'messages' in resumeOutput) {
    const resumedMsgs = resumeOutput.messages as LLMMessage[];
    // Filter out system messages as we rebuild system prompt each turn
    currentMessages = resumedMsgs.filter((m) => m.role !== 'system');
  }

  // MCP Client tracking for cleanup
  const localMcpClients: MCPClient[] = [];

  try {
    // Agent Handoff Loop: We manually loop here (instead of relying solely on SDK's maxSteps)
    // because Agent Handoffs require dynamically swapping the system prompt and tool set
    // when the LLM calls transfer_to_agent. The SDK's maxSteps only handles tool call
    // round-trips within a single agent context; it cannot swap the entire agent mid-execution.
    while (true) {
      if (abortSignal?.aborted) throw new Error('Step canceled');

      // Build System Prompt
      let systemPrompt = ExpressionEvaluator.evaluateString(activeAgent.systemPrompt, context);
      const projectContext = ContextInjector.getContext(workflowDir || process.cwd(), []);
      const contextAddition = ContextInjector.generateSystemPromptAddition(projectContext);
      if (contextAddition) {
        systemPrompt = `${contextAddition}\n\n${systemPrompt}`;
      }
      if (step.outputSchema) {
        systemPrompt += `\n\nIMPORTANT: You must output valid JSON that matches the following schema:\n${JSON.stringify(step.outputSchema, null, 2)}`;
      }

      // Tool Registration
      const aiTools: Record<string, any> = {};
      let pendingTransfer: Agent | null = null;
      let requiresSuspend = false;
      let suspendData: any = null;

      const registerTool = (
        name: string,
        description: string | undefined,
        parameters: any,
        execute: (args: any, context: { toolCallId: string }) => Promise<any>
      ) => {
        // Validate parameters is a valid JSON Schema object
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
          throw new Error(`Invalid parameters for tool ${name}: must be a JSON Schema object.`);
        }

        // Safety: Ensure additionalProperties is false for object types if not specified
        // This prevents the LLM from hallucinating arguments that are not in the schema
        const safeParameters = { ...parameters };
        if (
          safeParameters.type === 'object' &&
          safeParameters.properties &&
          safeParameters.additionalProperties === undefined
        ) {
          safeParameters.additionalProperties = false;
        }

        aiTools[name] = (createTool as any)({
          description,
          parameters: jsonSchema(safeParameters),
          execute: async (args: any, { toolCallId }: { toolCallId: string }) => {
            logger.log(
              `  🛠️  Tool Call: ${name}${Object.keys(args || {}).length ? ` ${safeJsonStringify(args)}` : ''}`
            );
            try {
              return await execute(args, { toolCallId });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error(`  ✗ Tool Error (${name}): ${errMsg}`);
              return { error: errMsg }; // Return as object for AI SDK
            }
          },
        });
      };

      const applyContextUpdate = (value: unknown): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = value as Record<string, unknown>;
        if (!(CONTEXT_UPDATE_KEY in record)) return value;

        const update = record[CONTEXT_UPDATE_KEY] as
          | { env?: Record<string, string>; memory?: Record<string, unknown> }
          | undefined;
        if (update?.env) {
          context.env = context.env || {};
          Object.assign(context.env, update.env);
        }
        if (update?.memory) {
          context.memory = context.memory || {};
          Object.assign(context.memory, update.memory);
        }
        const { [CONTEXT_UPDATE_KEY]: _ignored, ...cleaned } = record;
        return cleaned;
      };

      // 1. Agent Tools
      for (const tool of activeAgent.tools) {
        registerTool(tool.name, tool.description, tool.parameters, async (args) => {
          if (tool.execution) {
            const toolContext = { ...context, args };
            const result = await executeStepFn(tool.execution, toolContext);
            return result.status === 'success'
              ? applyContextUpdate(result.output)
              : `Error: ${result.error}`;
          }
          return `Error: Tool ${tool.name} has no implementation.`;
        });
      }

      // 2. Step Tools & Standard Tools
      const extraTools = [...(step.tools || []), ...(step.useStandardTools ? STANDARD_TOOLS : [])];
      for (const tool of extraTools) {
        // Check valid standard tool security
        if (!step.tools?.includes(tool as any)) {
          // It is a standard tool
          // Wrap execution with security check
          registerTool(tool.name, tool.description, tool.parameters, async (args) => {
            validateStandardToolSecurity(tool.name, args, {
              allowOutsideCwd: step.allowOutsideCwd,
              allowInsecure: step.allowInsecure,
            });
            if (tool.execution) {
              const toolContext = { ...context, args };
              const result = await executeStepFn(tool.execution, toolContext);
              return result.status === 'success'
                ? applyContextUpdate(result.output)
                : `Error: ${result.error}`;
            }
            return 'Error: No execution defined';
          });
        } else {
          // Custom step tool
          registerTool(tool.name, tool.description, tool.parameters, async (args) => {
            if (tool.execution) {
              const toolContext = { ...context, args };
              const result = await executeStepFn(tool.execution, toolContext);
              return result.status === 'success'
                ? applyContextUpdate(result.output)
                : `Error: ${result.error}`;
            }
            return 'Error: No execution defined';
          });
        }
      }

      // 3. MCP Tools
      // (Logic to connect MCP servers same as before, simplified for brevity)
      const mcpServersToConnect: (string | MCPServerConfig)[] = [...(step.mcpServers || [])];
      if (step.useGlobalMcp && mcpManager) {
        const globalServers = mcpManager.getGlobalServers();
        for (const s of globalServers) {
          if (
            !mcpServersToConnect.some(
              (existing) => (typeof existing === 'string' ? existing : existing.name) === s.name
            )
          ) {
            mcpServersToConnect.push(s);
          }
        }
      }

      if (mcpServersToConnect.length > 0) {
        for (const server of mcpServersToConnect) {
          try {
            let client: MCPClient | undefined;
            if (mcpManager) {
              client = await mcpManager.getClient(server, logger);
            } else if (typeof server !== 'string') {
              client = await MCPClient.createLocal(
                server.command || 'node',
                server.args || [],
                server.env || {}
              );
              await client.initialize();
              localMcpClients.push(client);
            }

            if (client) {
              const tools = await client.listTools();
              for (const t of tools) {
                registerTool(t.name, t.description, t.inputSchema, async (args) => {
                  const res = await client?.callTool(t.name, args);
                  // AI SDK expects serializable result. callTool returns useful JSON.
                  // We apply context update and return raw object handled by SDK.
                  return applyContextUpdate(res);
                });
              }
            }
          } catch (e) {
            logger.warn(
              `Failed to connect/list MCP tools for ${typeof server === 'string' ? server : server.name}: ${e}`
            );
          }
        }
      }

      // 4. Special Tools: Ask & Transfer
      if (step.allowClarification) {
        if (aiTools.ask) throw new Error('Tool "ask" is reserved.');
        registerTool(
          'ask',
          'Ask the user a clarifying question.',
          {
            type: 'object',
            properties: { question: { type: 'string' } },
            required: ['question'],
          },
          async (args) => {
            // Robustly handle missing question
            let question = args.question;

            // Fallbacks for common hallucinations
            if (!question) {
              question = args.text || args.message || args.query || args.prompt;
            }

            if (!question) {
              logger.warn(`  ⚠️  Tool 'ask' called without a question. Args: ${safeJsonStringify(args)}`);
              // Fallback: Suspend with a placeholder instead of erroring to the model, 
              // which often leads to "..." responses and JSON parse failures.
              question = "(The agent failed to formulate a specific question. Please provide any relevant guidance or press Enter to proceed.)";
            }

            if (process.stdin.isTTY) {
              logger.log(`\n🤔 Question from ${activeAgent.name}: ${question}`);
              const result = await executeStepFn(
                {
                  id: `${step.id}-clarify`,
                  type: 'human',
                  message: question,
                  inputType: 'text',
                } as Step,
                context
              );
              return String(result.output);
            }
            requiresSuspend = true;
            suspendData = { question: question }; // Will abort loop
            return 'Suspended for user input';
          }
        );
      }

      if (step.allowedHandoffs && step.allowedHandoffs.length > 0) {
        if (aiTools[TRANSFER_TOOL_NAME])
          throw new Error(`Tool "${TRANSFER_TOOL_NAME}" is reserved.`);
        registerTool(
          TRANSFER_TOOL_NAME,
          `Transfer control to another agent. Allowed: ${step.allowedHandoffs.join(', ')}`,
          {
            type: 'object',
            properties: { agent_name: { type: 'string' } },
            required: ['agent_name'],
          },
          async (args) => {
            if (!step.allowedHandoffs?.includes(args.agent_name))
              return `Error: Agent ${args.agent_name} not allowed.`;
            try {
              const nextAgentPath = resolveAgentPath(args.agent_name, workflowDir);
              const nextAgent = parseAgent(nextAgentPath);
              pendingTransfer = nextAgent;
              return `Transferred to agent ${args.agent_name}.`;
            } catch (e) {
              return `Error resolving agent: ${e}`;
            }
          }
        );
      }

      // Execute Stream
      const result = await streamText({
        model: languageModel,
        system: systemPrompt,
        messages: mapToCoreMessages(currentMessages),
        tools: aiTools,
        toolChoice: 'auto',
        maxSteps: step.maxIterations || 10,
        onChunk: (event: any) => {
          if (event.chunk.type === 'text-delta') {
            handleStreamChunk(event.chunk.text);
          }
        },
        abortSignal,
      } as any);

      // Accumulate full text for output
      // Accumulate full text for output
      let fullText = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullText += part.text;
        } else if (part.type === 'tool-call') {
          if (emitEvent && eventContext?.runId && eventContext?.workflow) {
            emitEvent({
              type: 'llm.thought',
              timestamp: new Date().toISOString(),
              runId: eventContext.runId,
              workflow: eventContext.workflow,
              stepId: step.id,
              content: `[Tool Call] ${(part as any).toolName}(${JSON.stringify((part as any).args)})`,
              source: 'reasoning',
            });
          }
        } else if (part.type === 'tool-result') {
          if (emitEvent && eventContext?.runId && eventContext?.workflow) {
            emitEvent({
              type: 'llm.thought',
              timestamp: new Date().toISOString(),
              runId: eventContext.runId,
              workflow: eventContext.workflow,
              stepId: step.id,
              content: `[Tool Result] ${(part as any).toolName}: ${JSON.stringify((part as any).result)}`,
              source: 'reasoning',
            });
          }
        }
      }

      if (!step.outputSchema) {
        flushStream();
      }

      // Standardize history reconstruction using result.response
      // AI SDK's result.response.messages contains the assistant/tool messages generated in this call.
      // We merge them with our existing currentMessages to maintain full history across handoffs.
      const response = await result.response;
      const responseMessages = response.messages;
      const newMessages = mapFromCoreMessages(responseMessages);

      // Merge strategy: Keep all existing messages (user prompts + previous assistant/tool exchanges)
      // and append new messages from this turn, avoiding duplicates by role/content matching
      const existingNonSystem = currentMessages.filter((m) => m.role !== 'system');
      const newNonDuplicate = newMessages.filter(
        (nm) =>
          !existingNonSystem.some(
            (em) =>
              em.role === nm.role &&
              em.content === nm.content &&
              em.tool_call_id === nm.tool_call_id
          )
      );
      currentMessages = [...existingNonSystem, ...newNonDuplicate];

      const usageObj = await result.usage;
      const totalUsage = {
        prompt_tokens: usageObj?.inputTokens ?? 0,
        completion_tokens: usageObj?.outputTokens ?? 0,
        total_tokens: (usageObj?.inputTokens ?? 0) + (usageObj?.outputTokens ?? 0),
      };

      if (requiresSuspend) {
        return {
          status: 'suspended',
          output: { messages: currentMessages, ...suspendData },
          usage: totalUsage,
        };
      }

      if (pendingTransfer) {
        activeAgent = pendingTransfer;
        logger.log(`  🔁 Handoff: Switching to agent ${activeAgent.name}`);
        // Loop continues with new agent and updated history
        continue;
      }

      // If no transfer, we are done.

      // Handle Output Schema parsing if needed
      let output: any = fullText;
      if (step.outputSchema) {
        try {
          output = extractJson(fullText);
        } catch (e) {
          logger.error(
            '  ⚠️  Failed to parse output as JSON. Retrying not implemented in simple refactor.'
          );
          logger.warn(`  Response content (first 500 chars): ${fullText.substring(0, 500)}...`);
        }
      }

      return {
        status: 'success',
        output,
        usage: totalUsage,
      };
    }
  } finally {
    for (const client of localMcpClients) {
      client.stop();
    }
  }
}
