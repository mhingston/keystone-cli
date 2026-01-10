import { tool as createTool, jsonSchema } from 'ai';
import type { ExpressionContext } from '../../../expression/evaluator';
import { parseAgent, resolveAgentPath } from '../../../parser/agent-parser';
import type { Agent, LlmStep, Step } from '../../../parser/schema';
import { LLM } from '../../../utils/constants';
import type { Logger } from '../../../utils/logger';
import { MCPClient } from '../../mcp-client';
import type { MCPManager, MCPServerConfig } from '../../mcp-manager';
import { STANDARD_TOOLS, validateStandardToolSecurity } from '../../standard-tools';

const { TRANSFER_TOOL_NAME } = LLM;

export type ToolContext = {
  step: LlmStep;
  context: ExpressionContext;
  logger: Logger;
  mcpManager?: MCPManager;
  workflowDir?: string;
  abortSignal?: AbortSignal;
};

export type ToolImplementation = {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any) => Promise<any>;
};

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"error": "Circular or non-serializable content"}';
  }
}

export class ToolManager {
  private tools: ToolImplementation[] = [];
  private aiTools: Record<string, any> = {};
  private localMcpClients: MCPClient[] = [];

  // Special state for control flow tools
  public requiresSuspend = false;
  public suspendData: any = null;
  public pendingTransfer: Agent | undefined;

  constructor(private ctx: ToolContext) {}

  public async registerTools(
    activeAgent: Agent,
    executeStepFn: (step: Step, context: ExpressionContext) => Promise<any>
  ): Promise<Record<string, any>> {
    const { step, mcpManager, logger } = this.ctx;
    this.tools = [];
    this.aiTools = {};
    this.requiresSuspend = false;
    this.suspendData = null;
    this.pendingTransfer = undefined;

    // 1. Agent Tools
    for (const tool of activeAgent.tools) {
      this.registerTool(tool.name, tool.description || '', tool.parameters, async (args) => {
        if (tool.execution) {
          const toolContext = { ...this.ctx.context, args };
          const result = await executeStepFn(tool.execution, toolContext);
          return result.status === 'success'
            ? this.applyContextUpdate(result.output)
            : `Error: ${result.error}`;
        }
        return `Error: Tool ${tool.name} has no implementation.`;
      });
    }

    // 2. Step Tools & Standard Tools
    const standardToolsRecord = STANDARD_TOOLS as any; // Handle index signature issue

    const toolsToRegister: any[] = [...(step.tools || [])];
    if (step.useStandardTools === true) {
      toolsToRegister.push(...Object.values(standardToolsRecord));
    } else if (Array.isArray(step.useStandardTools)) {
      for (const name of step.useStandardTools) {
        if (standardToolsRecord[name]) toolsToRegister.push(standardToolsRecord[name]);
      }
    }

    for (const tool of toolsToRegister) {
      // Check if it's a standard tool or custom definition
      const isStandard = Object.values(standardToolsRecord).includes(tool);

      if (isStandard) {
        // Wrap with security check
        this.registerTool(
          tool.name,
          tool.description || '',
          tool.parameters || {},
          async (args) => {
            validateStandardToolSecurity(tool.name, args, {
              allowOutsideCwd: step.allowOutsideCwd,
              allowInsecure: step.allowInsecure,
            });
            if (tool.execution) {
              // Standard tools usually have .execute method directly on them in STANDARD_TOOLS definition?
              // The definition in standard-tools.ts usually has `execute`.
              // But the schema says `execution` (Step).
              // Let's check `standard-tools.ts` structure if possible.
              // Assuming `execute` exists on the tool definition for standard tools.
              if (typeof tool.execute === 'function') {
                return tool.execute(args, this.ctx.context);
              }
              // If it's a mixed definition (WorkflowStep tool format)
              if (tool.execution) {
                const toolContext = { ...this.ctx.context, args };
                const result = await executeStepFn(tool.execution, toolContext);
                return result.status === 'success'
                  ? this.applyContextUpdate(result.output)
                  : `Error: ${result.error}`;
              }
              // Fallback
              return 'Error: No execution defined for standard tool';
            }
            return 'Error: Invalid tool definition';
          }
        );
      } else {
        // Custom tool
        this.registerTool(
          tool.name,
          tool.description || '',
          tool.parameters || {},
          async (args) => {
            if (tool.execution) {
              const toolContext = { ...this.ctx.context, args };
              const result = await executeStepFn(tool.execution, toolContext);
              return result.status === 'success'
                ? this.applyContextUpdate(result.output)
                : `Error: ${result.error}`;
            }
            return 'Error: No execution defined';
          }
        );
      }
    }

    // 3. MCP Tools
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
            this.localMcpClients.push(client);
          }

