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

import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { ShellStep } from '../../parser/schema.ts';
import { LIMITS } from '../../utils/constants.ts';
import { ConsoleLogger, type Logger } from '../../utils/logger.ts';
import type { StepResult } from './types.ts';

/**
 * Execute a shell step
 */
export async function executeShellStep(
  step: ShellStep,
  context: ExpressionContext,
  logger: Logger,
  dryRun?: boolean,
  abortSignal?: AbortSignal
): Promise<StepResult> {
  if (step.args) {
    const command = step.args.map((a) => ExpressionEvaluator.evaluateString(a, context)).join(' ');
    if (dryRun) {
      logger.log(`[DRY RUN] Would execute: ${command}`);
      return {
        output: { stdout: '[DRY RUN] Success', stderr: '', exitCode: 0 },
        status: 'success',
      };
    }

    const result = await executeShellArgs(step.args, context, logger, abortSignal, step.dir);
    return formatShellResult(result, logger);
  }

  if (!step.run) {
    throw new Error('Shell step must have either "run" or "args"');
  }

  // Strict Mode Check: Detect unescaped expressions in the raw template
  // We check if there are any ${{ }} blocks that don't start with escape(
  const hasUnescapedExpr = (s: string) => {
    const matches = s.match(/\${{.*?}}/g);
    if (!matches) return false;
    return matches.some((m) => !/\${{\s*escape\s*\(/.test(m));
  };

  if (!step.allowInsecure && hasUnescapedExpr(step.run)) {
    throw new Error(
      `Security Error: Shell command contains unescaped expressions which are vulnerable to injection.\n` +
      `Use \${{ escape(...) }} to safely interpolate values, or set 'allowInsecure: true' if you trust the source.\n` +
      `Command template: ${step.run}`
    );
  }

  const command = ExpressionEvaluator.evaluateString(step.run, context);
  const isRisky = detectShellInjectionRisk(command);

  if (isRisky && !step.allowInsecure) {
    throw new Error(
      `Security Error: Evaluated command contains shell metacharacters that may indicate injection risk.\n` +
      `   Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}\n` +
      `   To execute this command, use \${{ escape(...) }} for inputs or set 'allowInsecure: true'.`
    );
  }

  const result = await executeShell(step, context, logger, abortSignal, command);
  return formatShellResult(result, logger);
}

/**
 * Format the internal ShellResult into a StepResult
 */
function formatShellResult(result: ShellResult, logger: Logger): StepResult {
  if (result.stdout) {
    logger.log(result.stdout.trim());
  }

  if (result.exitCode !== 0) {
    return {
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      },
      status: 'failed',
      error: `Shell command exited with code ${result.exitCode}: ${result.stderr}`,
    };
  }

  return {
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
    status: 'success',
  };
}

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
export function escapeShellArg(arg: unknown): string {
  const value = arg === null || arg === undefined ? '' : String(arg);
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

/**
 * Check if a command contains potentially dangerous shell metacharacters
 * Returns true if the command looks like it might contain unescaped user input
 */
// Pre-compiled dangerous patterns for performance
// These patterns are designed to detect likely injection attempts while minimizing false positives
const DANGEROUS_PATTERN_SOURCES: string[] = [
  ';\\s*(?:rm|chmod|chown|mkfs|dd)\\b', // Command chaining with destructive commands
  '\\|\\s*(?:sh|bash|zsh|ksh|dash|csh|python|python[23]?|node|ruby|perl|php|lua)\\b', // Piping to shell/interpreter (download-and-execute pattern)
  '\\|\\s*(?:sudo|su)\\b', // Piping to privilege escalation
  '&&\\s*(?:rm|chmod|chown|mkfs|dd)\\b', // AND chaining with destructive commands
  '\\|\\|\\s*(?:rm|chmod|chown|mkfs|dd)\\b', // OR chaining with destructive commands
  '`[^`]+`', // Command substitution with backticks
  '\\$\\([^)]+\\)', // Command substitution with $()
  '>\\s*/dev/null\\s*2>&1\\s*&', // Backgrounding with hidden output (often malicious)
  'rm\\s+(-rf?|--recursive)\\s+[/~]', // Dangerous recursive deletion
  '>\\s*/etc/', // Writing to /etc
  'curl\\s+.*\\|\\s*(?:sh|bash)', // Download and execute pattern
  'wget\\s+.*\\|\\s*(?:sh|bash)', // Download and execute pattern
  // Additional patterns for more comprehensive detection
  'base64\\s+(-d|--decode)\\s*\\|', // Base64 decode piped to another command
  '\\beval\\s+["\'\\$]', // eval with variable/string (likely injection)
  '\\bexec\\s+\\d+[<>]', // exec with file descriptor redirection
  'python[23]?\\s+-c\\s*["\']', // Python one-liner with quoted code
  'node\\s+(-e|--eval)\\s*["\']', // Node.js one-liner with quoted code
  'perl\\s+-e\\s*["\']', // Perl one-liner with quoted code
  'ruby\\s+-e\\s*["\']', // Ruby one-liner with quoted code
  '\\bdd\\s+.*\\bof=/', // dd write operation to root paths
  'chmod\\s+[0-7]{3,4}\\s+/(?!tmp)', // chmod on root paths (except /tmp)
  'mkfs\\.', // Filesystem formatting commands
  // Targeted parameter expansion patterns (not all ${} usage)
  '\\$\\{IFS[}:]', // IFS manipulation (common injection technique)
  '\\$\\{[^}]*\\$\\([^}]*\\}', // Command substitution inside parameter expansion
  '\\$\\{[^}]*:-[^}]*\\$\\(', // Default value with command substitution
  '\\$\\{[^}]*[`][^}]*\\}', // Backtick inside parameter expansion
  '\\\\x[0-9a-fA-F]{2}', // Hex escaping attempts
  '\\\\[0-7]{3}', // Octal escaping attempts
  '<<<\\s*', // Here-strings (can be used for injection)
  '\\d*<&\\s*\\d*', // File descriptor duplication
  '\\d*>&-\\s*', // Closing file descriptors
];

// Combined pattern source for both native and RE2
const COMBINED_PATTERN_SOURCE = DANGEROUS_PATTERN_SOURCES.join('|');

// Maximum command length to check for injection (prevents DoS on very long commands)
const MAX_COMMAND_CHECK_LENGTH = 10_000;

// RE2 instance (lazy-loaded)
let re2Pattern: { test: (s: string) => boolean } | null = null;
let re2LoadAttempted = false;
let usingRe2 = false;

/**
 * Get the pattern for shell injection detection.
 * Uses RE2 if available for ReDoS safety, falls back to native regex.
 */
function getDetectionPattern(): { test: (s: string) => boolean } {
  if (!re2LoadAttempted) {
    re2LoadAttempted = true;
    try {
      // Try to dynamically require RE2 (optional dependency)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RE2 = require('re2');
      re2Pattern = new RE2(COMBINED_PATTERN_SOURCE);
      usingRe2 = true;
    } catch {
      // RE2 not available, use native regex
      re2Pattern = new RegExp(COMBINED_PATTERN_SOURCE);
      usingRe2 = false;
    }
  }
  return re2Pattern!;
}

/**
 * Check if the module is using RE2 (for testing purposes)
 */
export function isUsingRe2(): boolean {
  getDetectionPattern(); // Ensure pattern is loaded
  return usingRe2;
}

/**
 * Reset the RE2 loading state (for testing purposes)
 */
export function resetRe2State(): void {
  re2Pattern = null;
  re2LoadAttempted = false;
  usingRe2 = false;
}

// Note: Pattern is lazily created in getDetectionPattern() to avoid
// creating a duplicate RegExp when RE2 is successfully loaded

const TRUNCATED_SUFFIX = '... [truncated output]';

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false };
  if (maxBytes <= 0) {
    try {
      await stream.cancel?.();
    } catch { }
    return { text: TRUNCATED_SUFFIX, truncated: true };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (bytesRead + value.byteLength > maxBytes) {
      const allowed = maxBytes - bytesRead;
      if (allowed > 0) {
        text += decoder.decode(value.slice(0, allowed), { stream: true });
      }
      text += decoder.decode();
      try {
        await reader.cancel();
      } catch { }
      return { text: `${text}${TRUNCATED_SUFFIX}`, truncated: true };
    }

    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, truncated: false };
}

export function detectShellInjectionRisk(command: string): boolean {
  // Limit command length to prevent DoS via very long strings
  if (command.length > MAX_COMMAND_CHECK_LENGTH) {
    // Truncate for pattern matching, but this is conservative - long commands are suspicious
    command = command.substring(0, MAX_COMMAND_CHECK_LENGTH);
  }

  // Use RE2 if available for ReDoS safety, otherwise fall back to native regex
  const pattern = getDetectionPattern();
  return pattern.test(command);
}

/**
 * Execute a shell command using Bun.spawn
 */
export async function executeShell(
  step: ShellStep,
  context: ExpressionContext,
  logger: Logger = new ConsoleLogger(),
  abortSignal?: AbortSignal,
  commandOverride?: string
): Promise<ShellResult> {
  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }
  // Evaluate the command string
  const command = commandOverride ?? ExpressionEvaluator.evaluateString(step.run, context);

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

  // Shell metacharacters that require a real shell (including newlines, globs, env vars)
  // Added: * ? [ ] = (for env vars)
  // Note: '=' is common in args (--foo=bar), so strict check might be needed,
  // but to support `VAR=val cmd`, we should detect it.
  // Actually, standard `sh -c` is safer if we see *any* of these.
  const hasShellMetas = /[|&;<>`$!\n*?=\[\]]/.test(command);

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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxOutputBytes = LIMITS.MAX_PROCESS_OUTPUT_BYTES;

    if (canUseSpawn) {
      // Split command into args without invoking a shell (handles quotes and escapes)
      const args: string[] = [];
      let current = '';
      let inQuote = false;
      let quoteChar = '';
      let escapeNext = false;
      let tokenStarted = false;

      for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (escapeNext) {
          current += char;
          tokenStarted = true;
          escapeNext = false;
          continue;
        }

        if (char === '\\' && quoteChar !== "'") {
          escapeNext = true;
          tokenStarted = true;
          continue;
        }

        if (char === "'" || char === '"') {
          if (inQuote && char === quoteChar) {
            inQuote = false;
            quoteChar = '';
          } else if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else {
            current += char;
            tokenStarted = true;
          }
          tokenStarted = true;
          continue;
        }

        if (/\s/.test(char) && !inQuote) {
          if (tokenStarted) {
            args.push(current);
            current = '';
            tokenStarted = false;
          }
          continue;
        }

        current += char;
        tokenStarted = true;
      }
      if (escapeNext) {
        current += '\\';
        tokenStarted = true;
      }
      if (tokenStarted) args.push(current);

      if (args.length === 0) throw new Error('Empty command');

      const proc = Bun.spawn(args, {
        cwd,
        env: mergedEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const abortHandler = () => {
        try {
          proc.kill();
        } catch { }
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const stdoutPromise = readStreamWithLimit(proc.stdout, maxOutputBytes);
      const stderrPromise = readStreamWithLimit(proc.stderr, maxOutputBytes);

      // Wait for exit
      exitCode = await proc.exited;
      const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
      stdoutString = stdoutResult.text;
      stderrString = stderrResult.text;
      stdoutTruncated = stdoutResult.truncated;
      stderrTruncated = stderrResult.truncated;
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    } else {
      // Fallback to sh -c for complex commands (pipes, redirects, quotes)
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd,
        env: mergedEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const abortHandler = () => {
        try {
          proc.kill();
        } catch { }
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const stdoutPromise = readStreamWithLimit(proc.stdout, maxOutputBytes);
      const stderrPromise = readStreamWithLimit(proc.stderr, maxOutputBytes);

      exitCode = await proc.exited;
      const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
      stdoutString = stdoutResult.text;
      stderrString = stderrResult.text;
      stdoutTruncated = stdoutResult.truncated;
      stderrTruncated = stderrResult.truncated;
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    }

    return {
      stdout: stdoutString,
      stderr: stderrString,
      exitCode,
      stdoutTruncated,
      stderrTruncated,
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

/**
 * Execute a command directly without a shell using an argument array
 */
export async function executeShellArgs(
  argsTemplates: string[],
  context: ExpressionContext,
  logger: Logger = new ConsoleLogger(),
  abortSignal?: AbortSignal,
  dir?: string
): Promise<ShellResult> {
  const args = argsTemplates.map((t) => ExpressionEvaluator.evaluateString(t, context));
  const cwd = dir ? ExpressionEvaluator.evaluateString(dir, context) : undefined;
  const env: Record<string, string> = context.env ? { ...context.env } : {};
  const mergedEnv = { ...Bun.env, ...env };
  const maxOutputBytes = LIMITS.MAX_PROCESS_OUTPUT_BYTES;

  const proc = Bun.spawn(args, {
    cwd,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const abortHandler = () => {
    try {
      proc.kill();
    } catch { }
  };

  if (abortSignal) {
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const stdoutPromise = readStreamWithLimit(proc.stdout, maxOutputBytes);
    const stderrPromise = readStreamWithLimit(proc.stderr, maxOutputBytes);

    const exitCode = await proc.exited;
    const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);

    if (abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }

    return {
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      exitCode,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
    };
  } catch (error) {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
    throw error;
  }
}
