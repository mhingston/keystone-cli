import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import { ExpressionEvaluator } from '../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import { LIMITS } from '../utils/constants';
import { extractJson } from '../utils/json-parser';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';
import { RedactionBuffer, Redactor } from '../utils/redactor';
import { type LLMAdapter, type LLMMessage, type LLMResponse, getAdapter } from './llm-adapter';
import { MCPClient } from './mcp-client';
import type { MCPManager, MCPServerConfig } from './mcp-manager';
import { STANDARD_TOOLS, validateStandardToolSecurity } from './standard-tools';
import type { StepResult } from './step-executor';
import type { WorkflowEvent } from './events.ts';

const SUMMARY_MESSAGE_NAME = 'context_summary';
const SUMMARY_MESSAGE_MAX_BYTES = 4000;
const SUMMARY_INPUT_MESSAGE_MAX_BYTES = 2000;
const SUMMARY_INPUT_TOTAL_MAX_BYTES = 64 * 1024;
const SUMMARY_MODEL_BY_PROVIDER_TYPE: Record<string, string> = {
  openai: 'gpt-4o-mini',
  'openai-chatgpt': 'gpt-4o-mini',
  copilot: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  'anthropic-claude': 'claude-3-haiku-20240307',
  'google-gemini': 'gemini-1.5-flash',
};
const THINKING_OPEN_TAG = '<thinking>';
const THINKING_CLOSE_TAG = '</thinking>';
const TRANSFER_TOOL_NAME = 'transfer_to_agent';
const CONTEXT_UPDATE_KEY = '__keystone_context';

type LlmEventContext = {
  runId?: string;
  workflow?: string;
};

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

/**
 * Truncate message history to prevent unbounded memory growth.
 * Preserves system messages and keeps the most recent messages.
 */
function estimateMessageBytes(message: LLMMessage): number {
  let size = 0;
  if (typeof message.content === 'string') {
    size += Buffer.byteLength(message.content, 'utf8');
  }
  if (message.tool_calls) {
    size += Buffer.byteLength(JSON.stringify(message.tool_calls), 'utf8');
  }
  if (message.reasoning) {
    size += Buffer.byteLength(JSON.stringify(message.reasoning), 'utf8');
  }
  if (message.name) {
    size += Buffer.byteLength(message.name, 'utf8');
  }
  return size;
}

function truncateStringByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = value.slice(0, mid);
    if (Buffer.byteLength(slice, 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
}

function truncateToolOutput(content: string, maxBytes: number): string {
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes <= maxBytes) return content;

  const suffix = '... [truncated output]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const truncated = truncateStringByBytes(content, Math.max(0, maxBytes - suffixBytes));
  return `${truncated}${suffix}`;
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

function truncateMessages(
  messages: LLMMessage[],
  maxHistory: number,
  maxBytes: number
): LLMMessage[] {
  if (messages.length === 0) return messages;

  // Keep all system messages
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Keep most recent non-system messages, accounting for system messages
  const nonSystemLimit = Math.max(0, maxHistory - systemMessages.length);
  let keep = nonSystem.slice(-nonSystemLimit);

  // Enforce total byte budget with a most-recent tail
  if (maxBytes > 0) {
    const systemBytes = systemMessages.reduce((total, msg) => total + estimateMessageBytes(msg), 0);
    let remaining = maxBytes - systemBytes;
    if (remaining <= 0) {
      return systemMessages;
    }

    const tail: LLMMessage[] = [];
    for (let i = keep.length - 1; i >= 0; i--) {
      const msg = keep[i];
      const msgBytes = estimateMessageBytes(msg);
      if (msgBytes > remaining) break;
      tail.push(msg);
      remaining -= msgBytes;
    }
    keep = tail.reverse();
  }

  return [...systemMessages, ...keep];
}

function extractThoughtBlocks(content: string): { content: string; thoughts: string[] } {
  if (!content) return { content, thoughts: [] };
  const thoughts: string[] = [];
  let remaining = content;

  while (true) {
    const lower = remaining.toLowerCase();
    const openIndex = lower.indexOf(THINKING_OPEN_TAG);
    if (openIndex === -1) break;
    const closeIndex = lower.indexOf(THINKING_CLOSE_TAG, openIndex + THINKING_OPEN_TAG.length);
    if (closeIndex === -1) break;

    const before = remaining.slice(0, openIndex);
    const thought = remaining.slice(openIndex + THINKING_OPEN_TAG.length, closeIndex).trim();
    const after = remaining.slice(closeIndex + THINKING_CLOSE_TAG.length);
    if (thought) {
      thoughts.push(thought);
    }
    remaining = `${before}${after}`;
  }

  return { content: remaining, thoughts };
}

function estimateConversationBytes(messages: LLMMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageBytes(msg), 0);
}

