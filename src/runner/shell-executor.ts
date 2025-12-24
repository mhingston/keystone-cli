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
import { ConsoleLogger, type Logger } from '../utils/logger.ts';

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
 *     run: echo ${{ escape(inputs.message) }}  # Safe: explicitly escaped
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
  /;\s*(?:rm|chmod|chown|mkfs|dd)\b/, // Command chaining with destructive commands
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
  // Targeted parameter expansion patterns (not all ${} usage)
  /\$\{IFS[}:]/, // IFS manipulation (common injection technique)
  /\$\{[^}]*\$\([^}]*\}/, // Command substitution inside parameter expansion
  /\$\{[^}]*:-[^}]*\$\(/, // Default value with command substitution
  /\$\{[^}]*[`][^}]*\}/, // Backtick inside parameter expansion
  /\\x[0-9a-fA-F]{2}/, // Hex escaping attempts
  /\\[0-7]{3}/, // Octal escaping attempts
  /<<<\s*/, // Here-strings (can be used for injection)
  /\d*<&\s*\d*/, // File descriptor duplication
  /\d*>&-\s*/, // Closing file descriptors
];

// Combine all patterns into single regex for O(m) matching instead of O(n×m)
const COMBINED_DANGEROUS_PATTERN = new RegExp(DANGEROUS_PATTERNS.map((r) => r.source).join('|'));

export function detectShellInjectionRisk(command: string): boolean {
  // Use combined pattern for single-pass matching
  return COMBINED_DANGEROUS_PATTERN.test(command);
}

/**
 * Execute a shell command using Bun.$
 */
export async function executeShell(
  step: ShellStep,
  context: ExpressionContext,
  logger: Logger = new ConsoleLogger()
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
  const env: Record<string, string> = context.env ? { ...context.env } : {};
  if (step.env) {
    for (const [key, value] of Object.entries(step.env)) {
      env[key] = ExpressionEvaluator.evaluateString(value, context);
    }
  }

  // Set working directory if specified
  const cwd = step.dir ? ExpressionEvaluator.evaluateString(step.dir, context) : undefined;
  const mergedEnv = Object.keys(env).length > 0 ? { ...Bun.env, ...env } : Bun.env;

  // Shell metacharacters that require a real shell
  const hasShellMetas = /[|&;<>`$!]/.test(command);

  // Common shell builtins that must run in a shell
  const firstWord = command.trim().split(/\s+/)[0];
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
    'true',
    'false',
  ].includes(firstWord);

  const canUseSpawn = !hasShellMetas && !isBuiltin;

  try {
    let stdoutString = '';
    let stderrString = '';
    let exitCode = 0;

    if (canUseSpawn) {
      // Robust splitting that handles single and double quotes
      const args: string[] = [];
      let current = '';
      let inQuote = false;
      let quoteChar = '';

      for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if ((char === "'" || char === '"') && (i === 0 || command[i - 1] !== '\\')) {
          if (inQuote && char === quoteChar) {
            inQuote = false;
            quoteChar = '';
          } else if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else {
            current += char;
          }
        } else if (/\s/.test(char) && !inQuote) {
          if (current) {
            args.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }
      if (current) args.push(current);

      if (args.length === 0) throw new Error('Empty command');

      const proc = Bun.spawn(args, {
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
