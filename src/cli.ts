#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { Command } from 'commander';

import exploreAgent from './templates/agents/explore.md' with { type: 'text' };
import generalAgent from './templates/agents/general.md' with { type: 'text' };
import architectAgent from './templates/agents/keystone-architect.md' with { type: 'text' };
import softwareEngineerAgent from './templates/agents/software-engineer.md' with { type: 'text' };
import summarizerAgent from './templates/agents/summarizer.md' with { type: 'text' };
import testerAgent from './templates/agents/tester.md' with { type: 'text' };
import handoffRouterAgent from './templates/agents/handoff-router.md' with { type: 'text' };
import handoffSpecialistAgent from './templates/agents/handoff-specialist.md' with { type: 'text' };
import decomposeImplementWorkflow from './templates/decompose-implement.yaml' with { type: 'text' };
import decomposeWorkflow from './templates/decompose-problem.yaml' with { type: 'text' };
import decomposeResearchWorkflow from './templates/decompose-research.yaml' with { type: 'text' };
import decomposeReviewWorkflow from './templates/decompose-review.yaml' with { type: 'text' };
import devWorkflow from './templates/dev.yaml' with { type: 'text' };
import reviewLoopWorkflow from './templates/review-loop.yaml' with { type: 'text' };
import agentHandoffWorkflow from './templates/agent-handoff.yaml' with { type: 'text' };
// Default templates
import scaffoldWorkflow from './templates/scaffold-feature.yaml' with { type: 'text' };
import scaffoldGenerateWorkflow from './templates/scaffold-generate.yaml' with { type: 'text' };
import scaffoldPlanWorkflow from './templates/scaffold-plan.yaml' with { type: 'text' };

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WorkflowDb, type WorkflowRun } from './db/workflow-db.ts';
import type { Workflow } from './parser/schema.ts';
import type { TestDefinition } from './parser/test-schema.ts';
import { WorkflowParser } from './parser/workflow-parser.ts';
import { WorkflowSuspendedError, WorkflowWaitingError } from './runner/step-executor.ts';
import { TestHarness } from './runner/test-harness.ts';
import { ConfigLoader } from './utils/config-loader.ts';
import { LIMITS } from './utils/constants.ts';
import { ConsoleLogger, SilentLogger } from './utils/logger.ts';
import { generateMermaidGraph, renderWorkflowAsAscii } from './utils/mermaid.ts';
import { WorkflowRegistry } from './utils/workflow-registry.ts';
import { container } from './utils/container.ts';
import { MemoryDb } from './db/memory-db.ts';
import { ExpressionEvaluator } from './expression/evaluator.ts';

// Bootstrap DI container with default services
container.factory('logger', () => new ConsoleLogger());
container.factory('db', () => new WorkflowDb());
container.factory('memoryDb', () => new MemoryDb());

import pkg from '../package.json' with { type: 'json' };

const program = new Command();
const defaultRetentionDays = ConfigLoader.load().storage?.retention_days ?? 30;
const MAX_INPUT_STRING_LENGTH = LIMITS.MAX_INPUT_STRING_LENGTH;

program
  .name('keystone')
  .description('A local-first, declarative, agentic workflow orchestrator')
  .version(pkg.version);

/**
 * Parse CLI input pairs (key=value) into a record.
 * Attempts JSON parsing for complex types, falls back to string for simple values.
 *
 * @param pairs Array of key=value strings
 * @returns Record of parsed inputs
 */