function resolveSummaryModel(fullModelString: string, resolvedModel: string): string {
  try {
    const providerName = ConfigLoader.getProviderForModel(fullModelString);
    const config = ConfigLoader.load();
    const providerType = config.providers[providerName]?.type;
    return SUMMARY_MODEL_BY_PROVIDER_TYPE[providerType] ?? resolvedModel;
  } catch {
    return resolvedModel;
  }
}

function formatMessageForSummary(message: LLMMessage): string {
  const roleLabel = message.name ? `${message.role}(${message.name})` : message.role;
  const parts: string[] = [];

  if (typeof message.content === 'string' && message.content.length > 0) {
    parts.push(message.content);
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    parts.push(`tool_calls: ${safeJsonStringify(message.tool_calls)}`);
  }
  if (message.reasoning?.summary) {
    parts.push(`reasoning_summary: ${message.reasoning.summary}`);
  }

  const combined = parts.join('\n').trim();
  const trimmed = combined
    ? truncateStringByBytes(combined, SUMMARY_INPUT_MESSAGE_MAX_BYTES)
    : '';
  return `[${roleLabel}]${trimmed ? ` ${trimmed}` : ''}`;
}

function buildSummaryInput(messages: LLMMessage[]): string {
  const lines: string[] = [];
  let remaining = SUMMARY_INPUT_TOTAL_MAX_BYTES;

  for (const message of messages) {
    const formatted = formatMessageForSummary(message);
    const bytes = Buffer.byteLength(formatted, 'utf8');
    if (bytes > remaining) {
      if (remaining > 0) {
        lines.push(truncateStringByBytes(formatted, remaining));
      }
      break;
    }
    lines.push(formatted);
    remaining -= bytes;
  }

  return lines.join('\n');
}

