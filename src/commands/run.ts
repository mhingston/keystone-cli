/**
 * keystone run command
 * Execute a workflow
 */

import { dirname } from 'node:path';
import type { Command } from 'commander';
import { WorkflowDb } from '../db/workflow-db.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { ConsoleLogger, SilentLogger } from '../utils/logger.ts';
import { WorkflowRegistry } from '../utils/workflow-registry.ts';
import { parseInputs } from './utils.ts';

export function registerRunCommand(program: Command): void {
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
      // Security Warning
      if (!options.events) {
        console.warn(
          '\x1b[33m%s\x1b[0m',
          '⚠️  SECURITY WARNING: This tool executes code from the current directory.'
        );
        console.warn(
          '\x1b[33m%s\x1b[0m',
          '   - Local provider scripts in ./providers/ are loaded and executed.'
        );
        console.warn(
          '\x1b[33m%s\x1b[0m',
          '   - Ensure you trust the code in this directory before running.'
        );
        console.warn('');
      }

      const inputs = parseInputs(options.input);
      let resolvedPath: string | undefined;

      // Load and validate workflow
      try {
        resolvedPath = WorkflowRegistry.resolvePath(workflowPathArg);
        const workflow = WorkflowParser.loadWorkflow(resolvedPath);

        // Import WorkflowRunner dynamically
        const { WorkflowRunner } = await import('../runner/workflow-runner.ts');
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
            const { renderError } = await import('../utils/error-renderer.ts');
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
}