          if (client) {
            const mcpTools = await client.listTools();
            for (const t of mcpTools) {
              this.registerTool(t.name, t.description || '', t.inputSchema || {}, async (args) => {
                const res = await client?.callTool(t.name, args);
                return this.applyContextUpdate(res);
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

    // 4. Ask & Transfer
    this.registerControlTools(step, activeAgent, executeStepFn);

    return this.aiTools;
  }

  private registerControlTools(step: LlmStep, activeAgent: Agent, executeStepFn: any) {
    if (step.allowClarification) {
      if (this.aiTools.ask) throw new Error('Tool "ask" is reserved.');
      this.registerTool(
        'ask',
        'Ask the user a clarifying question.',
        {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask the user' },
          },
          required: ['question'],
        },
        async (args) => {
          let question = args.question;
          if (!question) {
            question = args.text || args.message || args.query || args.prompt;
          }
          if (!question) {
            this.ctx.logger.warn(`Tool 'ask' called without question`);
            question = '(Please provide guidance)';
          }

          if (process.stdin.isTTY) {
            const result = await executeStepFn(
              {
                id: `${step.id}-clarify`,
                type: 'human',
                message: `\n🤔 Question from ${activeAgent.name}: ${question}`,
                inputType: 'text',
              } as Step,
              this.ctx.context
            );
            return String(result.output);
          }
          this.requiresSuspend = true;
          this.suspendData = { question };
          return 'Suspended for user input';
        }
      );
    }

    if (step.allowedHandoffs && step.allowedHandoffs.length > 0) {
      if (this.aiTools[TRANSFER_TOOL_NAME])
        throw new Error(`Tool "${TRANSFER_TOOL_NAME}" is reserved.`);
      this.registerTool(
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
            const nextAgentPath = resolveAgentPath(args.agent_name, this.ctx.workflowDir);
            const nextAgent = parseAgent(nextAgentPath);
            this.pendingTransfer = nextAgent;
            return `Transferred to agent ${args.agent_name}.`;
          } catch (e) {
            return `Error resolving agent: ${e}`;
          }
        }
      );
    }
  }

  private registerTool(
    name: string,
    description: string,
    parameters: any,
    execute: (args: any) => Promise<any>
  ) {
    let resolvedParameters = parameters;
    if (
      !resolvedParameters ||
      typeof resolvedParameters !== 'object' ||
      Array.isArray(resolvedParameters)
    ) {
      // fallback or error
      if (!resolvedParameters) resolvedParameters = { type: 'object', properties: {} };
    }

    const safeParameters = { ...resolvedParameters };
    if (
      safeParameters.type === 'object' &&
      safeParameters.properties &&
      safeParameters.additionalProperties === undefined
    ) {
      safeParameters.additionalProperties = false;
    }

    this.tools.push({ name, description, parameters: safeParameters, execute });

    const schema = jsonSchema(safeParameters);
    this.aiTools[name] = createTool({
      description,
      parameters: schema,
      execute: async (args: any) => {
        const actualArgs = args || {};
        if (name !== 'ask') {
          const argsText = Object.keys(actualArgs).length
            ? ` ${safeJsonStringify(actualArgs)}`
            : '';
          this.ctx.logger.log(`  🛠️  Tool Call: ${name}${argsText}`);
        } else {
          this.ctx.logger.debug('  🛠️  Tool Call: ask');
        }
        try {
          return await execute(actualArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error(`  ✗ Tool Error (${name}): ${msg}`);
          return { error: msg };
        }
      },
    } as any);
  }

  private applyContextUpdate(value: unknown): unknown {
    // ... logic from llm-executor ...
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const CONTEXT_UPDATE_KEY = LLM.CONTEXT_UPDATE_KEY;
    if (!(CONTEXT_UPDATE_KEY in record)) return value;

    const update = record[CONTEXT_UPDATE_KEY] as any;
    if (update?.env) {
      this.ctx.context.env = this.ctx.context.env || {};
      Object.assign(this.ctx.context.env, update.env);
    }
    if (update?.memory) {
      this.ctx.context.memory = this.ctx.context.memory || {};
      Object.assign(this.ctx.context.memory, update.memory);
    }
    const { [CONTEXT_UPDATE_KEY]: _ignored, ...cleaned } = record;
    return cleaned;
  }

  public getToolImplementation(name: string): ToolImplementation | undefined {
    return this.tools.find((t) => t.name === name);
  }
}