async function summarizeMessagesIfNeeded(
  messages: LLMMessage[],
  options: {
    maxHistory: number;
    maxBytes: number;
    adapter: LLMAdapter;
    summaryModel: string;
    abortSignal?: AbortSignal;
  }
): Promise<{ messages: LLMMessage[]; usage?: LLMResponse['usage']; summarized: boolean }> {
  const systemMessages = messages.filter(
    (m) => m.role === 'system' && m.name !== SUMMARY_MESSAGE_NAME
  );
  const summaryMessages = messages.filter(
    (m) => m.role === 'system' && m.name === SUMMARY_MESSAGE_NAME
  );
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const maxNonSystem = Math.max(0, options.maxHistory - systemMessages.length - 1);
  const overCount = nonSystemMessages.length > maxNonSystem;
  const overBytes =
    options.maxBytes > 0 && estimateConversationBytes(messages) > options.maxBytes;

  if (!overCount && !overBytes) {
    return { messages, summarized: false };
  }

  if (maxNonSystem <= 0) {
    return {
      messages: truncateMessages(messages, options.maxHistory, options.maxBytes),
      summarized: false,
    };
  }

  const systemBytes = systemMessages.reduce((total, msg) => total + estimateMessageBytes(msg), 0);
  const availableBytes =
    options.maxBytes > 0
      ? options.maxBytes - systemBytes - SUMMARY_MESSAGE_MAX_BYTES
      : Number.POSITIVE_INFINITY;

  const tail: LLMMessage[] = [];
  let tailBytes = 0;
  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    if (tail.length >= maxNonSystem) break;
    const msgBytes = estimateMessageBytes(nonSystemMessages[i]);
    if (options.maxBytes > 0 && tailBytes + msgBytes > availableBytes) {
      break;
    }
    tail.push(nonSystemMessages[i]);
    tailBytes += msgBytes;
  }

  const keepCount = tail.length;
  const summarizeCount = nonSystemMessages.length - keepCount;
  if (summarizeCount <= 0) {
    return { messages, summarized: false };
  }

  const toSummarize = nonSystemMessages.slice(0, summarizeCount);
  const existingSummary = summaryMessages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((content) => content.trim().length > 0)
    .join('\n');
  const summaryInput = buildSummaryInput(toSummarize);

  if (!summaryInput.trim() && !existingSummary.trim()) {
    return {
      messages: truncateMessages(messages, options.maxHistory, options.maxBytes),
      summarized: false,
    };
  }

  const promptParts: string[] = [];
  if (existingSummary.trim()) {
    promptParts.push(`Existing summary:\n${existingSummary}`);
  }
  if (summaryInput.trim()) {
    promptParts.push(`Messages to summarize:\n${summaryInput}`);
  }

  const response = await options.adapter.chat(
    [
      {
        role: 'system',
        content:
          'Summarize the conversation history for continued work. Focus on decisions, constraints, outputs, and open questions. Be concise and factual. Use short bullet points.',
      },
      {
        role: 'user',
        content: promptParts.join('\n\n'),
      },
    ],
    {
      model: options.summaryModel,
      signal: options.abortSignal,
    }
  );

  const summaryText =
    typeof response.message.content === 'string' ? response.message.content.trim() : '';
  if (!summaryText) {
    throw new Error('Summary model returned empty content');
  }

  const summaryContent = truncateStringByBytes(
    `Context summary:\n${summaryText}`,
    SUMMARY_MESSAGE_MAX_BYTES
  );

  const summaryMessage: LLMMessage = {
    role: 'system',
    name: SUMMARY_MESSAGE_NAME,
    content: summaryContent,
  };

  const combinedMessages = [...systemMessages, summaryMessage, ...tail.reverse()];

  return {
    messages: truncateMessages(combinedMessages, options.maxHistory, options.maxBytes),
    usage: response.usage,
    summarized: true,
  };
}

interface ToolDefinition {
  name: string;
  description?: string;
  parameters: unknown;
  source: 'agent' | 'step' | 'mcp' | 'standard' | 'handoff';
  execution?: Step;
  mcpClient?: MCPClient;
}

