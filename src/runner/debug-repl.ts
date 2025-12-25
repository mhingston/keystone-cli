import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { type ExpressionContext, ExpressionEvaluator } from '../expression/evaluator.ts';
import type { Step } from '../parser/schema.ts';
import { extractJson } from '../utils/json-parser.ts';

import { ConsoleLogger, type Logger } from '../utils/logger.ts';

export type DebugAction =
  | { type: 'retry'; modifiedStep?: Step }
  | { type: 'skip' }
  | { type: 'continue_failure' }; // Default behavior (exit debug mode, let it fail)

export class DebugRepl {
  constructor(
    private context: ExpressionContext,
    private step: Step,
    private error: unknown,
    private logger: Logger = new ConsoleLogger(),
    private inputStream: NodeJS.ReadableStream = process.stdin,
    private outputStream: NodeJS.WritableStream = process.stdout
  ) {}

  public async start(): Promise<DebugAction> {
    this.logger.error(`\n❌ Step '${this.step.id}' failed.`);
    this.logger.error(
      `   Error: ${this.error instanceof Error ? this.error.message : String(this.error)}`
    );
    this.logger.log('\nEntering Debug Mode. Available commands:');
    this.logger.log('  > context      (view current inputs/outputs involved in this step)');
    this.logger.log('  > retry        (re-run step, optionally with edited definition)');
    this.logger.log('  > edit         (edit the step definition in your $EDITOR)');
    this.logger.log('  > skip         (skip this step and proceed)');
    this.logger.log('  > eval <code>  (run JS expression against context)');
    this.logger.log('  > exit         (resume failure/exit)');

    const rl = readline.createInterface({
      input: this.inputStream,
      output: this.outputStream,
      prompt: 'debug> ',
    });

    rl.prompt();

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (action: DebugAction) => {
        if (resolved) return;
        resolved = true;
        resolve(action);
      };

      rl.on('close', () => {
        resolveOnce({ type: 'continue_failure' });
      });

      rl.on('SIGINT', () => {
        rl.close();
      });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        const [cmd, ...args] = trimmed.split(' ');
        const argStr = args.join(' ');

        switch (cmd) {
          case 'context':
            // Show meaningful context context
            this.logger.log(JSON.stringify(this.context, null, 2));
            break;

          case 'retry':
            resolveOnce({ type: 'retry', modifiedStep: this.step });
            rl.close();
            break;

          case 'skip':
            resolveOnce({ type: 'skip' });
            rl.close();
            break;

          case 'exit':
          case 'quit':
            resolveOnce({ type: 'continue_failure' });
            rl.close();
            break;

          case 'edit': {
            try {
              const newStep = this.editStep(this.step);
              if (newStep) {
                this.step = newStep;
                this.logger.log('✓ Step definition updated in memory. Type "retry" to run it.');
              } else {
                this.logger.log('No changes made.');
              }
            } catch (e) {
              this.logger.error(`Error editing step: ${e}`);
            }
            break;
          }

          case 'eval':
            try {
              if (!argStr) {
                this.logger.log('Usage: eval <expression>');
              } else {
                const result = ExpressionEvaluator.evaluateExpression(argStr, this.context);
                this.logger.log(String(result));
              }
            } catch (e) {
              this.logger.error(`Eval error: ${e instanceof Error ? e.message : String(e)}`);
            }
            break;

          case '':
            break;

          default:
            this.logger.log(`Unknown command: ${cmd}`);
            break;
        }

        if (cmd !== 'retry' && cmd !== 'skip' && cmd !== 'exit' && cmd !== 'quit') {
          rl.prompt();
        }
      });
    });
  }

  private editStep(step: Step): Step | null {
    const editorEnv = process.env.EDITOR || 'vim'; // Default to vim if not set
    // Validate editor name to prevent shell injection (allow alphanumeric, dash, underscore, slash, and spaces for args)
    // We strictly block semicolon, pipe, ampersand, backtick, $ to prevent command injection
    const safeEditor = /^[\w./\s-]+$/.test(editorEnv) ? editorEnv : 'vi';
    if (safeEditor !== editorEnv) {
      this.logger.warn(
        `Warning: $EDITOR value "${editorEnv}" contains unsafe characters. Falling back to "vi".`
      );
    }
    // Sanitize step ID to prevent path traversal
    const sanitizedId = step.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempFile = path.join(os.tmpdir(), `keystone-step-${sanitizedId}-${Date.now()}.json`);

    // Write step to temp file
    fs.writeFileSync(tempFile, JSON.stringify(step, null, 2));

    // Spawn editor
    try {
      // Parse editor string into command and args (e.g. "code --wait", "subl -w")
      const [editorCmd, ...editorArgs] = parseShellCommand(safeEditor);

      // Use stdio: 'inherit' to let the editor take over the terminal
      // Note: shell: false for security - prevents injection via $EDITOR
      const result = spawnSync(editorCmd, [...editorArgs, tempFile], {
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      // Read back
      const content = fs.readFileSync(tempFile, 'utf-8');

      // Parse JSON
      // We use our safe extractor helper or just JSON.parse
      try {
        const newStep = JSON.parse(content);
        // Basic validation: must have id and type
        if (!newStep.id || !newStep.type) {
          this.logger.error('Invalid step definition: missing id or type');
          return null;
        }
        return newStep as Step;
      } catch (e) {
        this.logger.error('Failed to parse JSON from editor. Changes discarded.');
        return null;
      }
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }
}

/**
 * Parses a shell command string into arguments, respecting quotes.
 * Handles single quotes and double quotes.
 * Example: 'code --wait' -> ['code', '--wait']
 * Example: 'my-editor "some arg"' -> ['my-editor', 'some arg']
 */
export function parseShellCommand(command: string): string[] {
  const args: string[] = [];
  let currentArg = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else {
        currentArg += char;
      }
    } else if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        currentArg += char;
      }
    } else {
      if (char === '"') {
        inDoubleQuote = true;
      } else if (char === "'") {
        inSingleQuote = true;
      } else if (char === ' ') {
        if (currentArg.length > 0) {
          args.push(currentArg);
          currentArg = '';
        }
      } else {
        currentArg += char;
      }
    }
  }

  if (currentArg.length > 0) {
    args.push(currentArg);
  }

  return args;
}
