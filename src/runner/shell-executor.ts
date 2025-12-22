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
// Pre-compiled dangerous patterns for performance
// These patterns are designed to detect likely injection attempts while minimizing false positives
const DANGEROUS_PATTERNS: RegExp[] = [
  /;\s*\w/, // Command chaining with semicolon (e.g., `; rm -rf /`)
  /\|\s*(?:sh|bash|zsh|ksh|dash|csh|python|python[23]?|node|ruby|perl|php|lua)\b/, // Piping to shell/interpreter (download-and-execute pattern)
  /\|\s*(?:sudo|su)\b/, // Piping to privilege escalation
  /&&\s*(?:rm|chmod|chown|mkfs|dd)\b/, // AND chaining with destructive commands
  /\|\|\s*(?:rm|chmod|chown|mkfs|dd)\b/, // OR chaining with destructive commands
  /`[^`]+`/, // Command substitution with backticks
  /\$\([^)]+\)/, // Command substitution with $()
  />\s*\/dev\/null\s*2>&1\s*&/, // Backgrounding with hidden output (often malicious)
  /rm\s+(-rf?|--recursive)\s+[\/~]/, // Dangerous recursive deletion
  />\s*\/etc\//, // Writing to /etc
  /curl\s+.*\|\s*(?:sh|bash)/, // Download and execute pattern
  /wget\s+.*\|\s*(?:sh|bash)/, // Download and execute pattern
  // Additional patterns for more comprehensive detection
  /base64\s+(-d|--decode)\s*\|/, // Base64 decode piped to another command
  /\beval\s+["'\$]/, // eval with variable/string (likely injection)
  /\bexec\s+\d+[<>]/, // exec with file descriptor redirection
  /python[23]?\s+-c\s*["']/, // Python one-liner with quoted code
  /node\s+(-e|--eval)\s*["']/, // Node.js one-liner with quoted code
  /perl\s+-e\s*["']/, // Perl one-liner with quoted code
  /ruby\s+-e\s*["']/, // Ruby one-liner with quoted code
  /\bdd\s+.*\bof=\//, // dd write operation to root paths
  /chmod\s+[0-7]{3,4}\s+\/(?!tmp)/, // chmod on root paths (except /tmp)
  /mkfs\./, // Filesystem formatting commands
  /\$\{[^}]+\}/, // Parameter expansion (can be used for obfuscation)
  /\\x[0-9a-fA-F]{2}/, // Hex escaping attempts
  /\\[0-7]{3}/, // Octal escaping attempts
  /<<<\s*/, // Here-strings (can be used for injection)
  /\d*<&\s*\d*/, // File descriptor duplication
  /\d*>&-\s*/, // Closing file descriptors
];

export function detectShellInjectionRisk(command: string): boolean {
  // Check against pre-compiled patterns
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
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
  if (!step.allowInsecure && detectShellInjectionRisk(command)) {
    throw new Error(
      `Security Error: Command contains shell metacharacters that may indicate injection risk:\n   Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}\n   To execute this command safely, ensure all user inputs are wrapped in \${{ escape(input) }}.\n\n   If you trust this workflow and its inputs, you may need to refactor the step to avoid complex shell chains or use a stricter input validation.\n   Or, if you really trust this command, you can set 'allowInsecure: true' in the step definition.`
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
  const mergedEnv = Object.keys(env).length > 0 ? { ...Bun.env, ...env } : Bun.env;

  // Safe Fast Path: If command contains only safe characters (alphanumeric, -, _, ., /) and spaces,
  // we can split it and execute directly without a shell.
  // This completely eliminates shell injection risks for simple commands.
  const isSimpleCommand = /^[a-zA-Z0-9_\-./]+(?: [a-zA-Z0-9_\-./]+)*$/.test(command);

  // Common shell builtins that must run in a shell
  const splitArgs = command.split(/\s+/);
  const cmd = splitArgs[0];
  const isBuiltin = [
    'exit',
    'cd',
    'export',
    'unset',
    'source',
    '.',
    'alias',
    'unalias',
    'eval',
    'set',
  ].includes(cmd);

  try {
    let stdoutString = '';
    let stderrString = '';
    let exitCode = 0;

    if (isSimpleCommand && !isBuiltin) {
      // split by spaces
      const args = splitArgs.slice(1);
      if (!cmd) throw new Error('Empty command');

      const proc = Bun.spawn([cmd, ...args], {
        cwd,
        env: mergedEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdoutText = await new Response(proc.stdout).text();
      const stderrText = await new Response(proc.stderr).text();

      // Wait for exit
      exitCode = await proc.exited;
      stdoutString = stdoutText;
      stderrString = stderrText;
    } else {
      // Fallback to sh -c for complex commands (pipes, redirects, quotes)
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
      stdoutString = await result.text();
      stderrString = result.stderr ? result.stderr.toString() : '';
      exitCode = result.exitCode;
    }

    return {
      stdout: stdoutString,
      stderr: stderrString,
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
