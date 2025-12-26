import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { ExpressionContext } from '../expression/evaluator';
import { ExpressionEvaluator } from '../expression/evaluator';
import type { EngineStep } from '../parser/schema';
import { ConfigLoader } from '../utils/config-loader';
import { LIMITS } from '../utils/constants';
import { extractJson } from '../utils/json-parser';
import { ConsoleLogger, type Logger } from '../utils/logger';

/**
 * Simple LRU cache with maximum size to prevent memory leaks.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete existing to update order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }
}

const VERSION_CACHE = new LRUCache<string, string>(LIMITS.VERSION_CACHE_MAX_SIZE);
const TRUNCATED_SUFFIX = '... [truncated output]';

function createOutputLimiter(maxBytes: number) {
  let bytes = 0;
  let text = '';
  let truncated = false;

  const append = (chunk: Buffer | string) => {
    if (truncated || maxBytes <= 0) {
      truncated = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (buffer.length <= remaining) {
      text += buffer.toString();
      bytes += buffer.length;
      return;
    }
    text += buffer.subarray(0, remaining).toString();
    bytes = maxBytes;
    truncated = true;
  };

  const finalize = () => (truncated ? `${text}${TRUNCATED_SUFFIX}` : text);

  return {
    append,
    finalize,
    get truncated() {
      return truncated;
    },
  };
}

export interface EngineExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  summary: unknown | null;
  summarySource?: 'file' | 'stdout';
  summaryFormat?: 'json' | 'yaml';
  artifactPath?: string;
  summaryError?: string;
}

export interface EngineExecutorOptions {
  logger?: Logger;
  abortSignal?: AbortSignal;
  runId?: string;
  stepExecutionId?: string;
  artifactRoot?: string;
  redactForStorage?: (value: unknown) => unknown;
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
  }
  return value === pattern;
}

function isDenied(command: string, denylist: string[]): boolean {
  const base = path.basename(command);
  return denylist.some(
    (pattern) => matchesPattern(command, pattern) || matchesPattern(base, pattern)
  );
}

function resolveAllowlistEntry(
  command: string,
  allowlist: Record<
    string,
    { command: string; args?: string[]; version: string; versionArgs?: string[] }
  >
) {
  const base = path.basename(command);
  for (const [name, entry] of Object.entries(allowlist)) {
    if (entry.command === command || entry.command === base || name === command || name === base) {
      return { name, entry };
    }
  }
  return null;
}

/**
 * Run a command and capture its output.
 * @internal
 */
async function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  abortSignal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutLimiter = createOutputLimiter(LIMITS.MAX_PROCESS_OUTPUT_BYTES);
    const stderrLimiter = createOutputLimiter(LIMITS.MAX_PROCESS_OUTPUT_BYTES);

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLimiter.append(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrLimiter.append(chunk);
      });
    }

    const abortHandler = () => {
      try {
        child.kill();
      } catch {
        // Process may already be terminated - safe to ignore
      }
    };
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('error', (error) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      resolve({
        stdout: stdoutLimiter.finalize(),
        stderr: stderrLimiter.finalize(),
        exitCode: code ?? 0,
      });
    });
  });
}

