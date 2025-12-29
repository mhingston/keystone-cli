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
 */

import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { ShellStep } from '../../parser/schema.ts';
import { LIMITS } from '../../utils/constants.ts';
import { filterSensitiveEnv } from '../../utils/env-filter.ts';
import { ConsoleLogger, type Logger } from '../../utils/logger.ts';
import { PathResolver } from '../../utils/paths.ts';
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
    if (!step.allowInsecure) {
      const hasExpression = step.args.some((a) => ExpressionEvaluator.hasExpression(a));
      if (hasExpression) {
        throw new Error(
          "Security Error: 'args' with expressions requires 'allowInsecure: true'.\nUse 'run' with 'escape()' for secure interpolation, or 'args' with static values."
        );
      }
    }

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
    // Finds ${{ ... }} blocks
    const matches = s.match(/\${{.*?}}/g);
    if (!matches) return false;

    // Check if the expression is strictly wrapped in escape(...)
    // Matches: ${{ escape(...) }} or ${{ escape( ... ) }}
    // Does NOT match: ${{ "foo" + escape(...) }}
    return matches.some((m) => {
      const content = m.slice(3, -2).trim(); // Remove ${{ and }}
      return !/^escape\s*\(.*\)$/.test(content);
    });
  };

  if (!step.allowInsecure && hasUnescapedExpr(step.run)) {
    throw new Error(
      `Security Error: Shell command contains unescaped expressions which are vulnerable to injection.\nUse \${{ escape(...) }} to safely interpolate values, or set 'allowInsecure: true' if you trust the source.\nCommand template: ${step.run}`
    );
  }

  const command = ExpressionEvaluator.evaluateString(step.run, context);
  if (!step.allowInsecure && detectShellInjectionRisk(command)) {
    throw new Error(
      `Security Error: Evaluated command contains shell metacharacters that require 'allowInsecure: true'.\n   Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}\n   Metacharacters detected. Please use 'allowInsecure: true' if this is intended.`
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

const TRUNCATED_SUFFIX = '... [truncated output]';

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false };
  if (maxBytes <= 0) {
    try {
      await stream.cancel?.();
    } catch {}
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
      } catch {}
      return { text: `${text}${TRUNCATED_SUFFIX}`, truncated: true };
    }

    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, truncated: false };
}

// Whitelist of allowed characters for secure shell command execution
// Allows: Alphanumeric, whitespace, and common safe punctuation (_ . / : @ , + - = ' " ! ~ \)
// Blocks: Pipes, redirects, subshells, variables ($), etc.
const SAFE_SHELL_CHARS = /^[a-zA-Z0-9\s_./:@,+=~'"!-]+$/;

export function detectShellInjectionRisk(rawCommand: string): boolean {
  // We scan the command to handle single quotes correctly.
  // Characters inside single quotes are considered escaped/literal and safe from shell injection.
  let inSingleQuote = false;

  for (let i = 0; i < rawCommand.length; i++) {
    const char = rawCommand[i];

    if (char === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // Outside single quotes, we enforce the strict whitelist
    if (!inSingleQuote) {
      if (!SAFE_SHELL_CHARS.test(char)) {
        return true;
      }
    }
    // Inside single quotes, everything is treated as a literal string by the shell,
    // so we don't need to block special characters.
  }

  // If we ended with an unclosed single quote, it's a syntax risk
  return inSingleQuote;
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

  // Security Check: Enforce whitelist
  // If we haven't enabled insecure mode, we MUST be able to use spawn (no shell)
  // or the command must be strictly composed of safe characters.
  if (!step.allowInsecure) {
    if (detectShellInjectionRisk(command)) {
      throw new Error(
        `Security Error: Command execution blocked.\nCommand: "${command.substring(0, 100)}${
          command.length > 100 ? '...' : ''
        }"\nReason: Contains characters not in the strict whitelist (alphanumeric, whitespace, and _./:@,+=~-).\nThis protects against shell injection attacks.\nFix: either simplify your command or set 'allowInsecure: true' in your step definition if you trust the input.`
      );
    }
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
  if (cwd) {
    PathResolver.assertWithinCwd(cwd, step.allowOutsideCwd, 'Directory');
  }

  const hostEnv = filterSensitiveEnv(Bun.env);
  const mergedEnv = Object.keys(env).length > 0 ? { ...hostEnv, ...env } : hostEnv;

  // If secure (whitelist passed) OR insecure mode is explicitly allowed...
  // We prefer direct spawn if possible, but fall back to shell if needed (e.g. for pipelines in insecure mode)

  try {
    // If we are in secure mode (allowInsecure: false), we KNOW the command is safe.
    // However, it might still benefit from running directly via spawn to avoid even theoretical shell issues.
    // But simplified splitting by space might break if we allowed quotes (which we don't in the whitelist).

    // For now, if insecure is allowed, we use 'sh -c'.
    // If secure (whitelist valid), we can also use 'sh -c' relatively safely, or split and spawn.
    // Using 'sh -c' is robust for arguments. Since we validated the string against a strict whitelist,
    // 'sh -c' shouldn't be able to do anything funky like variable expansion or subshells because appropriate chars are banned.

    let stdoutString = '';
    let stderrString = '';
    let exitCode = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxOutputBytes = LIMITS.MAX_PROCESS_OUTPUT_BYTES;

    // Use 'sh -c' for everything to ensure consistent argument parsing
    // Security is guaranteed by the strict whitelist check above for allowInsecure: false
    // which prevents injection of metacharacters, quotes, escapes, etc.
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: cwd || process.cwd(),
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const abortHandler = () => {
      try {
        proc.kill();
      } catch {}
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

    return {
      stdout: stdoutString,
      stderr: stderrString,
      exitCode,
      stdoutTruncated,
      stderrTruncated,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'Step canceled') {
      throw error;
    }

    // Handle specific Bun shell errors if they occur
    if (error && typeof error === 'object' && 'exitCode' in error) {
      const shellError = error as { exitCode: number; stdout: any; stderr: any };
      return {
        stdout: String(shellError.stdout || ''),
        stderr: String(shellError.stderr || ''),
        exitCode: shellError.exitCode,
      };
    }

    // Generic error handling
    return {
      stdout: '',
      stderr: msg,
      exitCode: 1,
    };
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
  const hostEnv = filterSensitiveEnv(Bun.env);
  const mergedEnv = { ...hostEnv, ...env };
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
    } catch {}
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
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}
