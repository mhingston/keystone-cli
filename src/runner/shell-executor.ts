/**
 * Shell command executor
 *
 * ⚠️ SECURITY WARNING:
 * This executor runs shell commands using `sh -c`, which means:
 * - User inputs interpolated into commands can lead to command injection
 * - Malicious inputs like `foo; rm -rf /` will execute multiple commands
 *
 * IMPORTANT: Only run workflows from trusted sources.
 * Commands are executed with the same privileges as the Keystone process.
 * Expression evaluation happens before shell execution, so expressions
 * like ${{ inputs.filename }} are evaluated first, then passed to the shell.
 *
 * ✅ RECOMMENDED PRACTICE:
 * Use the escape() function to safely interpolate user inputs:
 *
 * steps:
 *   - id: safe_echo
 *     type: shell
 *     run: echo ${{ escape(inputs.user_message) }}
 *
 * The escape() function wraps arguments in single quotes and escapes any
 * single quotes within, preventing command injection attacks.
 *
 * See SECURITY.md for more details.
 */

import { $ } from 'bun';
import type { ExpressionContext } from '../expression/evaluator.ts';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import type { ShellStep } from '../parser/schema.ts';
import type { Logger } from './workflow-runner.ts';

/**
 * Escape a shell argument for safe use in shell commands
 * Wraps the argument in single quotes and escapes any single quotes within
 *
 * Example usage in workflows:
 * ```yaml
 * steps:
 *   - id: safe_echo
 *     type: shell
 *     # Use this pattern to safely interpolate user inputs:
 *     run: echo ${{ inputs.message }}  # Safe: expression evaluation happens first
 *     # Avoid patterns like: sh -c "echo $USER_INPUT" where USER_INPUT is raw
 * ```
 */
export function escapeShellArg(arg: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Check if a command contains potentially dangerous shell metacharacters
 * Returns true if the command looks like it might contain unescaped user input
 */
function detectShellInjectionRisk(command: string): boolean {
  // Common shell metacharacters that indicate potential injection
  const dangerousPatterns = [
    /;[\s]*\w/, // Command chaining with semicolon
    /\|[\s]*\w/, // Piping (legitimate uses exist, but worth warning)
    /&&[\s]*\w/, // AND chaining
    /\|\|[\s]*\w/, // OR chaining
    /`[^`]+`/, // Command substitution with backticks
    /\$\([^)]+\)/, // Command substitution with $()
    />\s*\/dev\/null/, // Output redirection (common in attacks)
    /rm\s+-rf/, // Dangerous deletion command
    />\s*[~\/]/, // File redirection to suspicious paths
    /curl\s+.*\|\s*sh/, // Download and execute pattern
    /wget\s+.*\|\s*sh/, // Download and execute pattern
  ];

  return dangerousPatterns.some((pattern) => pattern.test(command));
}

/**
 * Execute a shell command using Bun.$
 */
export async function executeShell(
  step: ShellStep,
  context: ExpressionContext,
  logger: Logger = console
): Promise<ShellResult> {
  // Evaluate the command string
  const command = ExpressionEvaluator.evaluateString(step.run, context);

  // Check for potential shell injection risks
  if (detectShellInjectionRisk(command)) {
    logger.warn(
      `\n⚠️  WARNING: Command contains shell metacharacters that may indicate injection risk:\n   Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}\n   To safely interpolate user inputs, use the escape() function.\n   Example: run: echo \${{ escape(inputs.user_input) }}\n`
    );
  }

  // Evaluate environment variables
  const env: Record<string, string> = {};
  if (step.env) {
    for (const [key, value] of Object.entries(step.env)) {
      env[key] = ExpressionEvaluator.evaluateString(value, context);
    }
  }

  // Set working directory if specified
  const cwd = step.dir ? ExpressionEvaluator.evaluateString(step.dir, context) : undefined;

  try {
    // Execute command using sh -c to allow shell parsing
    let proc = $`sh -c ${command}`.quiet();

    // Apply environment variables - merge with Bun.env to preserve system PATH and other variables
    if (Object.keys(env).length > 0) {
      proc = proc.env({ ...Bun.env, ...env });
    }

    // Apply working directory
    if (cwd) {
      proc = proc.cwd(cwd);
    }

    // Execute and capture result
    const result = await proc;

    const stdout = await result.text();
    const stderr = result.stderr ? result.stderr.toString() : '';
    const exitCode = result.exitCode;

    return {
      stdout,
      stderr,
      exitCode,
    };
  } catch (error) {
    // Handle shell execution errors (Bun throws ShellError with exitCode, stdout, stderr)
    if (error && typeof error === 'object' && 'exitCode' in error) {
      const shellError = error as {
        exitCode: number;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };

      // Convert stdout/stderr to strings if they're buffers
      const stdout = shellError.stdout
        ? Buffer.isBuffer(shellError.stdout)
          ? shellError.stdout.toString()
          : String(shellError.stdout)
        : '';
      const stderr = shellError.stderr
        ? Buffer.isBuffer(shellError.stderr)
          ? shellError.stderr.toString()
          : String(shellError.stderr)
        : '';

      return {
        stdout,
        stderr,
        exitCode: shellError.exitCode,
      };
    }
    throw error;
  }
}
