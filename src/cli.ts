#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';

import exploreAgent from './templates/agents/explore.md' with { type: 'text' };
import generalAgent from './templates/agents/general.md' with { type: 'text' };
import architectAgent from './templates/agents/keystone-architect.md' with { type: 'text' };
import softwareEngineerAgent from './templates/agents/software-engineer.md' with { type: 'text' };
import summarizerAgent from './templates/agents/summarizer.md' with { type: 'text' };
import decomposeImplementWorkflow from './templates/decompose-implement.yaml' with { type: 'text' };
import decomposeWorkflow from './templates/decompose-problem.yaml' with { type: 'text' };
import decomposeResearchWorkflow from './templates/decompose-research.yaml' with { type: 'text' };
import decomposeReviewWorkflow from './templates/decompose-review.yaml' with { type: 'text' };
import devWorkflow from './templates/dev.yaml' with { type: 'text' };
import testerAgent from './templates/agents/tester.md' with { type: 'text' };
// Default templates
import scaffoldWorkflow from './templates/scaffold-feature.yaml' with { type: 'text' };
import scaffoldGenerateWorkflow from './templates/scaffold-generate.yaml' with { type: 'text' };
import scaffoldPlanWorkflow from './templates/scaffold-plan.yaml' with { type: 'text' };

import { WorkflowDb, type WorkflowRun } from './db/workflow-db.ts';
import { WorkflowParser } from './parser/workflow-parser.ts';
import { WorkflowSuspendedError, WorkflowWaitingError } from './runner/step-executor.ts';
import { ConfigLoader } from './utils/config-loader.ts';
import { ConsoleLogger } from './utils/logger.ts';
import { generateMermaidGraph, renderWorkflowAsAscii } from './utils/mermaid.ts';
import { WorkflowRegistry } from './utils/workflow-registry.ts';
import { TestHarness } from './runner/test-harness.ts';
import type { TestDefinition } from './parser/test-schema.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import pkg from '../package.json' with { type: 'json' };

const program = new Command();
const defaultRetentionDays = ConfigLoader.load().storage?.retention_days ?? 30;

program
  .name('keystone')
  .description('A local-first, declarative, agentic workflow orchestrator')
  .version(pkg.version);

const parseInputs = (pairs?: string[]): Record<string, unknown> => {
  const inputs: Record<string, unknown> = {};
  if (!pairs) return inputs;
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index > 0) {
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      try {
        inputs[key] = JSON.parse(value);
      } catch {
        inputs[key] = value;
      }
    }
  }
  return inputs;
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
            const { readFileSync } = await import('node:fs');
            const { formatYamlError, renderError, formatError } = await import(
              './utils/error-renderer.ts'
            );
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

// ===== keystone run =====
program
  .command('run')
  .description('Execute a workflow')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .option('-i, --input <key=value...>', 'Input values')
  .option('--dry-run', 'Show what would be executed without actually running it')
  .option('--debug', 'Enable interactive debug mode on failure')
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
      const logger = new ConsoleLogger();

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
            console.log(
              `Resuming run ${lastRun.id} (status: ${lastRun.status}) from ${new Date(
                lastRun.started_at
              ).toLocaleString()}`
            );
          } else {
            console.log(`Last run ${lastRun.id} completed successfully. Starting new run.`);
          }
        } else {
          console.log('No previous run found. Starting new run.');
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
      });

      const outputs = await runner.run();

      if (Object.keys(outputs).length > 0) {
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
            console.log(`    ✓ Passed`);
            totalPassed++;
          }
        } catch (error) {
          console.error(`    ✗ Test failed: ${error instanceof Error ? error.message : String(error)}`);
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
  .action(async (runId, options) => {
    try {
      const db = new WorkflowDb();

      // Load run from database to get workflow name
      const run = await db.getRun(runId);

      if (!run) {
        console.error(`✗ Run not found: ${runId}`);
        db.close();
        process.exit(1);
      }

      console.log(`Found run: ${run.workflow_name} (status: ${run.status})`);

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

      console.log(`Loading workflow from: ${workflowPath}\n`);

      // Close DB before loading workflow (will be reopened by runner)
      db.close();

      // Load and validate workflow
      const workflow = WorkflowParser.loadWorkflow(workflowPath);

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const logger = new ConsoleLogger();
      const inputs = parseInputs(options.input);
      const runner = new WorkflowRunner(workflow, {
        resumeRunId: runId,
        resumeInputs: inputs,
        workflowDir: dirname(workflowPath),
        logger,
      });

      const outputs = await runner.run();

      if (Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error('✗ Failed to resume workflow:', error instanceof Error ? error.message : error);
      process.exit(1);
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
    const { resolve, join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    const projectDir = resolve(options.project);
    const keystoneDir = join(projectDir, '.keystone');

    if (!existsSync(keystoneDir)) {
      console.error(`✗ No .keystone directory found at ${projectDir}`);
      process.exit(1);
    }

    console.log(`🏗️  Compiling project at ${projectDir}...`);
    console.log(`📂 Embedding assets from ${keystoneDir}`);

    // Find the CLI source path
    const cliSource = resolve(import.meta.dir, 'cli.ts');

    const buildArgs = [
      'build',
      cliSource,
      '--compile',
      '--outfile',
      options.outfile,
    ];

    console.log(`🚀 Running: ASSETS_DIR=${keystoneDir} bun ${buildArgs.join(' ')}`);

    const result = spawnSync('bun', buildArgs, {
      env: {
        ...process.env,
        ASSETS_DIR: keystoneDir,
      },
      stdio: 'inherit',
    });

    if (result.status === 0) {
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

    if (!providerName || providerName === 'openai') {
      if (auth.openai_api_key) {
        console.log('  ✓ OpenAI API key configured');
      } else if (providerName) {
        console.log(
          `  ⊘ OpenAI API key not configured. Run "keystone auth login openai" to authenticate.`
        );
      }
    }

    if (!providerName || providerName === 'anthropic') {
      if (auth.anthropic_api_key) {
        console.log('  ✓ Anthropic API key configured');
      } else if (providerName) {
        console.log(
          `  ⊘ Anthropic API key not configured. Run "keystone auth login anthropic" to authenticate.`
        );
      }
    }

    if (!auth.github_token && !auth.openai_api_key && !auth.anthropic_api_key && !providerName) {
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

    if (!providerName || providerName === 'github' || providerName === 'copilot') {
      AuthManager.save({
        github_token: undefined,
        copilot_token: undefined,
        copilot_expires_at: undefined,
      });
      console.log('✓ Successfully logged out of GitHub.');
    } else if (providerName === 'openai') {
      AuthManager.save({ openai_api_key: undefined });
      console.log('✓ Successfully cleared OpenAI API key.');
    } else if (providerName === 'anthropic') {
      AuthManager.save({ anthropic_api_key: undefined });
      console.log('✓ Successfully cleared Anthropic API key.');
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
        'graph:Visualize a workflow as a Mermaid.js graph'
        'run:Execute a workflow'
        'resume:Resume a paused or failed workflow run'
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
        resume)
          _arguments \\
            '(-i --input)'{-i,--input}'[Input values]:key=value' \\
            ':run_id:__keystone_runs'
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
  opts="init validate graph run resume workflows history logs prune ui mcp config auth completion"

  case "\${prev}" in
    run|graph)
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