const parseInputs = (pairs?: string[]): Record<string, unknown> => {
  const inputs: Record<string, unknown> = Object.create(null);
  const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
  if (!pairs) return inputs;
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) {
      console.warn(`⚠️  Invalid input format: "${pair}" (expected key=value)`);
      continue;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);

    // Validate key format (no special characters that could cause issues)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      console.warn(`⚠️  Invalid input key: "${key}" (use alphanumeric and underscores only)`);
      continue;
    }
    if (blockedKeys.has(key)) {
      console.warn(`⚠️  Invalid input key: "${key}" (reserved keyword)`);
      continue;
    }

    try {
      // Attempt JSON parse for objects, arrays, booleans, numbers
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') {
        if (parsed.length > MAX_INPUT_STRING_LENGTH) {
          console.warn(
            `⚠️  Input "${key}" exceeds maximum length of ${MAX_INPUT_STRING_LENGTH} characters`
          );
          continue;
        }
        if (parsed.includes('\u0000')) {
          console.warn(`⚠️  Input "${key}" contains invalid null characters`);
          continue;
        }
      }
      inputs[key] = parsed;
    } catch {
      if (value.length > MAX_INPUT_STRING_LENGTH) {
        console.warn(
          `⚠️  Input "${key}" exceeds maximum length of ${MAX_INPUT_STRING_LENGTH} characters`
        );
        continue;
      }
      if (value.includes('\u0000')) {
        console.warn(`⚠️  Input "${key}" contains invalid null characters`);
        continue;
      }
      // Check if it looks like malformed JSON (starts with { or [)
      if ((value.startsWith('{') || value.startsWith('[')) && value.length > 1) {
        console.warn(
          `⚠️  Input "${key}" looks like JSON but failed to parse. Check for syntax errors.`
        );
        console.warn(`   Value: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
      }
      // Fall back to string value
      inputs[key] = value;
    }
  }
  return inputs;
};

const validateWorkflows = async (
  pathArg: string | undefined,
  options: { strict?: boolean; explain?: boolean }
): Promise<void> => {
  const path = pathArg || '.keystone/workflows/';

  try {
    let files: string[] = [];
    if (existsSync(path) && (path.endsWith('.yaml') || path.endsWith('.yml'))) {
      files = [path];
    } else if (existsSync(path)) {
      const glob = new Bun.Glob('**/*.{yaml,yml}');
      for await (const file of glob.scan(path)) {
        files.push(join(path, file));
      }
    } else {
      try {
        const resolved = WorkflowRegistry.resolvePath(path);
        files = [resolved];
      } catch {
        console.error(`✗ Path not found: ${path}`);
        process.exit(1);
      }
    }

    if (files.length === 0) {
      console.log('⊘ No workflow files found to validate.');
      return;
    }

    console.log(`🔍 Validating ${files.length} workflow(s)...\n`);

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
      try {
        const workflow = WorkflowParser.loadWorkflow(file);
        if (options.strict) {
          const source = readFileSync(file, 'utf-8');
          WorkflowParser.validateStrict(workflow, source);
        }
        console.log(`  ✓ ${file.padEnd(40)} ${workflow.name} (${workflow.steps.length} steps)`);
        successCount++;
      } catch (error) {
        if (options.explain) {
          const { formatYamlError, renderError } = await import('./utils/error-renderer.ts');
          try {
            const source = readFileSync(file, 'utf-8');
            const formatted = formatYamlError(error as Error, source, file);
            console.error(renderError({ message: formatted.summary, source, filePath: file }));
          } catch {
            console.error(
              renderError({
                message: error instanceof Error ? error.message : String(error),
                filePath: file,
              })
            );
          }
        } else {
          console.error(
            `  ✗ ${file.padEnd(40)} ${error instanceof Error ? error.message : String(error)}`
          );
        }
        failCount++;
      }
    }

    console.log(`\nSummary: ${successCount} passed, ${failCount} failed.`);
    if (failCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('✗ Validation failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

const collectDownstreamSteps = (workflow: Workflow, fromStepId: string): string[] => {
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  if (!stepIds.has(fromStepId)) {
    throw new Error(`Step not found in workflow: ${fromStepId}`);
  }

  const dependents = new Map<string, Set<string>>();
  for (const step of workflow.steps) {
    for (const dep of step.needs) {
      if (!dependents.has(dep)) {
        dependents.set(dep, new Set());
      }
      dependents.get(dep)?.add(step.id);
    }
  }

  const queue = [fromStepId];
  const result = new Set<string>([fromStepId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const next of dependents.get(current) || []) {
      if (!result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }

  return Array.from(result);
};

// ===== keystone init =====
program
  .command('init')
  .description('Initialize a new Keystone project')
  .action(() => {
    console.log('🏛️  Initializing Keystone project...\n');

    // Create directories
    const dirs = ['.keystone', '.keystone/workflows', '.keystone/workflows/agents'];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        console.log(`✓ Created ${dir}/`);
      } else {
        console.log(`⊘ ${dir}/ already exists`);
      }
    }

    // Create default config
    const configPath = '.keystone/config.yaml';
    if (!existsSync(configPath)) {
      const defaultConfig = `# Keystone Configuration
default_provider: openai

providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    default_model: gpt-4o
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY
    default_model: claude-3-5-sonnet-20240620
  groq:
    type: openai
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY
    default_model: llama-3.3-70b-versatile

model_mappings:
  "gpt-*": openai
  "claude-*": anthropic
  "o1-*": openai
  "llama-*": groq

# mcp_servers:
#   filesystem:
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

# engines:
#   allowlist:
#     codex:
#       command: codex
#       version: "1.2.3"
#       versionArgs: ["--version"]

storage:
  retention_days: 30

expression:
  strict: false
`;
      writeFileSync(configPath, defaultConfig);
      console.log(`✓ Created ${configPath}`);
    } else {
      console.log(`⊘ ${configPath} already exists`);
    }

    // Create example .env
    const envPath = '.env';
    if (!existsSync(envPath)) {
      const envTemplate = `# API Keys and Secrets
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
`;
      writeFileSync(envPath, envTemplate);
      console.log(`✓ Created ${envPath}`);
    } else {
      console.log(`⊘ ${envPath} already exists`);
    }

    // Seed default workflows and agents
    const seeds = [
      {
        path: '.keystone/workflows/scaffold-feature.yaml',
        content: scaffoldWorkflow,
      },
      {
        path: '.keystone/workflows/scaffold-plan.yaml',
        content: scaffoldPlanWorkflow,
      },
      {
        path: '.keystone/workflows/scaffold-generate.yaml',
        content: scaffoldGenerateWorkflow,
      },
      {
        path: '.keystone/workflows/decompose-problem.yaml',
        content: decomposeWorkflow,
      },
      {
        path: '.keystone/workflows/decompose-research.yaml',
        content: decomposeResearchWorkflow,
      },
      {
        path: '.keystone/workflows/decompose-implement.yaml',
        content: decomposeImplementWorkflow,
      },
      {
        path: '.keystone/workflows/decompose-review.yaml',
        content: decomposeReviewWorkflow,
      },
      {
        path: '.keystone/workflows/review-loop.yaml',
        content: reviewLoopWorkflow,
      },
      {
        path: '.keystone/workflows/agent-handoff.yaml',
        content: agentHandoffWorkflow,
      },
      {
        path: '.keystone/workflows/agents/keystone-architect.md',
        content: architectAgent,
      },
      {
        path: '.keystone/workflows/agents/general.md',
        content: generalAgent,
      },
      {
        path: '.keystone/workflows/agents/explore.md',
        content: exploreAgent,
      },
      {
        path: '.keystone/workflows/agents/software-engineer.md',
        content: softwareEngineerAgent,
      },
      {
        path: '.keystone/workflows/agents/summarizer.md',
        content: summarizerAgent,
      },
      {
        path: '.keystone/workflows/agents/handoff-router.md',
        content: handoffRouterAgent,
      },
      {
        path: '.keystone/workflows/agents/handoff-specialist.md',
        content: handoffSpecialistAgent,
      },
      {
        path: '.keystone/workflows/dev.yaml',
        content: devWorkflow,
      },
      {
        path: '.keystone/workflows/agents/tester.md',
        content: testerAgent,
      },
    ];

    for (const seed of seeds) {
      if (!existsSync(seed.path)) {
        writeFileSync(seed.path, seed.content);
        console.log(`✓ Seeded ${seed.path}`);
      } else {
        console.log(`⊘ ${seed.path} already exists`);
      }
    }

    console.log('\n✨ Keystone project initialized!');
    console.log('\nNext steps:');
    console.log('  1. Add your API keys to .env');
    console.log('  2. Create a workflow in .keystone/workflows/');
    console.log('  3. Run: keystone run <workflow>');
  });

// ===== keystone validate =====
program
  .command('validate')
  .description('Validate workflow files')
  .argument('[path]', 'Workflow file or directory to validate (default: .keystone/workflows/)')
  .option('--strict', 'Enable strict validation (schemas, enums)')
  .option('--explain', 'Show detailed error context with suggestions')
  .action(async (pathArg, options) => {
    await validateWorkflows(pathArg, options);
  });

// ===== keystone lint =====
program
  .command('lint')
  .description('Lint workflow files (alias of validate)')
  .argument('[path]', 'Workflow file or directory to lint (default: .keystone/workflows/)')
  .option('--strict', 'Enable strict validation (schemas, enums)')
  .option('--explain', 'Show detailed error context with suggestions')
  .action(async (pathArg, options) => {
    await validateWorkflows(pathArg, options);
  });

// ===== keystone graph =====
program
  .command('graph')
  .description('Visualize a workflow as a Mermaid.js graph')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .action(async (workflowPath) => {
    try {
      const resolvedPath = WorkflowRegistry.resolvePath(workflowPath);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);
      const ascii = renderWorkflowAsAscii(workflow);
      if (ascii) {
        console.log(`\n${ascii}\n`);
      } else {
        const mermaid = generateMermaidGraph(workflow);
        console.log('\n```mermaid');
        console.log(mermaid);
        console.log('```\n');
      }
    } catch (error) {
      console.error('✗ Failed to generate graph:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone schema =====
program
  .command('schema')
  .description('Generate JSON Schema for workflow and agent definitions')
  .option('-o, --output <dir>', 'Output directory for schema files', '.keystone/schemas')
  .action(async (options) => {
    const { zodToJsonSchema } = await import('zod-to-json-schema');
    const { WorkflowSchema, AgentSchema } = await import('./parser/schema.ts');

    const workflowJsonSchema = zodToJsonSchema(WorkflowSchema as any, 'KeystoneWorkflow');
    (workflowJsonSchema as any).$schema = 'http://json-schema.org/draft-07/schema#';

    const agentJsonSchema = zodToJsonSchema(AgentSchema as any, 'KeystoneAgent');
    (agentJsonSchema as any).$schema = 'http://json-schema.org/draft-07/schema#';

    const outputDir = resolve(options.output);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(join(outputDir, 'workflow.schema.json'), JSON.stringify(workflowJsonSchema, null, 2));
    writeFileSync(join(outputDir, 'agent.schema.json'), JSON.stringify(agentJsonSchema, null, 2));

    console.log(`✓ Generated JSON schemas in ${outputDir}/`);
    console.log(`  - workflow.schema.json`);
    console.log(`  - agent.schema.json`);
  });

// ===== keystone event =====
program
  .command('event')
  .description('Trigger an event to resume waiting workflows')
  .argument('<name>', 'Event name')
  .argument('[data]', 'Event data (JSON)')
  .action(async (name, dataStr) => {
    const db = container.resolve('db') as WorkflowDb;
    let data = null;
    if (dataStr) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        data = dataStr;
      }
    }
    await db.storeEvent(name, data);
    console.log(`✓ Event '${name}' triggered.`);
  });

// ===== keystone run =====
program
  .command('run')
  .description('Execute a workflow')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .option('-i, --input <key=value...>', 'Input values')
  .option('--dry-run', 'Show what would be executed without actually running it')
  .option('--debug', 'Enable interactive debug mode on failure')
  .option('--events', 'Emit structured JSON events (NDJSON) to stdout')
  .option('--no-dedup', 'Disable idempotency/deduplication')
  .option('--resume', 'Resume the last run of this workflow if it failed or was paused')
  .option('--explain', 'Show detailed error context with suggestions on failure')
  .action(async (workflowPathArg, options) => {
    const inputs = parseInputs(options.input);
    let resolvedPath: string | undefined;

    // Load and validate workflow
    try {
      resolvedPath = WorkflowRegistry.resolvePath(workflowPathArg);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const eventsEnabled = !!options.events;
      const logger = eventsEnabled ? new SilentLogger() : new ConsoleLogger();
      const onEvent = eventsEnabled
        ? (event: unknown) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        : undefined;

      let resumeRunId: string | undefined;

      // Handle auto-resume
      if (options.resume) {
        const db = new WorkflowDb();
        const lastRun = await db.getLastRun(workflow.name);
        db.close();

        if (lastRun) {
          if (
            lastRun.status === 'failed' ||
            lastRun.status === 'paused' ||
            lastRun.status === 'running'
          ) {
            resumeRunId = lastRun.id;
            if (!eventsEnabled) {
              console.log(
                `Resuming run ${lastRun.id} (status: ${lastRun.status}) from ${new Date(
                  lastRun.started_at
                ).toLocaleString()}`
              );
            }
          } else {
            if (!eventsEnabled) {
              console.log(`Last run ${lastRun.id} completed successfully. Starting new run.`);
            }
          }
        } else {
          if (!eventsEnabled) {
            console.log('No previous run found. Starting new run.');
          }
        }
      }

      const runner = new WorkflowRunner(workflow, {
        inputs: resumeRunId ? undefined : inputs,
        resumeInputs: resumeRunId ? inputs : undefined,
        workflowDir: dirname(resolvedPath),
        dryRun: !!options.dryRun,
        debug: !!options.debug,
        dedup: options.dedup,
        resumeRunId,
        logger,
        onEvent,
      });

      const outputs = await runner.run();

      if (!eventsEnabled && Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      if (options.explain) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const { readFileSync } = await import('node:fs');
          const { renderError } = await import('./utils/error-renderer.ts');
          const source = resolvedPath ? readFileSync(resolvedPath, 'utf-8') : undefined;
          console.error(
            renderError({
              message,
              source,
              filePath: resolvedPath,
            })
          );
        } catch {
          console.error('✗ Failed to execute workflow:', message);
        }
      } else {
        console.error(
          '✗ Failed to execute workflow:',
          error instanceof Error ? error.message : error
        );
      }
      process.exit(1);
    }
  });

