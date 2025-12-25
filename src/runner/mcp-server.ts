import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import pkg from '../../package.json' with { type: 'json' };
import { WorkflowDb } from '../db/workflow-db';
import { WorkflowParser } from '../parser/workflow-parser';
import { ConsoleLogger, type Logger } from '../utils/logger';
import { generateMermaidGraph } from '../utils/mermaid';
import { WorkflowRegistry } from '../utils/workflow-registry';
import { WorkflowSuspendedError } from './step-executor';
import { WorkflowRunner } from './workflow-runner';

interface MCPMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number;
}

export class MCPServer {
  private db: WorkflowDb;
  private input: Readable;
  private output: Writable;
  private logger: Logger;

  constructor(
    db?: WorkflowDb,
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    logger: Logger = new ConsoleLogger()
  ) {
    this.db = db || new WorkflowDb();
    this.input = input;
    this.output = output;
    this.logger = logger;
  }

  async start() {
    const rl = readline.createInterface({
      input: this.input,
      terminal: false,
    });

    return new Promise<void>((resolve) => {
      rl.on('line', async (line) => {
        if (!line.trim()) return;

        try {
          const message = JSON.parse(line) as MCPMessage;
          const response = await this.handleMessage(message);
          if (response) {
            this.output.write(`${JSON.stringify(response)}\n`);
          }
        } catch (error) {
          this.logger.error(`Error handling MCP message: ${error}`);
        }
      });

      rl.on('close', () => {
        this.stop();
        resolve();
      });

      // Handle stream errors
      this.input.on('error', (err: Error) => {
        this.logger.error(`stdin error: ${err}`);
      });
    });
  }

  stop() {
    this.db.close();
  }

