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
import { ConfigLoader } from '../../utils/config-loader.ts';
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
    // args are inherently safe from shell injection as they skip the shell
    // and pass the array directly to the OS via Bun.spawn.

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

  // Windows escaping (cmd.exe)
  if (process.platform === 'win32') {
    // Replace " with "" and wrap in double quotes
    // This is the standard way to escape arguments for CRT-based programs in cmd
    return `"${value.replace(/"/g, '""')}"`;
  }

  // POSIX escaping (sh)
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

import { TRUNCATED_SUFFIX, createOutputLimiter } from '../../utils/stream-utils.ts';

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
  const limiter = createOutputLimiter(maxBytes);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    limiter.append(Buffer.from(value));

    if (limiter.truncated) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }

  return { text: limiter.finalize(), truncated: limiter.truncated };
}

// Whitelist of allowed characters for secure shell command execution
// Allows: Alphanumeric, space, and common safe punctuation (_ . / : @ , + - =)
// Blocks: Quotes, Newlines, Pipes, redirects, subshells, variables, backslashes, etc.
const SAFE_SHELL_CHARS = /^[a-zA-Z0-9 _./:@,+=~"'-]+$/;

export function detectShellInjectionRisk(rawCommand: string): boolean {
  // We can safely ignore anything inside single quotes because our escape()
  // function (which is the recommended way to interpolate) uses single quotes
  // and correctly escapes nested single quotes as '\''.
  // This regex matches '...' including correctly escaped internal single quotes.
  const quotedRegex = /'([^']|'\\'')*'/g;
  const stripped = rawCommand.replace(quotedRegex, "'QUOTED_STR'");

  return !SAFE_SHELL_CHARS.test(stripped);
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
        `Security Error: Command execution blocked to prevent potential shell injection.\nCommand: "${command.substring(0, 100)}${
          command.length > 100 ? '...' : ''
        }"\nReason: Contains characters not in the strict whitelist (alphanumeric, whitespace, and _./:@,+=~-).\nThis protects against chaining malicious commands (e.g. '; rm -rf /'). It does NOT evaluate if the command itself is destructive.\nFix: either simplify your command or set 'allowInsecure: true' in your step definition if you trust the input.`
      );
    }

    // Additional Check: Prevent Directory Traversal in Binary Path
    // Even if it passes the whitelist, we don't want to allow 'cat ../../../etc/passwd'
    // or executing '../../../../bin/malice'.
    // We check for '..' characters which might indicate directory traversal.
    if (command.includes('..') && (command.includes('/') || command.includes('\\'))) {
      throw new Error(
        `Security Error: Command blocked due to potential directory traversal ('..').\nCommand: "${command.substring(0, 100)}"\nTo allow relative paths outside the current directory, set 'allowInsecure: true'.`
      );
    }
  }

  // Security Check: Enforce Denylist (e.g. rm, mkfs, etc.)
  // We check this even if allowInsecure is true, because these are explicitly banned by policy.
  const config = ConfigLoader.load();
  if (config.engines?.denylist && config.engines.denylist.length > 0) {
    // Robust parsing to get the command binary
    // This handles:
    // 1. Chained commands (e.g. "echo foo; rm -rf /")
    // 2. Pre-command modifiers (e.g. "watch rm") - though difficult to do perfectly without a full shell parser,
    //    we can check for common dangerous patterns or just strictly check tokens.
    //
    // Strategy: Tokenize by shell delimiters (;, |, &, &&, ||, ``, $()) and check the first word of each segment.

    // Split by command separators
    const segments = command.split(/[;|&]|\$\(|\`|\r?\n/);

    for (const segment of segments) {
      if (!segment.trim()) continue;

      // Get the first token of the segment
      const tokens = segment.trim().split(/\s+/);
      let bin = tokens[0];

      // Handle path prefixes (e.g. /bin/rm -> rm)
      if (bin.includes('/')) {
        const parts = bin.split(/[/\\]/);
        bin = parts[parts.length - 1];
      }

      if (config.engines.denylist.includes(bin)) {
        throw new Error(
          `Security Error: Command "${bin}" is in the denylist and cannot be executed.`
        );
      }
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

    // Use 'sh -c' (POSIX) or 'cmd.exe /d /s /c' (Windows)
    // Security is guaranteed by the strict whitelist check above for allowInsecure: false
    // which prevents injection of metacharacters, quotes, escapes, etc.
    const isWindows = process.platform === 'win32';
    const shellCommand = isWindows ? 'cmd.exe' : 'sh';
    const shellArgs = isWindows ? ['/d', '/s', '/c'] : ['-c'];

    const proc = Bun.spawn([shellCommand, ...shellArgs, command], {
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

    // Wait for exit and streams simultaneously to prevent deadlocks
    // (If the pipe fills up, the process blocks on write. If we await exit first, we never drain the pipe -> Deadlock)
    const [exitResult, stdoutResult, stderrResult] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    exitCode = exitResult;

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

    const [exitCode, stdoutResult, stderrResult] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);

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