// ===== keystone watch =====
program
  .command('watch')
  .description('Watch a workflow and re-run on changes')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .option('-i, --input <key=value...>', 'Input values')
  .option('--debug', 'Enable interactive debug mode on failure')
  .option('--events', 'Emit structured JSON events (NDJSON) to stdout')
  .option('--debounce <ms>', 'Debounce delay in milliseconds', '200')
  .action(async (workflowPathArg, options) => {
    const inputs = parseInputs(options.input);
    const eventsEnabled = !!options.events;
    const logger = eventsEnabled ? new SilentLogger() : new ConsoleLogger();
    const onEvent = eventsEnabled
      ? (event: unknown) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      : undefined;
    const debounceMs = Number.parseInt(options.debounce, 10);

    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      console.error('✗ debounce must be a non-negative integer');
      process.exit(1);
    }

    let resolvedPath: string;
    try {
      resolvedPath = WorkflowRegistry.resolvePath(workflowPathArg);
    } catch (error) {
      console.error('✗ Failed to resolve workflow:', error instanceof Error ? error.message : error);
      process.exit(1);
    }

    const watchers = new Map<string, FSWatcher>();
    const warned = new Set<string>();
    let running = false;
    let rerunQueued = false;
    let debounceTimer: NodeJS.Timeout | undefined;

    const logInfo = (message: string) => {
      if (!eventsEnabled) {
        console.log(message);
      }
    };

    const logWarn = (message: string) => {
      if (!eventsEnabled) {
        console.warn(message);
      }
    };

    const normalizePath = (filePath: string) => resolve(filePath);

    const scheduleRun = (reason?: string) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (reason && !eventsEnabled) {
          console.log(`Change detected in ${reason}. Rerunning...`);
        }
        void runWorkflow();
      }, debounceMs);
    };

    const ensureWatcher = (filePath: string) => {
      if (watchers.has(filePath)) return;
      if (!existsSync(filePath)) {
        if (!warned.has(filePath)) {
          warned.add(filePath);
          logWarn(`⚠️  Watch skipped (path not found): ${filePath}`);
        }
        return;
      }
      try {
        const watcher = watch(filePath, () => scheduleRun(filePath));
        watchers.set(filePath, watcher);
      } catch (error) {
        if (!warned.has(filePath)) {
          warned.add(filePath);
          logWarn(
            `⚠️  Failed to watch ${filePath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };

    const updateWatchers = (paths: Set<string>) => {
      for (const existing of Array.from(watchers.keys())) {
        if (!paths.has(existing)) {
          watchers.get(existing)?.close();
          watchers.delete(existing);
        }
      }

      for (const filePath of paths) {
        ensureWatcher(filePath);
      }

      logInfo(`Watching ${paths.size} file(s).`);
    };

    const collectWatchPaths = (
      workflowPath: string,
      workflow: Workflow,
      visited: Set<string> = new Set()
    ): Set<string> => {
      const normalizedPath = normalizePath(workflowPath);
      if (visited.has(normalizedPath)) return new Set();
      visited.add(normalizedPath);

      const watchPaths = new Set<string>([normalizedPath]);
      const baseDir = dirname(workflowPath);
      const allSteps = [
        ...workflow.steps,
        ...(workflow.errors || []),
        ...(workflow.finally || []),
      ];

      for (const step of allSteps) {
        if (step.type === 'file' && step.op === 'read') {
          if (ExpressionEvaluator.hasExpression(step.path)) {
            const warningKey = `${workflowPath}:${step.id}:file`;
            if (!warned.has(warningKey)) {
              warned.add(warningKey);
              logWarn(
                `⚠️  Watch skipped for dynamic file path in step "${step.id}".`
              );
            }
            continue;
          }
          watchPaths.add(normalizePath(resolve(baseDir, step.path)));
        }

        if (step.type === 'workflow') {
          if (ExpressionEvaluator.hasExpression(step.path)) {
            const warningKey = `${workflowPath}:${step.id}:workflow`;
            if (!warned.has(warningKey)) {
              warned.add(warningKey);
              logWarn(
                `⚠️  Watch skipped for dynamic workflow path in step "${step.id}".`
              );
            }
            continue;
          }
          try {
            const childPath = WorkflowRegistry.resolvePath(step.path, baseDir);
            const childWorkflow = WorkflowParser.loadWorkflow(childPath);
            for (const child of collectWatchPaths(childPath, childWorkflow, visited)) {
              watchPaths.add(child);
            }
          } catch (error) {
            const warningKey = `${workflowPath}:${step.id}:workflow-load`;
            if (!warned.has(warningKey)) {
              warned.add(warningKey);
              logWarn(
                `⚠️  Failed to load sub-workflow for step "${step.id}": ${error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
      }

      return watchPaths;
    };

    const runWorkflow = async () => {
      if (running) {
        rerunQueued = true;
        return;
      }
      running = true;

      try {
        const workflow = WorkflowParser.loadWorkflow(resolvedPath);
        const watchPaths = collectWatchPaths(resolvedPath, workflow);
        updateWatchers(watchPaths);

        const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
        const runner = new WorkflowRunner(workflow, {
          inputs,
          workflowDir: dirname(resolvedPath),
          debug: !!options.debug,
          logger,
          onEvent,
        });

        const outputs = await runner.run();
        if (!eventsEnabled && Object.keys(outputs).length > 0) {
          console.log('Outputs:');
          console.log(JSON.stringify(runner.redact(outputs), null, 2));
        }
      } catch (error) {
        console.error(
          '✗ Watch run failed:',
          error instanceof Error ? error.message : error
        );
      } finally {
        running = false;
        if (rerunQueued) {
          rerunQueued = false;
          scheduleRun();
        }
      }
    };

    updateWatchers(new Set([normalizePath(resolvedPath)]));
    logInfo(`Watching workflow: ${resolvedPath}`);
    scheduleRun('initial');

    process.on('SIGINT', () => {
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      logInfo('\nStopping watch.');
      process.exit(0);
    });
  });

// ===== keystone test =====
program
  .command('test')
  .description('Run workflow tests with fixtures and snapshots')
  .argument('[path]', 'Test file or directory to run (default: .keystone/tests/)')
  .option('-u, --update', 'Update snapshots on mismatch or failure')
  .action(async (pathArg, options) => {
    const testPath = pathArg || '.keystone/tests/';

    try {
      let files: string[] = [];
      if (existsSync(testPath) && (testPath.endsWith('.yaml') || testPath.endsWith('.yml'))) {
        files = [testPath];
      } else if (existsSync(testPath)) {
        const glob = new Bun.Glob('**/*.test.{yaml,yml}');
        for await (const file of glob.scan(testPath)) {
          files.push(join(testPath, file));
        }
      }

      if (files.length === 0) {
        console.log('⊘ No test files found.');
        return;
      }

      console.log(`🧪 Running ${files.length} test(s)...\n`);

      let totalPassed = 0;
      let totalFailed = 0;

      for (const file of files) {
        try {
          const content = readFileSync(file, 'utf-8');
          const testDef = parseYaml(content) as TestDefinition;

          console.log(`  ▶ ${testDef.name} (${file})`);

          const workflowPath = WorkflowRegistry.resolvePath(testDef.workflow);
          const workflow = WorkflowParser.loadWorkflow(workflowPath);

          const harness = new TestHarness(workflow, testDef.fixture);
          const result = await harness.run();

          if (!testDef.snapshot || options.update) {
            testDef.snapshot = result;
            writeFileSync(file, stringifyYaml(testDef));
            console.log(`    ✓ Snapshot ${options.update ? 'updated' : 'initialized'}`);
            totalPassed++;
            continue;
          }

          // Compare snapshot (simple JSON stringify for now)
          const expected = JSON.stringify(testDef.snapshot);
          const actual = JSON.stringify(result);

          if (expected !== actual) {
            console.error(`    ✗ Snapshot mismatch in ${file}`);
            totalFailed++;
          } else {
            console.log('    ✓ Passed');
            totalPassed++;
          }
        } catch (error) {
          console.error(
            `    ✗ Test failed: ${error instanceof Error ? error.message : String(error)}`
          );
          totalFailed++;
        }
      }

      console.log(`\nSummary: ${totalPassed} passed, ${totalFailed} failed.`);
      if (totalFailed > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error('✗ Test execution failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone workflows =====
program
  .command('workflows')
  .description('List available workflows')
  .action(() => {
    const workflows = WorkflowRegistry.listWorkflows();
    if (workflows.length === 0) {
      console.log('No workflows found. Run "keystone init" to seed default workflows.');
      return;
    }

    console.log('\n🏛️  Available Workflows:');
    for (const w of workflows) {
      console.log(`\n  ${w.name}`);
      if (w.description) {
        console.log(`    ${w.description}`);
      }
    }
    console.log('');
  });

// ===== keystone optimize =====
program
  .command('optimize')
  .description('Optimize a specific step in a workflow using iterative evaluation')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .requiredOption('-t, --target <step_id>', 'Target step ID to optimize')
  .option('-n, --iterations <number>', 'Number of optimization iterations', '5')
  .option('-i, --input <key=value...>', 'Input values for evaluation')
  .action(async (workflowPath, options) => {
    try {
      const { OptimizationRunner } = await import('./runner/optimization-runner.ts');
      const resolvedPath = WorkflowRegistry.resolvePath(workflowPath);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);

      const inputs = parseInputs(options.input);

      const runner = new OptimizationRunner(workflow, {
        workflowPath: resolvedPath,
        targetStepId: options.target,
        iterations: Number.parseInt(options.iterations, 10),
        inputs,
      });

      console.log('🏛️  Keystone Prompt Optimization');
      const { bestPrompt, bestScore } = await runner.optimize();

      console.log('\n✨ Optimization Complete!');
      console.log(`🏆 Best Score: ${bestScore}/100`);
      console.log('\nBest Prompt/Command:');
      console.log(''.padEnd(80, '-'));
      console.log(bestPrompt);
      console.log(''.padEnd(80, '-'));
    } catch (error) {
      console.error('✗ Optimization failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone resume =====
program
  .command('resume')
  .description('Resume a paused or failed workflow run')
  .argument('<run_id>', 'Run ID to resume')
  .option('-w, --workflow <path>', 'Path to workflow file (auto-detected if not specified)')
  .option('-i, --input <key=value...>', 'Input values for resume')
  .option('--events', 'Emit structured JSON events (NDJSON) to stdout')
  .action(async (runId, options) => {
    try {
      const db = new WorkflowDb();
      const eventsEnabled = !!options.events;

      // Load run from database to get workflow name
      const run = await db.getRun(runId);

      if (!run) {
        console.error(`✗ Run not found: ${runId}`);
        db.close();
        process.exit(1);
      }

      if (!eventsEnabled) {
        console.log(`Found run: ${run.workflow_name} (status: ${run.status})`);
      }

      // Determine workflow file path
      let workflowPath = options.workflow;

      if (!workflowPath) {
        try {
          workflowPath = WorkflowRegistry.resolvePath(run.workflow_name);
        } catch (error) {
          console.error(
            `✗ Could not find workflow file for '${run.workflow_name}'.\n   Use --workflow <path> to specify the path manually.`
          );
          db.close();
          process.exit(1);
        }
      }

      if (!eventsEnabled) {
        console.log(`Loading workflow from: ${workflowPath}\n`);
      }

      // Close DB before loading workflow (will be reopened by runner)
      db.close();

      // Load and validate workflow
      const workflow = WorkflowParser.loadWorkflow(workflowPath);

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const logger = eventsEnabled ? new SilentLogger() : new ConsoleLogger();
      const onEvent = eventsEnabled
        ? (event: unknown) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        : undefined;
      const inputs = parseInputs(options.input);
      const runner = new WorkflowRunner(workflow, {
        resumeRunId: runId,
        resumeInputs: inputs,
        workflowDir: dirname(workflowPath),
        logger,
        onEvent,
      });

      const outputs = await runner.run();

      if (!eventsEnabled && Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error('✗ Failed to resume workflow:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone rerun =====
program
  .command('rerun')
  .description('Rerun a workflow from a specific step (invalidates downstream steps)')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .requiredOption('--from <step_id>', 'Step ID to rerun (downstream steps will be invalidated)')
  .option('-r, --run <run_id>', 'Run ID to rerun (defaults to last run of the workflow)')
  .option('-i, --input <key=value...>', 'Input values for rerun')
  .option('--events', 'Emit structured JSON events (NDJSON) to stdout')
  .action(async (workflowPathArg, options) => {
    let db: WorkflowDb | undefined;
    try {
      const resolvedPath = WorkflowRegistry.resolvePath(workflowPathArg);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);
      const inputs = parseInputs(options.input);
      const eventsEnabled = !!options.events;

      db = new WorkflowDb();
      const runId =
        options.run ||
        (await db.getLastRun(workflow.name))?.id ||
        ((): never => {
          throw new Error(`No runs found for workflow "${workflow.name}"`);
        })();

      const run = await db.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.workflow_name !== workflow.name) {
        console.warn(
          `⚠️  Run ${runId} is for workflow "${run.workflow_name}", but you provided "${workflow.name}".`
        );
      }

      if (run.status === 'running') {
        console.warn(
          '⚠️  Rerunning a run marked as running. Ensure no other instances are active.'
        );
      }

      const stepIds = collectDownstreamSteps(workflow, options.from);
      const clearedSteps = await db.clearStepExecutions(runId, stepIds);
      const clearedIdempotency = await db.clearIdempotencyRecordsForSteps(runId, stepIds);
      const clearedTimers = await db.clearTimersForSteps(runId, stepIds);
      const clearedCompensations = await db.clearCompensationsForSteps(runId, stepIds);

      await db.updateRunStatus(runId, 'paused');
      db.close();
      db = undefined;

      if (!eventsEnabled) {
        console.log(
          `Cleared ${clearedSteps} step execution(s), ${clearedIdempotency} idempotency record(s), ${clearedTimers} timer(s), ${clearedCompensations} compensation(s).`
        );
        console.log(`Resuming run ${runId} from step ${options.from}...\n`);
      }

      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const logger = eventsEnabled ? new SilentLogger() : new ConsoleLogger();
      const onEvent = eventsEnabled
        ? (event: unknown) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        : undefined;
      const runner = new WorkflowRunner(workflow, {
        resumeRunId: runId,
        resumeInputs: inputs,
        workflowDir: dirname(resolvedPath),
        logger,
        allowSuccessResume: true,
        onEvent,
      });

      const outputs = await runner.run();

      if (!eventsEnabled && Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error('✗ Failed to rerun workflow:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      db?.close();
    }
  });

// ===== keystone history =====
program
  .command('history')
  .description('Show recent workflow runs')
  .option('-l, --limit <number>', 'Limit the number of runs to show', '50')
  .action(async (options) => {
    try {
      const db = new WorkflowDb();
      const limit = Number.parseInt(options.limit, 10);
      const runs = await db.listRuns(limit);
      db.close();

      if (runs.length === 0) {
        console.log('No workflow runs found.');
        return;
      }

      console.log('\n🏛️  Workflow Run History:');
      console.log(''.padEnd(100, '-'));
      console.log(
        `${'ID'.padEnd(10)} ${'Workflow'.padEnd(25)} ${'Status'.padEnd(15)} ${'Started At'}`
      );
      console.log(''.padEnd(100, '-'));

      for (const run of runs) {
        const id = run.id.slice(0, 8);
        const status = run.status;
        const color =
          status === 'success' ? '\x1b[32m' : status === 'failed' ? '\x1b[31m' : '\x1b[33m';
        const reset = '\x1b[0m';

        console.log(
          `${id.padEnd(10)} ${run.workflow_name.padEnd(25)} ${color}${status.padEnd(
            15
          )}${reset} ${new Date(run.started_at).toLocaleString()}`
        );
      }
      console.log('');
    } catch (error) {
      console.error('✗ Failed to list runs:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone logs =====
program
  .command('logs')
  .description('Show logs for a specific workflow run')
  .argument('<run_id>', 'Run ID to show logs for')
  .option('-v, --verbose', 'Show detailed step outputs')
  .action(async (runId, options) => {
    try {
      const db = new WorkflowDb();
      const run = await db.getRun(runId);

      if (!run) {
        // Try searching by short ID
        const allRuns = await db.listRuns(200);
        const matching = allRuns.find((r) => r.id.startsWith(runId));
        if (matching) {
          const detailedRun = await db.getRun(matching.id);
          if (detailedRun) {
            await showRunLogs(detailedRun, db, !!options.verbose);
            db.close();
            return;
          }
        }

        console.error(`✗ Run not found: ${runId}`);
        db.close();
        process.exit(1);
      }

      await showRunLogs(run, db, !!options.verbose);
      db.close();
    } catch (error) {
      console.error('✗ Failed to show logs:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone compile =====
program
  .command('compile')
  .description('Compile a project into a single executable with embedded assets')
  .option('-o, --outfile <path>', 'Output executable path', 'keystone-app')
  .option('--project <path>', 'Project directory (default: .)', '.')
  .action(async (options) => {
    const { spawnSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { resolve, join, dirname } = await import('node:path');
    const {
      copyFileSync,
      existsSync,
      lstatSync,
      mkdirSync,
      readdirSync,
      readFileSync,
      readlinkSync,
      rmSync,
      symlinkSync,
    } = await import('node:fs');

    const projectDir = resolve(options.project);
    const outputPath = resolve(options.outfile);
    const outputDir = dirname(outputPath);
    const keystoneDir = join(projectDir, '.keystone');

    if (!existsSync(keystoneDir)) {
      console.error(`✗ No .keystone directory found at ${projectDir}`);
      process.exit(1);
    }

    console.log(`🏗️  Compiling project at ${projectDir}...`);
    console.log(`📂 Embedding assets from ${keystoneDir}`);

    // Find the CLI source path
    const cliSource = resolve(import.meta.dir, 'cli.ts');

    const osName = process.platform === 'win32' ? 'windows' : process.platform;
    const externalPackages: string[] = [];

    const buildArgs = ['build', cliSource, '--compile', '--outfile', outputPath];
    for (const pkg of externalPackages) {
      buildArgs.push('--external', pkg);
    }

    const copyOnnxRuntimeLibs = (outfile: string): { copied: number; checked: boolean } => {
      const runtimeDir = join(
        projectDir,
        'node_modules',
        'onnxruntime-node',
        'bin',
        'napi-v3',
        process.platform,
        process.arch
      );
      if (!existsSync(runtimeDir)) return { copied: 0, checked: false };

      const entries = readdirSync(runtimeDir, { withFileTypes: true });
      const libPattern =
        process.platform === 'win32' ? /^onnxruntime.*\.dll$/i : /^libonnxruntime/i;
      let copied = 0;

      for (const entry of entries) {
        if (!entry.isFile() || !libPattern.test(entry.name)) continue;
        copyFileSync(join(runtimeDir, entry.name), join(dirname(outfile), entry.name));
        copied += 1;
      }

      return { copied, checked: true };
    };

    const copyDir = (source: string, destination: string): void => {
      const stats = lstatSync(source);
      if (stats.isSymbolicLink()) {
        const linkTarget = readlinkSync(source);
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(linkTarget, destination);
        return;
      }
      if (stats.isDirectory()) {
        mkdirSync(destination, { recursive: true });
        for (const entry of readdirSync(source, { withFileTypes: true })) {
          copyDir(join(source, entry.name), join(destination, entry.name));
        }
        return;
      }
      if (stats.isFile()) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
    };

    const copyRuntimeDependencies = (outfile: string): { copied: number; missing: string[] } => {
      const runtimeDir = join(dirname(outfile), 'keystone-runtime');
      const runtimeNodeModules = join(runtimeDir, 'node_modules');
      rmSync(runtimeDir, { recursive: true, force: true });
      mkdirSync(runtimeNodeModules, { recursive: true });

      const roots = [
        '@xenova/transformers',
        'onnxruntime-node',
        'onnxruntime-common',
        'sharp',
        '@huggingface/jinja',
        'sqlite-vec',
        `sqlite-vec-${osName}-${process.arch}`,
      ];

      const require = createRequire(import.meta.url);
      const resolvePackageDir = (pkg: string): string | null => {
        try {
          const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [projectDir] });
          return dirname(pkgJson);
        } catch {
          return null;
        }
      };

      const queue = [...roots];
      const seen = new Set<string>();
      const missing: string[] = [];
      let copied = 0;

      while (queue.length) {
        const pkg = queue.shift();
        if (!pkg || seen.has(pkg)) continue;
        seen.add(pkg);

        const pkgDir = resolvePackageDir(pkg);
        if (!pkgDir) {
          missing.push(pkg);
          continue;
        }

        const destDir = join(runtimeNodeModules, ...pkg.split('/'));
        copyDir(pkgDir, destDir);
        copied += 1;

        try {
          const pkgJsonPath = join(pkgDir, 'package.json');
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
          };
          for (const dep of Object.keys(pkgJson.dependencies || {})) {
            if (!seen.has(dep)) {
              queue.push(dep);
            }
          }
          for (const dep of Object.keys(pkgJson.optionalDependencies || {})) {
            if (seen.has(dep)) continue;
            if (resolvePackageDir(dep)) {
              queue.push(dep);
            }
          }
        } catch {
          // Ignore dependency parsing errors.
        }
      }

      return { copied, missing };
    };

    const copySqliteVecLib = (outfile: string): { copied: number; checked: boolean } => {
      const osName = process.platform === 'win32' ? 'windows' : process.platform;
      const extension =
        process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
      const sqliteVecDir = join(projectDir, 'node_modules', `sqlite-vec-${osName}-${process.arch}`);
      if (!existsSync(sqliteVecDir)) return { copied: 0, checked: false };

      const entries = readdirSync(sqliteVecDir, { withFileTypes: true });
      const targetName = `vec0.${extension}`;
      let copied = 0;

      for (const entry of entries) {
        if (!entry.isFile() || entry.name !== targetName) continue;
        copyFileSync(join(sqliteVecDir, entry.name), join(dirname(outfile), entry.name));
        copied += 1;
      }

      return { copied, checked: true };
    };

    console.log(`🚀 Running: ASSETS_DIR=${keystoneDir} bun ${buildArgs.join(' ')}`);

    const result = spawnSync('bun', buildArgs, {
      env: {
        ...process.env,
        ASSETS_DIR: keystoneDir,
      },
      stdio: 'inherit',
    });

    if (result.status === 0) {
      const { copied, checked } = copyOnnxRuntimeLibs(outputPath);
      if (copied > 0) {
        console.log(`📦 Copied ${copied} ONNX Runtime library file(s) next to ${outputPath}`);
      } else if (checked) {
        console.log(
          'ℹ️  ONNX Runtime library not found; local embeddings may require external setup.'
        );
      }
      const runtimeDeps = copyRuntimeDependencies(outputPath);
      if (runtimeDeps.copied > 0) {
        console.log(
          `📦 Copied ${runtimeDeps.copied} runtime package(s) to ${join(
            outputDir,
            'keystone-runtime'
          )}`
        );
      }
      if (runtimeDeps.missing.length > 0) {
        console.log(`ℹ️  Missing runtime packages: ${runtimeDeps.missing.join(', ')}`);
      }
      const sqliteVecStatus = copySqliteVecLib(outputPath);
      if (sqliteVecStatus.copied > 0) {
        console.log(
          `📦 Copied ${sqliteVecStatus.copied} sqlite-vec extension file(s) next to ${outputPath}`
        );
      } else if (sqliteVecStatus.checked) {
        console.log('ℹ️  sqlite-vec extension not found; memory steps may fail.');
      }
      console.log(`\n✨ Successfully compiled to ${options.outfile}`);
      console.log(`   You can now run ./${options.outfile} anywhere!`);
    } else {
      console.error(`\n✗ Compilation failed with exit code ${result.status}`);
      process.exit(1);
    }
  });

// ===== keystone dev =====
program
  .command('dev')
  .description('Run the self-bootstrapping DevMode workflow')
  .argument('<task>', 'The development task to perform')
  .option('--auto-approve', 'Skip the plan approval step', false)
  .action(async (task, options) => {
    try {
      // Find the dev workflow path
      // Priority:
      // 1. Local .keystone/workflows/dev.yaml
      // 2. Embedded resource
      let devPath: string;
      try {
        devPath = WorkflowRegistry.resolvePath('dev');
      } catch {
        // Fallback to searching in templates if not indexed yet
        devPath = join(process.cwd(), '.keystone/workflows/dev.yaml');
        if (!existsSync(devPath)) {
          console.error('✗ Dev workflow not found. Run "keystone init" to seed it.');
          process.exit(1);
        }
      }

      console.log(`🏗️  Starting DevMode for task: ${task}\n`);

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const { WorkflowParser } = await import('./parser/workflow-parser.ts');
      const logger = new ConsoleLogger();

      const workflow = WorkflowParser.loadWorkflow(devPath);
      const runner = new WorkflowRunner(workflow, {
        inputs: { task, auto_approve: options.auto_approve },
        workflowDir: dirname(devPath),
        logger,
        allowInsecure: true, // Trusted internal workflow
      });

      const outputs = await runner.run();
      if (Object.keys(outputs).length > 0) {
        console.log('\nDevMode Summary:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error('\n✗ DevMode failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone manifest =====
program
  .command('manifest')
  .description('Show embedded assets manifest')
  .action(async () => {
    const { ResourceLoader } = await import('./utils/resource-loader.ts');
    const assets = ResourceLoader.getEmbeddedAssets();
    const keys = Object.keys(assets);

    if (keys.length === 0) {
      console.log('No embedded assets found.');
      return;
    }

    console.log(`\n📦 Embedded Assets (${keys.length}):`);
    for (const key of keys.sort()) {
      console.log(`  - ${key} (${assets[key].length} bytes)`);
    }
    console.log('');
  });

async function showRunLogs(run: WorkflowRun, db: WorkflowDb, verbose: boolean) {
  console.log(`\n🏛️  Run: ${run.workflow_name} (${run.id})`);
  console.log(`   Status: ${run.status}`);
  console.log(`   Started: ${new Date(run.started_at).toLocaleString()}`);
  if (run.completed_at) {
    console.log(`   Completed: ${new Date(run.completed_at).toLocaleString()}`);
  }

  const steps = await db.getStepsByRun(run.id);
  console.log(`\nSteps (${steps.length}):`);
  console.log(''.padEnd(100, '-'));

  for (const step of steps) {
    const statusColor =
      step.status === 'success' ? '\x1b[32m' : step.status === 'failed' ? '\x1b[31m' : '\x1b[33m';
    const reset = '\x1b[0m';

    let label = step.step_id;
    if (step.iteration_index !== null) {
      label += ` [${step.iteration_index}]`;
    }

    console.log(`${statusColor}${step.status.toUpperCase().padEnd(10)}${reset} ${label}`);

    if (step.error) {
      console.log(`           \x1b[31mError: ${step.error}\x1b[0m`);
    }

    if (verbose && step.output) {
      try {
        const output = JSON.parse(step.output);
        console.log(
          `           Output: ${JSON.stringify(output, null, 2).replace(/\n/g, '\n           ')}`
        );
      } catch {
        console.log(`           Output: ${step.output}`);
      }
    }
  }

  if (run.outputs) {
    console.log('\nFinal Outputs:');
    try {
      const parsed = JSON.parse(run.outputs);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(run.outputs);
    }
  }

  if (run.error) {
    console.log(`\n\x1b[31mWorkflow Error:\x1b[0m ${run.error}`);
  }
}

// ===== keystone prune / maintenance =====
async function performMaintenance(days: number) {
  try {
    console.log(`🧹 Starting maintenance (pruning runs older than ${days} days)...`);
    const db = new WorkflowDb();
    const count = await db.pruneRuns(days);
    console.log(`   ✓ Pruned ${count} old run(s)`);

    console.log('   Vacuuming database (reclaiming space)...');
    await db.vacuum();
    console.log('   ✓ Vacuum complete');

    db.close();
    console.log('\n✨ Maintenance completed successfully!');
  } catch (error) {
    console.error('✗ Maintenance failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

program
  .command('prune')
  .description('Delete old workflow runs from the database (alias for maintenance)')
  .option('--days <number>', 'Days to keep', String(defaultRetentionDays))
  .action(async (options) => {
    const days = Number.parseInt(options.days, 10);
    await performMaintenance(days);
  });

program
  .command('maintenance')
  .description('Perform database maintenance (prune old runs and vacuum)')
  .option('--days <days>', 'Delete runs older than this many days', String(defaultRetentionDays))
  .action(async (options) => {
    const days = Number.parseInt(options.days, 10);
    await performMaintenance(days);
  });

// ===== keystone dedup =====
const dedup = program.command('dedup').description('Manage idempotency/deduplication records');

dedup
  .command('list')
  .description('List idempotency records')
  .argument('[run_id]', 'Filter by run ID (optional)')
  .action(async (runId) => {
    try {
      const db = new WorkflowDb();
      const records = await db.listIdempotencyRecords(runId);
      db.close();

      if (records.length === 0) {
        console.log('No idempotency records found.');
        return;
      }

      console.log('\n🔑 Idempotency Records:');
      console.log(''.padEnd(100, '-'));
      console.log(
        `${'Key'.padEnd(30)} ${'Step'.padEnd(15)} ${'Status'.padEnd(10)} ${'Created At'}`
      );
      console.log(''.padEnd(100, '-'));

      for (const record of records) {
        const key = record.idempotency_key.slice(0, 28);
        console.log(
          `${key.padEnd(30)} ${record.step_id.padEnd(15)} ${record.status.padEnd(10)} ${record.created_at}`
        );
      }
      console.log(`\nTotal: ${records.length} record(s)`);
    } catch (error) {
      console.error('✗ Failed to list records:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

dedup
  .command('clear')
  .description('Clear idempotency records')
  .argument('<target>', 'Run ID to clear, or "--all" to clear all records')
  .action(async (target) => {
    try {
      const db = new WorkflowDb();
      let count: number;

      if (target === '--all') {
        count = await db.clearAllIdempotencyRecords();
        console.log(`✓ Cleared ${count} idempotency record(s)`);
      } else {
        count = await db.clearIdempotencyRecords(target);
        console.log(`✓ Cleared ${count} idempotency record(s) for run ${target.slice(0, 8)}`);
      }

      db.close();
    } catch (error) {
      console.error('✗ Failed to clear records:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

dedup
  .command('prune')
  .description('Remove expired idempotency records')
  .action(async () => {
    try {
      const db = new WorkflowDb();
      const count = await db.pruneIdempotencyRecords();
      db.close();
      console.log(`✓ Pruned ${count} expired idempotency record(s)`);
    } catch (error) {
      console.error('✗ Failed to prune records:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone scheduler =====
program
  .command('scheduler')
  .description('Run the durable timer scheduler (polls for ready timers)')
  .option('-i, --interval <seconds>', 'Poll interval in seconds', '30')
  .option('--once', "Run once and exit (don't poll)")
  .action(async (options) => {
    const interval = Number.parseInt(options.interval, 10) * 1000;
    const db = new WorkflowDb();

    console.log('🏛️  Keystone Durable Timer Scheduler');
    console.log(`📡 Polling every ${options.interval}s for ready timers...`);

    const poll = async () => {
      try {
        const pending = await db.getPendingTimers(undefined, 'sleep');
        if (pending.length > 0) {
          console.log(`\n⏰ Found ${pending.length} ready timer(s)`);

          for (const timer of pending) {
            console.log(`   - Resuming run ${timer.run_id.slice(0, 8)} (step: ${timer.step_id})`);

            // Load run to get workflow name
            const run = await db.getRun(timer.run_id);
            if (!run) {
              console.warn(`     ⚠️ Run ${timer.run_id} not found in DB`);
              continue;
            }

            try {
              const workflowPath = WorkflowRegistry.resolvePath(run.workflow_name);
              const workflow = WorkflowParser.loadWorkflow(workflowPath);

              const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
              const runner = new WorkflowRunner(workflow, {
                resumeRunId: timer.run_id,
                workflowDir: dirname(workflowPath),
                logger: new ConsoleLogger(),
              });

              // Running this in current process iteration
              // The runner will handle checking the timer status in restoreState
              await runner.run();
              console.log(`     ✓ Run ${timer.run_id.slice(0, 8)} resumed and finished/paused`);
            } catch (err) {
              if (err instanceof WorkflowWaitingError || err instanceof WorkflowSuspendedError) {
                // This is expected if it hits another wait/human step
                console.log(`     ⏸ Run ${timer.run_id.slice(0, 8)} paused/waiting again`);
              } else {
                console.error(
                  `     ✗ Failed to resume run ${timer.run_id.slice(0, 8)}:`,
                  err instanceof Error ? err.message : String(err)
                );
              }
            }
          }
        }
      } catch (err) {
        console.error('✗ Scheduler error:', err instanceof Error ? err.message : String(err));
      }
    };

    if (options.once) {
      await poll();
      db.close();
      process.exit(0);
    }

    // Polling loop
    await poll();
    setInterval(poll, interval);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\n👋 Scheduler stopping...');
      db.close();
      process.exit(0);
    });
  });

// ===== keystone timers =====
const timersCmd = program.command('timers').description('Manage durable timers');

timersCmd
  .command('list')
  .description('List pending timers')
  .option('-r, --run <run_id>', 'Filter by run ID')
  .action(async (options) => {
    try {
      const db = new WorkflowDb();
      const timers = await db.listTimers(options.run);
      db.close();

      if (timers.length === 0) {
        console.log('No durable timers found.');
        return;
      }

      console.log('\n⏰ Durable Timers:');
      console.log(''.padEnd(100, '-'));
      console.log(
        `${'ID'.padEnd(10)} ${'Run'.padEnd(15)} ${'Step'.padEnd(20)} ${'Type'.padEnd(10)} ${'Wake At'}`
      );
      console.log(''.padEnd(100, '-'));

      for (const timer of timers) {
        const id = timer.id.slice(0, 8);
        const run = timer.run_id.slice(0, 8);
        const wakeAt = timer.wake_at ? new Date(timer.wake_at).toLocaleString() : 'N/A';
        const statusStr = timer.completed_at
          ? ` (DONE at ${new Date(timer.completed_at).toLocaleTimeString()})`
          : '';

        console.log(
          `${id.padEnd(10)} ${run.padEnd(15)} ${timer.step_id.padEnd(20)} ${timer.timer_type.padEnd(
            10
          )} ${wakeAt}${statusStr}`
        );
      }
      console.log(`\nTotal: ${timers.length} timer(s)`);
    } catch (error) {
      console.error('✗ Failed to list timers:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

timersCmd
  .command('clear')
  .description('Clear pending timers')
  .option('-r, --run <run_id>', 'Clear timers for a specific run')
  .option('--all', 'Clear all timers')
  .action(async (options) => {
    try {
      if (!options.all && !options.run) {
        console.error('✗ Please specify --run <id> or --all');
        process.exit(1);
      }
      const db = new WorkflowDb();
      const count = await db.clearTimers(options.run);
      db.close();
      console.log(`✓ Cleared ${count} timer(s)`);
    } catch (error) {
      console.error('✗ Failed to clear timers:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone ui =====
program
  .command('ui')
  .description('Open the TUI dashboard')
  .action(async () => {
    const { startDashboard } = await import('./ui/dashboard.tsx');
    startDashboard();
  });

// ===== keystone mcp =====
const mcp = program.command('mcp').description('Model Context Protocol management');

mcp
  .command('login')
  .description('Login to an MCP server')
  .argument('<server>', 'Server name (from config)')
  .action(async (serverName) => {
    const { ConfigLoader } = await import('./utils/config-loader.ts');
    const { AuthManager } = await import('./utils/auth-manager.ts');

    const config = ConfigLoader.load();
    const server = config.mcp_servers[serverName];

    if (!server || !server.oauth) {
      console.error(`✗ MCP server '${serverName}' is not configured with OAuth.`);
      process.exit(1);
    }

    let url = server.url;

    // If it's a local server using mcp-remote, try to find the URL in args
    if (!url && server.type === 'local' && server.args) {
      url = server.args.find((arg) => arg.startsWith('http'));
    }

    if (!url) {
      console.error(
        `✗ MCP server '${serverName}' does not have a URL configured for authentication.`
      );
      console.log('  Please add a "url" property to your server configuration.');
      process.exit(1);
    }

    console.log(`\n🔐 Authenticating with MCP server: ${serverName}`);
    console.log(`   URL: ${url}\n`);

    // For now, we'll support a manual token entry until we have a full browser redirect flow
    // Most MCP OAuth servers provide a way to get a token via a URL
    const authUrl = url.replace('/sse', '/authorize') || url;
    console.log('1. Visit the following URL to authorize:');
    console.log(`   ${authUrl}`);
    console.log(
      '\n   Note: If you encounter errors, ensure the server is correctly configured and accessible.'
    );
    console.log('   You can still manually provide an OAuth token below if you have one.');
    console.log('\n2. Paste the access token below:\n');

    const { promptSecret } = await import('./utils/prompt.ts');
    const token = await promptSecret('Access Token: ');

    if (token) {
      const auth = AuthManager.load();
      const mcp_tokens = auth.mcp_tokens || {};
      mcp_tokens[serverName] = { access_token: token };
      AuthManager.save({ mcp_tokens });
      console.log(`\n✓ Successfully saved token for MCP server: ${serverName}`);
    } else {
      console.error('✗ No token provided.');
      process.exit(1);
    }
  });

mcp
  .command('start')
  .description('Start the Keystone MCP server (to use Keystone as a tool)')
  .action(async () => {
    const { MCPServer } = await import('./runner/mcp-server.ts');

    if (process.stdin.isTTY) {
      const DIM = '\x1b[2m';
      const CYAN = '\x1b[36m';
      const RESET = '\x1b[0m';

      process.stderr.write(`${CYAN}🏛️  Keystone MCP Server${RESET}\n\n`);
      process.stderr.write(
        'To add this server to Claude Desktop, include this in your configuration:\n'
      );
      process.stderr.write(
        `${DIM}${JSON.stringify(
          {
            mcpServers: {
              keystone: {
                command: 'keystone',
                args: ['mcp'],
              },
            },
          },
          null,
          2
        )}${RESET}\n`
      );
      process.stderr.write(
        `\nStatus: ${CYAN}Running...${RESET} ${DIM}(Press Ctrl+C to stop)${RESET}\n`
      );
    } else {
      process.stderr.write('Keystone MCP Server started\n');
    }

    const server = new MCPServer();
    await server.start();
  });

// ===== keystone config =====
const configCmd = program.command('config').description('Configuration management');

configCmd
  .command('show')
  .alias('list')
  .description('Show current configuration and discovery paths')
  .action(async () => {
    const { ConfigLoader } = await import('./utils/config-loader.ts');
    const { PathResolver } = await import('./utils/paths.ts');
    try {
      const config = ConfigLoader.load();
      console.log('\n🏛️  Keystone Configuration:');
      console.log(JSON.stringify(config, null, 2));

      console.log('\n🔍 Configuration Search Paths (in precedence order):');
      const paths = PathResolver.getConfigPaths();
      for (const [i, p] of paths.entries()) {
        const exists = existsSync(p) ? '✓' : '⊘';
        console.log(`  ${i + 1}. ${exists} ${p}`);
      }
    } catch (error) {
      console.error('✗ Failed to load config:', error instanceof Error ? error.message : error);
    }
  });

// ===== keystone auth =====
const auth = program.command('auth').description('Authentication management');

auth
  .command('login')
  .description('Login to an authentication provider')
  .argument('[provider]', 'Authentication provider', 'github')
  .option('-t, --token <token>', 'Personal Access Token (if not using interactive mode)')
  .option('--project <project_id>', 'Google Cloud project ID (Gemini OAuth)')
  .action(async (provider, options) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const providerName = provider.toLowerCase();

    if (providerName === 'github') {
      let token = options.token;

      if (!token) {
        try {
          const deviceLogin = await AuthManager.initGitHubDeviceLogin();

          console.log('\nTo login with GitHub:');
          console.log(`1. Visit: ${deviceLogin.verification_uri}`);
          console.log(`2. Enter code: ${deviceLogin.user_code}\n`);

          console.log('Waiting for authorization...');
          token = await AuthManager.pollGitHubDeviceLogin(deviceLogin.device_code);
        } catch (error) {
          console.error(
            '\n✗ Failed to login with GitHub device flow:',
            error instanceof Error ? error.message : error
          );
          console.log('\nFalling back to manual token entry...');

          console.log('\nTo login with GitHub manually:');
          console.log(
            '1. Generate a Personal Access Token (Classic) with "copilot" scope (or full repo access).'
          );
          console.log('   https://github.com/settings/tokens/new');
          console.log('2. Paste the token below:\n');

          const prompt = 'Token: ';
          process.stdout.write(prompt);
          for await (const line of console) {
            token = line.trim();
            break;
          }
        }
      }

      if (token) {
        AuthManager.save({ github_token: token });
        // Force refresh of Copilot token to verify
        try {
          const copilotToken = await AuthManager.getCopilotToken();
          if (copilotToken) {
            console.log('\n✓ Successfully logged in to GitHub and retrieved Copilot token.');
          } else {
            console.error(
              '\n✗ Saved GitHub token, but failed to retrieve Copilot token. Please check scopes.'
            );
          }
        } catch (e) {
          console.error('\n✗ Failed to verify token:', e instanceof Error ? e.message : e);
        }
      } else {
        console.error('✗ No token provided.');
        process.exit(1);
      }
    } else if (providerName === 'openai-chatgpt') {
      try {
        await AuthManager.loginOpenAIChatGPT();
        console.log('\n✓ Successfully logged in to OpenAI ChatGPT.');
        return;
      } catch (error) {
        console.error(
          '\n✗ Failed to login with OpenAI ChatGPT:',
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    } else if (providerName === 'anthropic-claude') {
      try {
        const { url, verifier } = AuthManager.createAnthropicClaudeAuth();

        console.log('\nTo login with Anthropic Claude (Pro/Max):');
        console.log('1. Visit the following URL in your browser:');
        console.log(`   ${url}\n`);
        console.log('2. Copy the authorization code and paste it below:\n');

        try {
          const { platform } = process;
          const command =
            platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
          const { spawn } = require('node:child_process');
          spawn(command, [url]);
        } catch (e) {
          // Ignore if we can't open the browser automatically
        }

        let code = options.token;
        if (!code) {
          const prompt = 'Authorization Code: ';
          process.stdout.write(prompt);
          for await (const line of console) {
            code = line.trim();
            break;
          }
        }

        if (!code) {
          console.error('✗ No authorization code provided.');
          process.exit(1);
        }

        const data = await AuthManager.exchangeAnthropicClaudeCode(code, verifier);
        AuthManager.save({
          anthropic_claude: {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
          },
        });
        console.log('\n✓ Successfully logged in to Anthropic Claude.');
        return;
      } catch (error) {
        console.error(
          '\n✗ Failed to login with Anthropic Claude:',
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    } else if (providerName === 'gemini' || providerName === 'google-gemini') {
      try {
        await AuthManager.loginGoogleGemini(options.project);
        console.log('\n✓ Successfully logged in to Google Gemini.');
        return;
      } catch (error) {
        console.error(
          '\n✗ Failed to login with Google Gemini:',
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    } else if (providerName === 'openai' || providerName === 'anthropic') {
      let key = options.token; // Use --token if provided as the API key

      if (!key) {
        console.log(`\n🔑 Login to ${providerName.toUpperCase()}`);
        console.log(`   Please provide your ${providerName.toUpperCase()} API key.\n`);
        const prompt = 'API Key: ';
        process.stdout.write(prompt);
        for await (const line of console) {
          key = line.trim();
          break;
        }
      }

      if (key) {
        if (providerName === 'openai') {
          AuthManager.save({ openai_api_key: key });
        } else {
          AuthManager.save({ anthropic_api_key: key });
        }
        console.log(`\n✓ Successfully saved ${providerName.toUpperCase()} API key.`);
      } else {
        console.error('✗ No API key provided.');
        process.exit(1);
      }
    } else {
      console.error(`✗ Unsupported provider: ${providerName}`);
      process.exit(1);
    }
  });

auth
  .command('status')
  .description('Show authentication status')
  .argument('[provider]', 'Authentication provider')
  .action(async (provider) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const auth = AuthManager.load();
    const providerName = provider?.toLowerCase();

    console.log('\n🏛️  Authentication Status:');

    if (!providerName || providerName === 'github' || providerName === 'copilot') {
      if (auth.github_token) {
        console.log('  ✓ Logged into GitHub');
        if (auth.copilot_expires_at) {
          const expires = new Date(auth.copilot_expires_at * 1000);
          console.log(`  ✓ Copilot session expires: ${expires.toLocaleString()}`);
        }
      } else if (providerName) {
        console.log(
          `  ⊘ Not logged into GitHub. Run "keystone auth login github" to authenticate.`
        );
      }
    }

    if (!providerName || providerName === 'openai' || providerName === 'openai-chatgpt') {
      if (auth.openai_api_key) {
        console.log('  ✓ OpenAI API key configured');
      }
      if (auth.openai_chatgpt) {
        console.log('  ✓ OpenAI ChatGPT subscription (OAuth) authenticated');
        if (auth.openai_chatgpt.expires_at) {
          const expires = new Date(auth.openai_chatgpt.expires_at * 1000);
          console.log(`    Session expires: ${expires.toLocaleString()}`);
        }
      }

      if (providerName && !auth.openai_api_key && !auth.openai_chatgpt) {
        console.log(
          `  ⊘ OpenAI authentication not configured. Run "keystone auth login openai" or "keystone auth login openai-chatgpt" to authenticate.`
        );
      }
    }

    if (!providerName || providerName === 'anthropic' || providerName === 'anthropic-claude') {
      if (auth.anthropic_api_key) {
        console.log('  ✓ Anthropic API key configured');
      }
      if (auth.anthropic_claude) {
        console.log('  ✓ Anthropic Claude subscription (OAuth) authenticated');
        if (auth.anthropic_claude.expires_at) {
          const expires = new Date(auth.anthropic_claude.expires_at * 1000);
          console.log(`    Session expires: ${expires.toLocaleString()}`);
        }
      }

      if (providerName && !auth.anthropic_api_key && !auth.anthropic_claude) {
        console.log(
          `  ⊘ Anthropic authentication not configured. Run "keystone auth login anthropic" or "keystone auth login anthropic-claude" to authenticate.`
        );
      }
    }

    if (!providerName || providerName === 'gemini' || providerName === 'google-gemini') {
      if (auth.google_gemini) {
        console.log('  ✓ Google Gemini subscription (OAuth) authenticated');
        if (auth.google_gemini.email) {
          console.log(`    Account: ${auth.google_gemini.email}`);
        }
        if (auth.google_gemini.expires_at) {
          const expires = new Date(auth.google_gemini.expires_at * 1000);
          console.log(`    Session expires: ${expires.toLocaleString()}`);
        }
      } else if (providerName) {
        console.log(
          `  ⊘ Google Gemini authentication not configured. Run "keystone auth login gemini" to authenticate.`
        );
      }
    }

    if (
      !auth.github_token &&
      !auth.openai_api_key &&
      !auth.openai_chatgpt &&
      !auth.anthropic_api_key &&
      !auth.anthropic_claude &&
      !auth.google_gemini &&
      !providerName
    ) {
      console.log('  ⊘ No providers configured. Run "keystone auth login" to authenticate.');
    }
  });

auth
  .command('logout')
  .description('Logout and clear authentication tokens')
  .argument('[provider]', 'Authentication provider')
  .action(async (provider) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const providerName = provider?.toLowerCase();

    const auth = AuthManager.load();

    if (!providerName || providerName === 'github' || providerName === 'copilot') {
      AuthManager.save({
        github_token: undefined,
        copilot_token: undefined,
        copilot_expires_at: undefined,
      });
      console.log('✓ Successfully logged out of GitHub.');
    } else if (providerName === 'openai' || providerName === 'openai-chatgpt') {
      AuthManager.save({
        openai_api_key: providerName === 'openai' ? undefined : auth.openai_api_key,
        openai_chatgpt: undefined,
      });
      console.log(
        `✓ Successfully cleared ${providerName === 'openai' ? 'OpenAI API key and ' : ''}ChatGPT session.`
      );
    } else if (providerName === 'anthropic' || providerName === 'anthropic-claude') {
      AuthManager.save({
        anthropic_api_key: providerName === 'anthropic' ? undefined : auth.anthropic_api_key,
        anthropic_claude: undefined,
      });
      console.log(
        `✓ Successfully cleared ${providerName === 'anthropic' ? 'Anthropic API key and ' : ''}Claude session.`
      );
    } else if (providerName === 'gemini' || providerName === 'google-gemini') {
      AuthManager.save({
        google_gemini: undefined,
      });
      console.log('✓ Successfully cleared Google Gemini session.');
    } else {
      console.error(`✗ Unknown provider: ${providerName}`);
      process.exit(1);
    }
  });

// ===== Internal Helper Commands (Hidden) =====
program.command('_list-workflows', { hidden: true }).action(() => {
  const workflows = WorkflowRegistry.listWorkflows();
  for (const w of workflows) {
    console.log(w.name);
  }
});

program.command('_list-runs', { hidden: true }).action(async () => {
  try {
    const db = new WorkflowDb();
    const runs = await db.listRuns(50);
    for (const run of runs) {
      console.log(run.id);
    }
    db.close();
  } catch (e) {
    // Ignore errors in helper
  }
});

// ===== keystone completion =====
program
  .command('completion')
  .description('Generate shell completion script')
  .argument('[shell]', 'Shell type (zsh, bash)', 'zsh')
  .action((shell) => {
    if (shell === 'zsh') {
      console.log(`#compdef keystone

if [[ -n $ZSH_VERSION ]]; then
  compdef _keystone keystone
fi

_keystone() {
  local line state

  _arguments -C \\
    "1: :->command" \\
    "*:: :->args"

  case $state in
    command)
      local -a commands
      commands=(
        'init:Initialize a new Keystone project'
        'validate:Validate workflow files'
        'lint:Lint workflow files'
        'graph:Visualize a workflow as a Mermaid.js graph'
        'run:Execute a workflow'
        'resume:Resume a paused or failed workflow run'
        'rerun:Rerun a workflow from a specific step'
        'workflows:List available workflows'
        'history:List recent workflow runs'
        'logs:Show logs for a workflow run'
        'prune:Delete old workflow runs from the database'
        'ui:Open the TUI dashboard'
        'mcp:Start the Model Context Protocol server'
        'config:Show current configuration'
        'auth:Authentication management'
        'completion:Generate shell completion script'
      )
      _describe -t commands 'keystone command' commands
      ;;
    args)
      case $words[1] in
        run)
          _arguments \\
            '(-i --input)'{-i,--input}'[Input values]:key=value' \\
            ':workflow:__keystone_workflows'
          ;;
        graph)
          _arguments ':workflow:__keystone_workflows'
          ;;
        validate)
          _arguments ':path:_files'
          ;;
        lint)
          _arguments ':path:_files'
          ;;
        resume)
          _arguments \\
            '(-i --input)'{-i,--input}'[Input values]:key=value' \\
            ':run_id:__keystone_runs'
          ;;
        rerun)
          _arguments ':workflow:__keystone_workflows'
          ;;
        logs)
          _arguments ':run_id:__keystone_runs'
          ;;
        auth)
          local -a auth_commands
          auth_commands=(
            'login:Login to an authentication provider'
            'status:Show authentication status'
            'logout:Logout and clear authentication tokens'
          )
          _describe -t auth_commands 'auth command' auth_commands
          ;;
      esac
      ;;
  esac
}

__keystone_workflows() {
  local -a workflows
  workflows=($(keystone _list-workflows 2>/dev/null))
  _describe -t workflows 'workflow' workflows
}

__keystone_runs() {
  local -a runs
  runs=($(keystone _list-runs 2>/dev/null))
  _describe -t runs 'run_id' runs
}
`);
    } else if (shell === 'bash') {
      console.log(`_keystone_completion() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD - 1]}"
  opts="init validate lint graph run watch resume rerun workflows history logs prune ui mcp config auth completion"

  case "\${prev}" in
    run|graph|rerun)
      local workflows=$(keystone _list-workflows 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${workflows}" -- \${cur}) )
      return 0
      ;;
    resume|logs)
      local runs=$(keystone _list-runs 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${runs}" -- \${cur}) )
      return 0
      ;;
  esac

  COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}
complete -F _keystone_completion keystone`);
    } else {
      console.error(`✗ Unsupported shell: ${shell}. Supported: zsh, bash`);
      process.exit(1);
    }
  });

program.parse();