  private async handleMessage(message: MCPMessage) {
    const { method, params, id } = message;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'keystone-mcp',
              version: pkg.version,
            },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'list_workflows',
                description: 'List all available workflows and their required inputs.',
                inputSchema: {
                  type: 'object',
                  properties: {},
                },
              },
              {
                name: 'run_workflow',
                description: 'Execute a workflow by name.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    workflow_name: {
                      type: 'string',
                      description: 'The name of the workflow to run (e.g., "deploy", "cleanup")',
                    },
                    inputs: {
                      type: 'object',
                      description: 'Key-value pairs for workflow inputs',
                    },
                  },
                  required: ['workflow_name'],
                },
              },
              {
                name: 'get_run_logs',
                description: 'Get the logs and status of a specific workflow run.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    run_id: { type: 'string' },
                  },
                  required: ['run_id'],
                },
              },
              {
                name: 'get_workflow_graph',
                description: 'Get a visual diagram (Mermaid.js) of the workflow structure.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    workflow_name: { type: 'string' },
                  },
                  required: ['workflow_name'],
                },
              },
              {
                name: 'answer_human_input',
                description:
                  'Provide input to a workflow that is paused waiting for human interaction.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    run_id: { type: 'string', description: 'The ID of the paused run' },
                    input: {
                      type: 'string',
                      description: 'The text input or "confirm" for confirmation steps',
                    },
                  },
                  required: ['run_id', 'input'],
                },
              },
              {
                name: 'start_workflow',
                description:
                  'Start a workflow asynchronously. Returns immediately with a run_id. Use get_run_status to poll for completion.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    workflow_name: {
                      type: 'string',
                      description: 'The name of the workflow to run (e.g., "deploy", "cleanup")',
                    },
                    inputs: {
                      type: 'object',
                      description: 'Key-value pairs for workflow inputs',
                    },
                  },
                  required: ['workflow_name'],
                },
              },
              {
                name: 'get_run_status',
                description:
                  'Get the current status of a workflow run. Returns status and outputs if complete.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    run_id: {
                      type: 'string',
                      description: 'The ID of the workflow run',
                    },
                  },
                  required: ['run_id'],
                },
              },
            ],
          },
        };

      case 'tools/call': {
        const toolParams = params as { name: string; arguments: Record<string, unknown> };

        try {
          // --- Tool: list_workflows ---
          if (toolParams.name === 'list_workflows') {
            const workflows = WorkflowRegistry.listWorkflows();
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(workflows, null, 2) }],
              },
            };
          }

          // --- Tool: run_workflow ---
          if (toolParams.name === 'run_workflow') {
            const { workflow_name, inputs } = toolParams.arguments as {
              workflow_name: string;
              inputs: Record<string, unknown>;
            };

            const path = WorkflowRegistry.resolvePath(workflow_name);
            const workflow = WorkflowParser.loadWorkflow(path);

            // Use a custom logger that captures logs for the MCP response
            const logs: string[] = [];
            const logger = {
              log: (msg: string) => logs.push(msg),
              error: (msg: string) => logs.push(`ERROR: ${msg}`),
              warn: (msg: string) => logs.push(`WARN: ${msg}`),
              info: (msg: string) => logs.push(`INFO: ${msg}`),
              debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
            };

            const runner = new WorkflowRunner(workflow, {
              inputs,
              logger,
              preventExit: true,
            });

            // Note: This waits for completion. For long workflows, we might want to
            // return the run_id immediately and let the agent poll via get_run_logs.
            // For now, synchronous is easier for the agent to reason about.
            let outputs: Record<string, unknown> | undefined;
            try {
              outputs = await runner.run();
            } catch (error) {
              if (error instanceof WorkflowSuspendedError) {
                return {
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            status: 'paused',
                            run_id: runner.getRunId(),
                            message: error.message,
                            step_id: error.stepId,
                            input_type: error.inputType,
                            instructions:
                              error.inputType === 'confirm'
                                ? 'Use answer_human_input with input="confirm" to proceed.'
                                : 'Use answer_human_input with the required text input.',
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  },
                };
              }
              // Even if it fails, we return the logs so the agent knows why
              return {
                jsonrpc: '2.0',
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: `Workflow failed.\n\nLogs:\n${logs.join('\n')}`,
                    },
                  ],
                },
              };
            }

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        status: 'success',
                        outputs,
                        logs: logs.slice(-20), // Return last 20 lines to avoid token limits
                      },
                      null,
                      2
                    ),
                  },
                ],
              },
            };
          }

          // --- Tool: get_run_logs ---
          if (toolParams.name === 'get_run_logs') {
            const { run_id } = toolParams.arguments as { run_id: string };
            const run = await this.db.getRun(run_id);

            if (!run) {
              throw new Error(`Run ID ${run_id} not found`);
            }

            const steps = await this.db.getStepsByRun(run_id);
            const summary = {
              workflow: run.workflow_name,
              status: run.status,
              error: run.error,
              steps: steps.map((s) => ({
                step: s.step_id,
                status: s.status,
                error: s.error,
                output: s.output ? JSON.parse(s.output) : null,
              })),
            };

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
              },
            };
          }

          // --- Tool: get_workflow_graph ---
          if (toolParams.name === 'get_workflow_graph') {
            const { workflow_name } = toolParams.arguments as { workflow_name: string };
            const path = WorkflowRegistry.resolvePath(workflow_name);
            const workflow = WorkflowParser.loadWorkflow(path);

            const mermaid = generateMermaidGraph(workflow);

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Here is the graph for **${workflow_name}**:\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
                  },
                ],
              },
            };
          }

          // --- Tool: answer_human_input ---
          if (toolParams.name === 'answer_human_input') {
            const { run_id, input } = toolParams.arguments as { run_id: string; input: string };
            const run = await this.db.getRun(run_id);
            if (!run) {
              throw new Error(`Run ID ${run_id} not found`);
            }

            if (run.status !== 'paused') {
              throw new Error(`Run ${run_id} is not paused (status: ${run.status})`);
            }

            // Find the pending or suspended step
            const steps = await this.db.getStepsByRun(run_id);
            const pendingStep = steps.find(
              (s) => s.status === 'pending' || s.status === 'suspended'
            );
            if (!pendingStep) {
              throw new Error(`No pending or suspended step found for run ${run_id}`);
            }

            // Fulfill the step in the DB
            let output: unknown = input;
            const lowerInput = input.trim().toLowerCase();
            if (
              lowerInput === 'confirm' ||
              lowerInput === 'y' ||
              lowerInput === 'yes' ||
              lowerInput === ''
            ) {
              output = true;
            } else if (lowerInput === 'n' || lowerInput === 'no') {
              output = false;
            }

            await this.db.completeStep(pendingStep.id, 'success', output);

            // Resume the workflow
            const path = WorkflowRegistry.resolvePath(run.workflow_name);
            const workflow = WorkflowParser.loadWorkflow(path);

            const logs: string[] = [];
            const logger = {
              log: (msg: string) => logs.push(msg),
              error: (msg: string) => logs.push(`ERROR: ${msg}`),
              warn: (msg: string) => logs.push(`WARN: ${msg}`),
              info: (msg: string) => logs.push(`INFO: ${msg}`),
              debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
            };

            const runner = new WorkflowRunner(workflow, {
              resumeRunId: run_id,
              resumeInputs: { [pendingStep.step_id]: { __answer: output } },
              logger,
              preventExit: true,
            });

            let outputs: Record<string, unknown> | undefined;
            try {
              outputs = await runner.run();
            } catch (error) {
              if (error instanceof WorkflowSuspendedError) {
                return {
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            status: 'paused',
                            run_id: runner.getRunId(),
                            message: error.message,
                            step_id: error.stepId,
                            input_type: error.inputType,
                            instructions:
                              error.inputType === 'confirm'
                                ? 'Use answer_human_input with input="confirm" to proceed.'
                                : 'Use answer_human_input with the required text input.',
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  },
                };
              }

              return {
                jsonrpc: '2.0',
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: `Workflow failed after resume.\n\nLogs:\n${logs.join('\n')}`,
                    },
                  ],
                },
              };
            }

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        status: 'success',
                        outputs,
                        logs: logs.slice(-20),
                      },
                      null,
                      2
                    ),
                  },
                ],
              },
            };
          }

          // --- Tool: start_workflow (async) ---
          if (toolParams.name === 'start_workflow') {
            const { workflow_name, inputs } = toolParams.arguments as {
              workflow_name: string;
              inputs?: Record<string, unknown>;
            };

            const path = WorkflowRegistry.resolvePath(workflow_name);
            const workflow = WorkflowParser.loadWorkflow(path);

            // Create a silent logger - we don't capture logs for async runs
            const logger = {
              log: () => {},
              error: () => {},
              warn: () => {},
              info: () => {},
              debug: () => {},
            };

            const runner = new WorkflowRunner(workflow, {
              inputs: inputs || {},
              logger,
              preventExit: true,
            });

            const runId = runner.getRunId();

            // Start the workflow asynchronously
            runner.run().then(
              async (outputs) => {
                // Update DB with success on completion
                await this.db.updateRunStatus(runId, 'success', outputs);
              },
              async (error) => {
                // Update DB with failure
                if (error instanceof WorkflowSuspendedError) {
                  await this.db.updateRunStatus(runId, 'paused');
                } else {
                  await this.db.updateRunStatus(
                    runId,
                    'failed',
                    undefined,
                    error instanceof Error ? error.message : String(error)
                  );
                }
              }
            );

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        status: 'running',
                        run_id: runId,
                        workflow: workflow_name,
                        hint: 'Use get_run_status to check for completion.',
                      },
                      null,
                      2
                    ),
                  },
                ],
              },
            };
          }

          // --- Tool: get_run_status ---
          if (toolParams.name === 'get_run_status') {
            const { run_id } = toolParams.arguments as { run_id: string };
            const run = await this.db.getRun(run_id);

            if (!run) {
              throw new Error(`Run ID ${run_id} not found`);
            }

            const response: Record<string, unknown> = {
              run_id,
              workflow: run.workflow_name,
              status: run.status,
            };

            // Include outputs if completed successfully
            if (run.status === 'success' && run.outputs) {
              response.outputs = JSON.parse(run.outputs);
            }

            // Include error if failed
            if (run.status === 'failed' && run.error) {
              response.error = run.error;
            }

            // Include hint for paused workflows
            if (run.status === 'paused') {
              response.hint =
                'Workflow is paused waiting for human input. Use answer_human_input to resume.';
            }

            // Include hint for running workflows
            if (run.status === 'running') {
              response.hint =
                'Workflow is still running. Call get_run_status again to check for completion.';
            }

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
              },
            };
          }

          throw new Error(`Unknown tool: ${toolParams.name}`);
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  }
}
