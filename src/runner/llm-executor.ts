import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import { ExpressionEvaluator } from '../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../parser/agent-parser';
import type { AgentTool, LlmStep, Step } from '../parser/schema';
import { extractJson } from '../utils/json-parser';
import { RedactionBuffer, Redactor } from '../utils/redactor';
import { type LLMMessage, getAdapter } from './llm-adapter';
import { MCPClient } from './mcp-client';
import type { MCPManager, MCPServerConfig } from './mcp-manager';
import type { StepResult } from './step-executor';
import type { Logger } from './workflow-runner';

interface ToolDefinition {
  name: string;
  description?: string;
  parameters: unknown;
  source: 'agent' | 'step' | 'mcp';
  execution?: Step;
  mcpClient?: MCPClient;
}

export async function executeLlmStep(
  step: LlmStep,
  context: ExpressionContext,
  executeStepFn: (step: Step, context: ExpressionContext) => Promise<StepResult>,
  logger: Logger = console,
  mcpManager?: MCPManager,
  workflowDir?: string
): Promise<StepResult> {
  const agentPath = resolveAgentPath(step.agent, workflowDir);
  const agent = parseAgent(agentPath);

  const provider = step.provider || agent.provider;
  const model = step.model || agent.model || 'gpt-4o';
  const prompt = ExpressionEvaluator.evaluateString(step.prompt, context);

  const fullModelString = provider ? `${provider}:${model}` : model;
  const { adapter, resolvedModel } = getAdapter(fullModelString);

  // Inject schema instructions if present
  let systemPrompt = agent.systemPrompt;
  if (step.schema) {
    systemPrompt += `\n\nIMPORTANT: You must output valid JSON that matches the following schema:\n${JSON.stringify(step.schema, null, 2)}`;
  }

  const messages: LLMMessage[] = [];

  // Resume from state if provided
  if (context.output && typeof context.output === 'object' && 'messages' in context.output) {
    messages.push(...(context.output.messages as LLMMessage[]));

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
          content: String(answer),
        });
      }
    }
  } else {
    messages.push({ role: 'system', content: systemPrompt }, { role: 'user', content: prompt });
  }

  const localMcpClients: MCPClient[] = [];
  const allTools: ToolDefinition[] = [];

  try {
    // 1. Add agent tools
    for (const tool of agent.tools) {
      allTools.push({
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

    // 2. Add step tools
    if (step.tools) {
      for (const tool of step.tools) {
        allTools.push({
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

    // 3. Add MCP tools
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
                allTools.push({
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

    const llmTools = allTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    if (step.allowClarification) {
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

    // ReAct Loop
    let iterations = 0;
    const maxIterations = step.maxIterations || 10;
    const totalUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    // Create redactor once outside the loop for performance (regex compilation)
    const redactor = new Redactor(context.secrets || {});
    const redactionBuffer = new RedactionBuffer(redactor);

    while (iterations < maxIterations) {
      iterations++;

      const response = await adapter.chat(messages, {
        model: resolvedModel,
        tools: llmTools.length > 0 ? llmTools : undefined,
        onStream: (chunk) => {
          if (!step.schema) {
            process.stdout.write(redactionBuffer.process(chunk));
          }
        },
      });

      if (!step.schema) {
        process.stdout.write(redactionBuffer.flush());
      }

      if (response.usage) {
        totalUsage.prompt_tokens += response.usage.prompt_tokens;
        totalUsage.completion_tokens += response.usage.completion_tokens;
        totalUsage.total_tokens += response.usage.total_tokens;
      }

      const { message } = response;
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        let output = message.content;

        // If schema is defined, attempt to parse JSON
        if (step.schema && typeof output === 'string') {
          try {
            output = extractJson(output) as typeof output;
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

        return {
          output,
          status: 'success',
          usage: totalUsage,
        };
      }

      // Execute tools
      for (const toolCall of message.tool_calls) {
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

        logger.log(`  🛠️  Tool Call: ${toolCall.function.name}${displayArgs ? ` ${displayArgs}` : ''}`);
        const toolInfo = allTools.find((t) => t.name === toolCall.function.name);

        if (!toolInfo) {
          if (toolCall.function.name === 'ask' && step.allowClarification) {
            let args: { question: string };
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: 'ask',
                content: `Error: Invalid JSON in arguments: ${e instanceof Error ? e.message : String(e)}`,
              });
              continue;
            }

            if (process.stdin.isTTY) {
              // In TTY, we can use a human step to get the answer immediately
              logger.log(`\n🤔 Question from ${agent.name}: ${args.question}`);
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
                content: String(result.output),
              });
              continue;
            }
            // In non-TTY, we suspend
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
            content: `Error: Tool ${toolCall.function.name} not found`,
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
            content: `Error: Invalid JSON in arguments: ${e instanceof Error ? e.message : String(e)}`,
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
              content: JSON.stringify(result),
            });
          } catch (error) {
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        } else if (toolInfo.execution) {
          // Execute the tool as a step
          const toolContext: ExpressionContext = {
            ...context,
            item: args, // Use item to pass args to tool execution
          };

          const result = await executeStepFn(toolInfo.execution, toolContext);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content:
              result.status === 'success'
                ? JSON.stringify(result.output)
                : `Error: ${result.error}`,
          });
        }
      }
    }

    throw new Error('Max ReAct iterations reached');
  } finally {
    // Cleanup LOCAL MCP clients only. Shared clients are managed by MCPManager.
    for (const client of localMcpClients) {
      client.stop();
    }
  }
}