async function checkEngineVersion(
  command: string,
  versionArgs: string[],
  env: Record<string, string>,
  cwd: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const cacheKey = `${command}::${versionArgs.join(' ')}`;
  const cached = VERSION_CACHE.get(cacheKey);
  if (cached) return cached;

  const result = await runCommand(command, versionArgs, env, cwd, abortSignal);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to check engine version (exit ${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  VERSION_CACHE.set(cacheKey, output);
  return output;
}

function extractYamlBlock(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:yaml|yml)\s*([\s\S]*?)\s*```/gi;
  let match = regex.exec(text);
  while (match) {
    blocks.push(match[1].trim());
    match = regex.exec(text);
  }
  return blocks;
}

function parseStructuredSummary(text: string): { summary: unknown; format: 'json' | 'yaml' } {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty summary');
  }

  try {
    const parsed = extractJson(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Summary must be an object or array');
    }
    return { summary: parsed, format: 'json' };
  } catch {
    // Fall through to YAML
  }

  const yamlBlocks = extractYamlBlock(text);
  for (const block of yamlBlocks) {
    try {
      const parsed = yaml.load(block);
      if (typeof parsed === 'undefined') {
        throw new Error('Empty YAML summary');
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('Summary must be an object or array');
      }
      return { summary: parsed, format: 'yaml' };
    } catch {
      // Try next block
    }
  }

  const parsed = yaml.load(text);
  if (typeof parsed === 'undefined') {
    throw new Error('Empty YAML summary');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Summary must be an object or array');
  }
  return { summary: parsed, format: 'yaml' };
}

export async function executeEngineStep(
  step: EngineStep,
  context: ExpressionContext,
  options: EngineExecutorOptions = {}
): Promise<EngineExecutionResult> {
  const logger = options.logger || new ConsoleLogger();
  const abortSignal = options.abortSignal;

  if (abortSignal?.aborted) {
    throw new Error('Step canceled');
  }

  const command = ExpressionEvaluator.evaluateString(step.command, context);
  const args = (step.args || []).map((arg) => ExpressionEvaluator.evaluateString(arg, context));
  const cwd = ExpressionEvaluator.evaluateString(step.cwd, context);

  // Security note: spawn() is used with stdio: ['pipe', 'pipe', 'pipe'], NOT shell: true
  // This means args are passed directly to the process without shell interpretation.
  // Combined with the allowlist and version check, this is secure against injection.

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env || {})) {
    env[key] = ExpressionEvaluator.evaluateString(value, context);
  }

  if (!cwd) {
    throw new Error(`Engine step "${step.id}" requires an explicit cwd`);
  }
  if (!step.env) {
    throw new Error(`Engine step "${step.id}" requires an explicit env`);
  }

  const hasPath = Object.keys(env).some((key) => key.toLowerCase() === 'path');
  if (!path.isAbsolute(command) && !hasPath) {
    throw new Error(`Engine step "${step.id}" requires env.PATH when using a non-absolute command`);
  }

  const config = ConfigLoader.load();
  const allowlist = config.engines?.allowlist || {};
  const denylist = config.engines?.denylist || [];

  if (isDenied(command, denylist)) {
    throw new Error(`Engine command "${command}" is denied by engines.denylist`);
  }

  const allowlistMatch = resolveAllowlistEntry(command, allowlist);
  if (!allowlistMatch) {
    const allowed = Object.keys(allowlist);
    const allowedList = allowed.length > 0 ? allowed.join(', ') : 'none';
    throw new Error(`Engine command "${command}" is not in the allowlist. Allowed: ${allowedList}`);
  }

  const versionArgs = allowlistMatch.entry.versionArgs?.length
    ? allowlistMatch.entry.versionArgs
    : ['--version'];
  const versionOutput = await checkEngineVersion(command, versionArgs, env, cwd, abortSignal);
  if (!versionOutput.includes(allowlistMatch.entry.version)) {
    throw new Error(
      `Engine "${allowlistMatch.name}" version mismatch. Expected "${allowlistMatch.entry.version}", got "${versionOutput}"`
    );
  }

  const artifactRoot = options.artifactRoot || path.join(process.cwd(), '.keystone', 'artifacts');
  const runDir = options.runId ? path.join(artifactRoot, options.runId) : artifactRoot;
  mkdirSync(runDir, { recursive: true });

  const artifactId = options.stepExecutionId
    ? `${options.stepExecutionId}-${randomUUID()}`
    : randomUUID();
  const artifactPath = path.join(runDir, `${step.id}-${artifactId}-summary.json`);
  env.KEYSTONE_ENGINE_SUMMARY_PATH = artifactPath;

  const inputValue =
    step.input !== undefined ? ExpressionEvaluator.evaluateObject(step.input, context) : undefined;
  const inputPayload =
    inputValue === undefined
      ? undefined
      : typeof inputValue === 'string'
        ? inputValue
        : JSON.stringify(inputValue);

  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const stdoutLimiter = createOutputLimiter(LIMITS.MAX_PROCESS_OUTPUT_BYTES);
  const stderrLimiter = createOutputLimiter(LIMITS.MAX_PROCESS_OUTPUT_BYTES);

  const flushLines = (buffer: string, writer: (line: string) => void): string => {
    let next = buffer;
    let idx = next.indexOf('\n');
    while (idx !== -1) {
      const line = next.slice(0, idx).replace(/\r$/, '');
      writer(line);
      next = next.slice(idx + 1);
      idx = next.indexOf('\n');
    }
    return next;
  };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const abortHandler = () => {
      try {
        child.kill();
      } catch {
        // Process may already be terminated - safe to ignore
      }
    };
    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutLimiter.append(chunk);
        stdoutBuffer += text;
        stdoutBuffer = flushLines(stdoutBuffer, (line) => logger.log(line));
      });
      child.stdout.on('end', () => {
        if (stdoutBuffer.length > 0) {
          logger.log(stdoutBuffer.replace(/\r$/, ''));
          stdoutBuffer = '';
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrLimiter.append(chunk);
        stderrBuffer += text;
        stderrBuffer = flushLines(stderrBuffer, (line) => logger.error(line));
      });
      child.stderr.on('end', () => {
        if (stderrBuffer.length > 0) {
          logger.error(stderrBuffer.replace(/\r$/, ''));
          stderrBuffer = '';
        }
      });
    }

    if (inputPayload !== undefined && child.stdin) {
      child.stdin.write(inputPayload);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.on('error', (error) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      resolve(code ?? 0);
    });
  });

  stdout = stdoutLimiter.finalize();
  stderr = stderrLimiter.finalize();

  let summary: unknown | null = null;
  let summarySource: 'file' | 'stdout' | undefined;
  let summaryFormat: 'json' | 'yaml' | undefined;
  let summaryError: string | undefined;

  if (existsSync(artifactPath)) {
    const fileText = await Bun.file(artifactPath).text();
    if (fileText.trim().length > 0) {
      try {
        const parsed = parseStructuredSummary(fileText);
        summary = parsed.summary;
        summarySource = 'file';
        summaryFormat = parsed.format;
      } catch (error) {
        summaryError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (!summary && !summaryError) {
    try {
      const parsed = parseStructuredSummary(stdout);
      summary = parsed.summary;
      summarySource = 'stdout';
      summaryFormat = parsed.format;
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
    }
  }

  if (summary !== null) {
    const redacted = options.redactForStorage ? options.redactForStorage(summary) : summary;
    await Bun.write(artifactPath, JSON.stringify(redacted, null, 2));
  }

  return {
    stdout,
    stderr,
    exitCode,
    stdoutTruncated: stdoutLimiter.truncated,
    stderrTruncated: stderrLimiter.truncated,
    summary,
    summarySource,
    summaryFormat,
    artifactPath: summary !== null ? artifactPath : undefined,
    summaryError,
  };
}