export async function executeLlmStep(
  step: LlmStep,
  context: ExpressionContext,
  executeStepFn: (step: Step, context: ExpressionContext) => Promise<StepResult>,
  logger: Logger = new ConsoleLogger(),
  mcpManager?: MCPManager,
  workflowDir?: string,
  abortSignal?: AbortSignal,
  getAdapterFn?: typeof getAdapter,
  emitEvent?: (event: WorkflowEvent) => void,
  eventContext?: LlmEventContext
): Promise<StepResult> {
  const agentPath = resolveAgentPath(step.agent, workflowDir);
  let activeAgent = parseAgent(agentPath);

  const provider = step.provider || activeAgent.provider;
  const model = step.model || activeAgent.model || 'gpt-4o';
  const prompt = ExpressionEvaluator.evaluateString(step.prompt, context);

  const fullModelString = provider ? `${provider}:${model}` : model;
  const { adapter, resolvedModel } = (getAdapterFn || getAdapter)(fullModelString);

  const buildSystemPrompt = (agent: Agent): string => {
    let systemPrompt = ExpressionEvaluator.evaluateString(agent.systemPrompt, context);
    if (step.outputSchema) {
      systemPrompt += `\n\nIMPORTANT: You must output valid JSON that matches the following schema:\n${JSON.stringify(step.outputSchema, null, 2)}`;
    }
    return systemPrompt;
  };
  let systemPrompt = buildSystemPrompt(activeAgent);

  let messages: LLMMessage[] = [];
  const maxToolOutputBytes = LIMITS.MAX_TOOL_OUTPUT_BYTES;
  const updateSystemPromptMessage = (newPrompt: string) => {
    const systemMessage = messages.find(
      (message) => message.role === 'system' && message.name !== SUMMARY_MESSAGE_NAME
    );
    if (systemMessage) {
      systemMessage.content = newPrompt;
      return;
    }
    messages.unshift({ role: 'system', content: newPrompt });
  };

  // Resume from state if provided
  const stepState =
    context.steps && typeof context.steps === 'object'
      ? (context.steps as Record<string, { output?: unknown }>)[step.id]
      : undefined;
  const stepOutput = stepState?.output;
  const resumeOutput =
    stepOutput && typeof stepOutput === 'object' && 'messages' in stepOutput
      ? stepOutput
      : context.output;

  if (resumeOutput && typeof resumeOutput === 'object' && 'messages' in resumeOutput) {
    messages.push(...(resumeOutput.messages as LLMMessage[]));

    // If we have an answer in inputs, add it as a tool result for the last tool call
    const stepInputs = context.inputs?.[step.id] as Record<string, unknown> | undefined;
    if (stepInputs && typeof stepInputs === 'object' && '__answer' in stepInputs) {
      const answer = stepInputs.__answer;
      const lastMessage = messages[messages.length - 1];
      const askCall = lastMessage?.tool_calls?.find((tc) => tc.function.name === 'ask');
      if (askCall) {
        messages.push({
          role: 'tool',
          tool_call_id: askCall.id,
          name: 'ask',
          content: truncateToolOutput(String(answer), maxToolOutputBytes),
        });
      }
    }
    updateSystemPromptMessage(systemPrompt);
  } else {
    messages.push({ role: 'system', content: systemPrompt }, { role: 'user', content: prompt });
  }

  const localMcpClients: MCPClient[] = [];
  const baseTools: ToolDefinition[] = [];

  try {
    const registerBaseTool = (tool: ToolDefinition) => {
      baseTools.push(tool);
    };

    // 1. Add step tools
    if (step.tools) {
      for (const tool of step.tools) {
        registerBaseTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
          source: 'step',
          execution: tool.execution,
        });
      }
    }

    // 2. Add Standard tools
    if (step.useStandardTools) {
      for (const tool of STANDARD_TOOLS) {
        registerBaseTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
          source: 'standard',
          execution: tool.execution,
        });
      }
    }

    // 3. Add Engine handoff tool
    if (step.handoff) {
      const toolName = step.handoff.name || 'handoff';
      const description =
        step.handoff.description || `Delegate to engine ${step.handoff.engine.command}`;
      const parameters = step.handoff.inputSchema || {
        type: 'object',
        properties: {},
        additionalProperties: true,
      };

      const handoffStep: Step = {
        id: `${step.id}-handoff`,
        type: 'engine',
        command: step.handoff.engine.command,
        args: step.handoff.engine.args,
        env: step.handoff.engine.env,
        cwd: step.handoff.engine.cwd,
        timeout: step.handoff.engine.timeout,
        outputSchema: step.handoff.engine.outputSchema,
        input: step.handoff.engine.input ?? '${{ args }}',
      };

      registerBaseTool({
        name: toolName,
        description,
        parameters,
        source: 'handoff',
        execution: handoffStep,
      });
    }

    // 4. Add MCP tools
    const mcpServersToConnect: (string | MCPServerConfig)[] = [...(step.mcpServers || [])];
    if (step.useGlobalMcp && mcpManager) {
      const globalServers = mcpManager.getGlobalServers();
      for (const globalServer of globalServers) {
        // Only add if not already explicitly listed
        const alreadyListed = mcpServersToConnect.some((s) => {
          const name = typeof s === 'string' ? s : s.name;
          return name === globalServer.name;
        });
        if (!alreadyListed) {
          mcpServersToConnect.push(globalServer);
        }
      }
    }

    if (mcpServersToConnect.length > 0) {
      await Promise.all(
        mcpServersToConnect.map(async (server) => {
          let client: MCPClient | undefined;
          const serverName = typeof server === 'string' ? server : server.name;

          try {
            if (mcpManager) {
              client = await mcpManager.getClient(server as string | MCPServerConfig, logger);
            } else {
              // Fallback if no manager (should not happen in normal workflow run)
              if (typeof server === 'string') {
                logger.error(
                  `  ✗ Cannot reference global MCP server '${server}' without MCPManager`
                );
                return;
              }
              logger.log(`  🔌 Connecting to MCP server: ${server.name}`);
              client = await MCPClient.createLocal(
                (server as MCPServerConfig).command || 'node',
                (server as MCPServerConfig).args || [],
                (server as MCPServerConfig).env || {}
              );
              await client.initialize();
              localMcpClients.push(client);
            }

            if (client) {
              const mcpTools = await client.listTools();
              for (const tool of mcpTools) {
                registerBaseTool({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                  source: 'mcp',
                  mcpClient: client,
                });
              }
            }
          } catch (error) {
            logger.error(
              `  ✗ Failed to list tools from MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`
            );
            if (!mcpManager && client) {
              client.stop();
            }
          }
        })
      );
    }

    const buildToolsForAgent = (agent: Agent) => {
      const allTools: ToolDefinition[] = [];
      const toolRegistry = new Map<string, string>();
      const registerTool = (tool: ToolDefinition) => {
        const existing = toolRegistry.get(tool.name);
        if (existing) {
          throw new Error(
            `Duplicate tool name "${tool.name}" from ${tool.source}; already defined by ${existing}. Rename one of them.`
          );
        }
        toolRegistry.set(tool.name, tool.source);
        allTools.push(tool);
      };

      for (const tool of agent.tools) {
        registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
          source: 'agent',
          execution: tool.execution,
        });
      }

      for (const tool of baseTools) {
        registerTool(tool);
      }

      const llmTools = allTools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      }));

      if (step.allowClarification) {
        if (toolRegistry.has('ask')) {
          throw new Error(
            'Tool name "ask" is reserved for clarification. Rename your tool or disable allowClarification.'
          );
        }
        llmTools.push({
          type: 'function' as const,
          function: {
            name: 'ask',
            description:
              'Ask the user a clarifying question if the initial request is ambiguous or missing information.',
            parameters: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The question to ask the user',
                },
              },
              required: ['question'],
            } as Record<string, unknown>,
          },
        });
      }

      if (step.allowedHandoffs && step.allowedHandoffs.length > 0) {
        if (toolRegistry.has(TRANSFER_TOOL_NAME)) {
          throw new Error(
            `Tool name "${TRANSFER_TOOL_NAME}" is reserved for agent handoffs. Rename your tool or disable allowedHandoffs.`
          );
        }
        llmTools.push({
          type: 'function' as const,
          function: {
            name: TRANSFER_TOOL_NAME,
            description: `Transfer control to another agent. Allowed agents: ${step.allowedHandoffs.join(', ')}`,
            parameters: {
              type: 'object',
              properties: {
                agent_name: {
                  type: 'string',
                  description: 'The name of the agent to transfer to',
                },
              },
              required: ['agent_name'],
            } as Record<string, unknown>,
          },
        });
      }

      return { allTools, llmTools };
    };

    let allTools: ToolDefinition[] = [];
    let llmTools: {
      type: 'function';
      function: { name: string; description?: string; parameters: Record<string, unknown> };
    }[] = [];

    const refreshToolsForAgent = (agent: Agent) => {
      const toolSet = buildToolsForAgent(agent);
      allTools = toolSet.allTools;
      llmTools = toolSet.llmTools;
    };

    refreshToolsForAgent(activeAgent);
    const applyContextUpdate = (value: unknown): unknown => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }

      const record = value as Record<string, unknown>;
      if (!(CONTEXT_UPDATE_KEY in record)) {
        return value;
      }

      const update = record[CONTEXT_UPDATE_KEY];
      if (update && typeof update === 'object' && !Array.isArray(update)) {
        const updateRecord = update as Record<string, unknown>;

        if (updateRecord.env && typeof updateRecord.env === 'object' && !Array.isArray(updateRecord.env)) {
          const envUpdates = updateRecord.env as Record<string, unknown>;
          context.env = context.env ?? {};
          context.envOverrides = context.envOverrides ?? {};
          for (const [key, val] of Object.entries(envUpdates)) {
            if (val === undefined) continue;
            const stringValue =
              typeof val === 'string'
                ? val
                : (() => {
                    const json = safeJsonStringify(val);
                    return typeof json === 'string' ? json : String(val);
                  })();
            context.env[key] = stringValue;
            context.envOverrides[key] = stringValue;
          }
        }

        if (
          updateRecord.memory &&
          typeof updateRecord.memory === 'object' &&
          !Array.isArray(updateRecord.memory)
        ) {
          context.memory = context.memory ?? {};
          Object.assign(context.memory, updateRecord.memory as Record<string, unknown>);
        }
      }

      const { [CONTEXT_UPDATE_KEY]: _ignored, ...cleaned } = record;
      return cleaned;
    };
    const applyAgentTransfer = (nextAgent: Agent) => {
      activeAgent = nextAgent;
      systemPrompt = buildSystemPrompt(activeAgent);
      updateSystemPromptMessage(systemPrompt);
      refreshToolsForAgent(activeAgent);
    };

    // ReAct Loop
    let iterations = 0;
    const maxIterations = step.maxIterations || 10;
    const totalUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // Create redactor once outside the loop for performance (regex compilation)
    const redactor = new Redactor(context.secrets || {}, {
      forcedSecrets: context.secretValues || [],
    });
    const redactionBuffer = new RedactionBuffer(redactor);
    const maxHistory = step.maxMessageHistory || LIMITS.MAX_MESSAGE_HISTORY;
    const maxConversationBytes = LIMITS.MAX_CONVERSATION_BYTES;
    const contextStrategy = step.contextStrategy || 'truncate';
    const summaryModel =
      contextStrategy === 'summary' || contextStrategy === 'auto'
        ? resolveSummaryModel(fullModelString, resolvedModel)
        : resolvedModel;
    const formatToolContent = (content: string): string =>
      truncateToolOutput(content, maxToolOutputBytes);
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
    const thoughtStream = step.outputSchema ? null : new ThoughtStreamParser();
    let streamedThoughts = 0;
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
        streamedThoughts += 1;
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
        streamedThoughts += 1;
      }
      const final = thoughtStream.flush();
      if (final.output) {
        process.stdout.write(final.output);
      }
      for (const thought of final.thoughts) {
        emitThought(thought, 'thinking');
        streamedThoughts += 1;
      }
    };
    const applyContextStrategy = async () => {
      if (contextStrategy === 'summary' || contextStrategy === 'auto') {
        try {
          const result = await summarizeMessagesIfNeeded(messages, {
            maxHistory,
            maxBytes: maxConversationBytes,
            adapter,
            summaryModel,
            abortSignal,
          });
          messages = result.messages;
          if (result.usage) {
            totalUsage.prompt_tokens += result.usage.prompt_tokens;
            totalUsage.completion_tokens += result.usage.completion_tokens;
            totalUsage.total_tokens += result.usage.total_tokens;
          }
          return;
        } catch (error) {
          logger.warn(
            `Context summarization failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      messages = truncateMessages(messages, maxHistory, maxConversationBytes);
    };

    while (iterations < maxIterations) {
      iterations++;
      if (abortSignal?.aborted) {
        throw new Error('Step canceled');
      }
      streamedThoughts = 0;

      // Apply context strategy to prevent unbounded growth
      await applyContextStrategy();
      const truncatedMessages = messages;

      const response = await adapter.chat(truncatedMessages, {
        model: resolvedModel,
        tools: llmTools.length > 0 ? llmTools : undefined,
        onStream: (chunk) => {
          if (!step.outputSchema) {
            handleStreamChunk(chunk);
          }
        },
        signal: abortSignal,
        responseSchema: step.outputSchema,
      });

      if (!step.outputSchema) {
        flushStream();
      }

      if (response.usage) {
        totalUsage.prompt_tokens += response.usage.prompt_tokens;
        totalUsage.completion_tokens += response.usage.completion_tokens;
        totalUsage.total_tokens += response.usage.total_tokens;
      }

      let { message } = response;
      if (typeof message.content === 'string' && message.content.length > 0) {
        const extracted = extractThoughtBlocks(message.content);
        if (extracted.content !== message.content) {
          message = { ...message, content: extracted.content };
        }
        if (streamedThoughts === 0) {
          for (const thought of extracted.thoughts) {
            emitThought(thought, 'thinking');
          }
        }
      }
      if (message.reasoning?.summary) {
        emitThought(message.reasoning.summary, 'reasoning');
      }

      messages.push(message);

      // 1. Check for native record_output tool call (forced by Anthropic adapter)
      const recordOutputCall = message.tool_calls?.find((tc) => tc.function.name === 'record_output');
      if (step.outputSchema && recordOutputCall) {
        let output: any;
        try {
          output =
            typeof recordOutputCall.function.arguments === 'string'
              ? JSON.parse(recordOutputCall.function.arguments)
              : recordOutputCall.function.arguments;
          return { status: 'success', output, usage: totalUsage };
        } catch (e) {
          logger.error(`Failed to parse native structured output: ${e}`);
          // Fall through to regular tool execution or retry if needed
        }
      }

      // 2. Handle direct output if no tool calls
      if (!message.tool_calls || message.tool_calls.length === 0) {
        let output: any = message.content;

        // If schema is defined, attempt to parse JSON
        if (step.outputSchema) {
          if (typeof output === 'string') {
            try {
              output = extractJson(output);
            } catch (e) {
              const errorMessage = `Failed to parse LLM output as JSON matching schema: ${e instanceof Error ? e.message : String(e)}`;
              logger.error(`  ⚠️  ${errorMessage}. Retrying...`);

              messages.push({
                role: 'user',
                content: `Error: ${errorMessage}\n\nPlease correct your output to be valid JSON matching the schema.`,
              });
              continue;
            }
          }
        }

        return {
          output,
          status: 'success',
          usage: totalUsage,
        };
      }

      // 3. Execute tools
      let pendingTransfer: Agent | null = null;
      for (const toolCall of message.tool_calls) {
        if (abortSignal?.aborted) {
          throw new Error('Step canceled');
        }
        const argsStr = toolCall.function.arguments;
        let displayArgs = '';
        try {
          const parsedArgs = JSON.parse(argsStr);
          const keys = Object.keys(parsedArgs);
          if (keys.length > 0) {
            const formatted = JSON.stringify(parsedArgs);
            displayArgs = formatted.length > 100 ? `${formatted.substring(0, 100)}...` : formatted;
          }
        } catch (e) {
          displayArgs = argsStr.length > 100 ? `${argsStr.substring(0, 100)}...` : argsStr;
        }

        logger.log(
          `  🛠️  Tool Call: ${toolCall.function.name}${displayArgs ? ` ${displayArgs}` : ''}`
        );
        const toolInfo = allTools.find((t) => t.name === toolCall.function.name);

        if (!toolInfo) {
          if (toolCall.function.name === TRANSFER_TOOL_NAME) {
            if (!step.allowedHandoffs || step.allowedHandoffs.length === 0) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent('Error: Agent handoffs are not enabled for this step.'),
              });
              continue;
            }

            let args: { agent_name?: string };
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent(
                  `Error: Invalid JSON in arguments: ${e instanceof Error ? e.message : String(e)}`
                ),
              });
              continue;
            }

            if (!args.agent_name || typeof args.agent_name !== 'string') {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent('Error: "agent_name" must be a string.'),
              });
              continue;
            }

            if (!step.allowedHandoffs.includes(args.agent_name)) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent(
                  `Error: Agent "${args.agent_name}" is not allowed for this step.`
                ),
              });
              continue;
            }

            try {
              const nextAgentPath = resolveAgentPath(args.agent_name, workflowDir);
              const nextAgent = parseAgent(nextAgentPath);
              pendingTransfer = nextAgent;
              logger.log(`  🔁 Handoff: ${activeAgent.name} → ${args.agent_name}`);
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent(`Transferred to agent ${args.agent_name}.`),
              });
            } catch (error) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: TRANSFER_TOOL_NAME,
                content: formatToolContent(
                  `Error: ${error instanceof Error ? error.message : String(error)}`
                ),
              });
            }
            continue;
          }

          if (toolCall.function.name === 'ask' && step.allowClarification) {
            let args: { question: string };
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: 'ask',
                content: formatToolContent(
                  `Error: Invalid JSON in arguments: ${e instanceof Error ? e.message : String(e)}`
                ),
              });
              continue;
            }

            if (process.stdin.isTTY) {
              // In TTY, we can use a human step to get the answer immediately
              logger.log(`\n🤔 Question from ${activeAgent.name}: ${args.question}`);
              const result = await executeStepFn(
                {
                  id: `${step.id}-clarify`,
                  type: 'human',
                  message: args.question,
                  inputType: 'text',
                } as Step,
                context
              );

              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: 'ask',
                content: formatToolContent(String(result.output)),
              });
              continue;
            }
            // In non-TTY, we suspend
            await applyContextStrategy();
            return {
              status: 'suspended',
              output: {
                messages,
                question: args.question,
              },
              usage: totalUsage,
            };
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: formatToolContent(`Error: Tool ${toolCall.function.name} not found`),
          });
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: formatToolContent(
              `Error: Invalid JSON in arguments: ${e instanceof Error ? e.message : String(e)}`
            ),
          });
          continue;
        }

        if (toolInfo.source === 'mcp' && toolInfo.mcpClient) {
          try {
            const result = await toolInfo.mcpClient.callTool(toolInfo.name, args);
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: formatToolContent(safeJsonStringify(applyContextUpdate(result))),
            });
          } catch (error) {
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: formatToolContent(
                `Error: ${error instanceof Error ? error.message : String(error)}`
              ),
            });
          }
        } else if (toolInfo.execution) {
          // Security validation for standard tools
          if (toolInfo.source === 'standard') {
            try {
              validateStandardToolSecurity(toolInfo.name, args, {
                allowOutsideCwd: step.allowOutsideCwd,
                allowInsecure: step.allowInsecure,
              });
            } catch (error) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: formatToolContent(
                  `Security Error: ${error instanceof Error ? error.message : String(error)}`
                ),
              });
              continue;
            }
          }

          // Execute the tool as a step
          const toolContext: ExpressionContext = {
            ...context,
            args, // Use args to pass parameters to tool execution
          };

          const result = await executeStepFn(toolInfo.execution, toolContext);
          const toolOutput =
            result.status === 'success'
              ? safeJsonStringify(applyContextUpdate(result.output))
              : `Error: ${result.error}`;

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: formatToolContent(toolOutput),
          });
        }
      }

      if (pendingTransfer) {
        applyAgentTransfer(pendingTransfer);
      }

      await applyContextStrategy();
    }

    throw new Error('Max ReAct iterations reached');
  } finally {
    // Cleanup LOCAL MCP clients only. Shared clients are managed by MCPManager.
    for (const client of localMcpClients) {
      client.stop();
    }
  }
}
