import { join } from 'node:path';
import type { ExpressionContext } from '../expression/evaluator';
import { ExpressionEvaluator } from '../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../parser/agent-parser';
import type { AgentTool, LlmStep, Step } from '../parser/schema';
import { type LLMMessage, getAdapter } from './llm-adapter';
import { MCPClient } from './mcp-client';
import type { MCPManager } from './mcp-manager';
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
  mcpManager?: MCPManager
): Promise<StepResult> {
  const agentPath = resolveAgentPath(step.agent);
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

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

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
    const mcpServersToConnect = [...(step.mcpServers || [])];
    if (step.useGlobalMcp && mcpManager) {
      const globalServers = mcpManager.getGlobalServers();
      for (const globalServer of globalServers) {
        // Only add if not already explicitly listed
        const alreadyListed = mcpServersToConnect.some((s) =>
          typeof s === 'string' ? s === globalServer.name : s.name === globalServer.name
        );
        if (!alreadyListed) {
          mcpServersToConnect.push(globalServer);
        }
      }
    }

    if (mcpServersToConnect.length > 0) {
      for (const server of mcpServersToConnect) {
        let client: MCPClient | undefined;

        if (mcpManager) {
          client = await mcpManager.getClient(server, logger);
        } else {
          // Fallback if no manager (should not happen in normal workflow run)
          if (typeof server === 'string') {
            logger.error(`  ✗ Cannot reference global MCP server '${server}' without MCPManager`);
            continue;
          }
          logger.log(`  🔌 Connecting to MCP server: ${server.name}`);
          client = new MCPClient(server.command, server.args, server.env);
          try {
            await client.initialize();
            localMcpClients.push(client);
          } catch (error) {
            logger.error(
              `  ✗ Failed to connect to MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}`
            );
            client.stop();
            client = undefined;
          }
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
      }
    }

    const llmTools = allTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // ReAct Loop
    let iterations = 0;
    const maxIterations = step.maxIterations || 10;

    while (iterations < maxIterations) {
      iterations++;

      const response = await adapter.chat(messages, {
        model: resolvedModel,
        tools: llmTools.length > 0 ? llmTools : undefined,
      });

      const { message } = response;
      messages.push(message);

      if (message.content && !step.schema) {
        logger.log(`\n${message.content}`);
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        let output = message.content;

        // If schema is defined, attempt to parse JSON
        if (step.schema && typeof output === 'string') {
          try {
            // Attempt to extract JSON if wrapped in markdown code blocks or just finding the first {
            const jsonMatch =
              output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i) || output.match(/\{[\s\S]*\}/);
            const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : output;
            output = JSON.parse(jsonStr);
          } catch (e) {
            throw new Error(
              `Failed to parse LLM output as JSON matching schema: ${e instanceof Error ? e.message : String(e)}\nOutput: ${output}`
            );
          }
        }

        return {
          output,
          status: 'success',
        };
      }

      // Execute tools
      for (const toolCall of message.tool_calls) {
        logger.log(`  🛠️  Tool Call: ${toolCall.function.name}`);
        const toolInfo = allTools.find((t) => t.name === toolCall.function.name);

        if (!toolInfo) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: `Error: Tool ${toolCall.function.name} not found`,
          });
          continue;
        }

        const args = JSON.parse(toolCall.function.arguments);

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
            args,
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
