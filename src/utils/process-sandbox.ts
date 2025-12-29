/**
 * Process-based sandbox for executing untrusted script code.
 *
 * This provides better isolation than node:vm by running scripts in a
 * separate subprocess with limited environment and OS-level timeout.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_MODES, TIMEOUTS } from './constants.ts';
import type { Logger } from './logger.ts';

/** Prefix for sandbox temp directories - used for cleanup detection */
const SANDBOX_TEMP_PREFIX = 'keystone-sandbox-';

/** Max age for orphaned temp directories before cleanup (1 hour) */
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface ProcessSandboxOptions {
  /** Timeout in milliseconds (default: TIMEOUTS.DEFAULT_SCRIPT_TIMEOUT_MS) */
  timeout?: number;
  /** Memory limit in bytes (enforced via ulimit on Unix) */
  memoryLimit?: number;
  /** Working directory for the subprocess */
  cwd?: string;
  /** Logger for script output (console.log, etc) */
  logger?: Logger;
  /** Use Bun Worker instead of subprocess (default: false) */
  useWorker?: boolean;
  /** Abort signal for manual cancellation */
  signal?: AbortSignal;
}

export interface ProcessSandboxResult {
  success: boolean;
  result?: unknown;
  error?: string;
  timedOut?: boolean;
}

/**
 * Execute script code in an isolated subprocess.
 *
 * This provides better isolation than node:vm by:
 * 1. Running in a separate process with limited environment
 * 2. Using OS-level timeout (SIGKILL on timeout)
 * 3. Limiting available globals and modules
 */
export class ProcessSandbox {
  /**
   * Execute a script in an isolated subprocess.
   *
   * @param code The JavaScript code to execute (should be an expression or return statement)
   * @param context Variables to make available in the script
   * @param options Execution options
   * @returns The result of the script execution
   */
  static async execute(
    code: string,
    context: Record<string, unknown> = {},
    options: ProcessSandboxOptions = {}
  ): Promise<unknown> {
    const timeout = options.timeout ?? TIMEOUTS.DEFAULT_SCRIPT_TIMEOUT_MS;
    const tempDir = join(tmpdir(), `keystone-sandbox-${randomUUID()}`);

    try {
      // Create temp directory with restrictive permissions (0o700 = owner only)
      await mkdir(tempDir, { recursive: true, mode: FILE_MODES.SECURE_DIR });

      // Write the runner script
      const runnerScript = ProcessSandbox.createRunnerScript(code, context, !!options.useWorker);
      const scriptPath = join(tempDir, 'script.js');
      await writeFile(scriptPath, runnerScript, 'utf-8');

      // Execute in subprocess or worker
      const result = options.useWorker
        ? await ProcessSandbox.runInWorker(scriptPath, timeout, options)
        : await ProcessSandbox.runInSubprocess(scriptPath, timeout, options);

      if (options.signal?.aborted) {
        throw new Error('Script execution aborted');
      }

      if (result.timedOut) {
        throw new Error(`Script execution timed out after ${timeout}ms`);
      }

      if (!result.success) {
        throw new Error(result.error ?? 'Script execution failed');
      }

      return result.result;
    } finally {
      // Clean up temp directory
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Create the runner script that will be executed in the subprocess or worker.
   */
  private static createRunnerScript(
    code: string,
    context: Record<string, unknown>,
    isWorker: boolean
  ): string {
    // Check for prototype pollution attempts before serialization
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
    const checkForDangerousKeys = (
      obj: unknown,
      path = '',
      visited = new WeakSet<object>()
    ): void => {
      if (obj === null || typeof obj !== 'object') return;

      // Prevent infinite loops with circular references
      if (visited.has(obj)) return;
      visited.add(obj);

      // Handle arrays - check each element
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => checkForDangerousKeys(item, `${path}[${idx}]`, visited));
        return;
      }

      // Use getOwnPropertyNames to catch non-enumerable properties too
      for (const key of Object.getOwnPropertyNames(obj)) {
        if (dangerousKeys.includes(key)) {
          throw new Error(
            `Security Error: Context contains forbidden key "${key}"${path ? ` at path "${path}"` : ''}. ` +
            `This may indicate a prototype pollution attack.`
          );
        }
        checkForDangerousKeys(
          (obj as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
          visited
        );
      }
    };
    checkForDangerousKeys(context);

    // Sanitize context by re-parsing to strip any inherited properties or prototype pollution
    const sanitizedContext = JSON.parse(JSON.stringify(context));
    const contextJson = JSON.stringify(sanitizedContext);

    return `
// Minimal sandbox environment
// Context is sanitized through JSON parse/stringify to prevent prototype pollution
const context = ${contextJson};

// Use explicit flag passed from host
const isWorker = ${isWorker};

// Capture essential functions before deleting dangerous globals
const __write = !isWorker ? process.stdout.write.bind(process.stdout) : null;
const __post = isWorker ? self.postMessage.bind(self) : null;

// Remove dangerous globals to prevent sandbox escape
const dangerousGlobals = [
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Bun',
  'fetch',
  'crypto',
  'Worker',
  'navigator',
  'performance',
  'alert',
  'confirm',
  'prompt',
  'addEventListener',
  'dispatchEvent',
  'removeEventListener',
  'onmessage',
  'onerror',
  'ErrorEvent',
];

for (const g of dangerousGlobals) {
  try {
    delete globalThis[g];
  } catch (e) {
    // Ignore errors for non-deletable properties
  }
}

// Make context variables available
Object.assign(globalThis, context);

// Custom console that prefixes logs for the runner to intercept
const __keystone_console = {
  log: (...args) => {
    if (isWorker) {
      __post({ type: 'log', message: args.join(' ') });
    } else {
      __write('__SANDBOX_LOG__:' + args.join(' ') + '\\n');
    }
  },
  error: (...args) => {
    if (isWorker) {
      __post({ type: 'log', message: 'ERROR: ' + args.join(' ') });
    } else {
      __write('__SANDBOX_LOG__:ERROR: ' + args.join(' ') + '\\n');
    }
  },
  warn: (...args) => {
    if (isWorker) {
      __post({ type: 'log', message: 'WARN: ' + args.join(' ') });
    } else {
      __write('__SANDBOX_LOG__:WARN: ' + args.join(' ') + '\\n');
    }
  },
  info: (...args) => {
    if (isWorker) {
      __post({ type: 'log', message: 'INFO: ' + args.join(' ') });
    } else {
      __write('__SANDBOX_LOG__:INFO: ' + args.join(' ') + '\\n');
    }
  },
  debug: (...args) => {
    if (isWorker) {
      __post({ type: 'log', message: 'DEBUG: ' + args.join(' ') });
    } else {
      __write('__SANDBOX_LOG__:DEBUG: ' + args.join(' ') + '\\n');
    }
  }
};

// Replace global console
globalThis.console = __keystone_console;

(async () => {
  try {
    // Execute the user code (wrap in async to support await)
    const __result = await (async () => {
      ${code}
    })();
    
    if (isWorker) {
      __post({ type: 'result', success: true, result: __result });
    } else {
      __write(JSON.stringify({ success: true, result: __result }) + '\\n');
    }
  } catch (error) {
    const errorMsg = error.message || String(error);
    if (isWorker) {
      __post({ type: 'result', success: false, error: errorMsg });
    } else {
      __write(JSON.stringify({ success: false, error: errorMsg }) + '\\n');
    }
  }
})();
`;
  }

  /**
   * Run a script in a Bun Worker with timeout.
   */
  private static runInWorker(
    scriptPath: string,
    timeout: number,
    options: ProcessSandboxOptions
  ): Promise<ProcessSandboxResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      const worker = new Worker(scriptPath);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        worker.terminate();
        resolve({ success: false, timedOut: true });
      }, timeout);

      const onAbort = () => {
        clearTimeout(timeoutHandle);
        worker.terminate();
        resolve({ success: false, error: 'Script execution aborted' });
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      worker.onmessage = (event) => {
        const data = event.data;
        if (data?.type === 'log') {
          options.logger?.log(data.message);
        } else if (data?.type === 'result') {
          clearTimeout(timeoutHandle);
          if (options.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          worker.terminate();
          resolve(data);
        }
      };

      worker.onerror = (error) => {
        clearTimeout(timeoutHandle);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        worker.terminate();
        resolve({ success: false, error: error.message });
      };
    });
  }

  /**
   * Run a script file in a subprocess with timeout.
   */
  private static runInSubprocess(
    scriptPath: string,
    timeout: number,
    options: ProcessSandboxOptions
  ): Promise<ProcessSandboxResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const useMemoryLimit = typeof options.memoryLimit === 'number' && options.memoryLimit > 0;
      const isWindows = process.platform === 'win32';
      let command = 'bun';
      let args = ['run', scriptPath];

      if (useMemoryLimit) {
        if (isWindows) {
          options.logger?.warn?.(
            'ProcessSandbox: memoryLimit is not supported on Windows; running without a limit.'
          );
        } else {
          const limitKb = Math.max(1, Math.floor((options.memoryLimit as number) / 1024));
          const escapedPath = scriptPath.replace(/'/g, "'\\''");
          command = 'sh';
          args = ['-c', `ulimit -v ${limitKb}; exec bun run '${escapedPath}'`];
        }
      }

      // Spawn bun with minimal environment
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          // Only pass essential environment variables
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      const onAbort = () => {
        clearTimeout(timeoutHandle);
        child.kill('SIGKILL');
        resolve({ success: false, error: 'Script execution aborted' });
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Collect stdout and intercept logs
      let buffer = '';
      child.stdout.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the last (potentially incomplete) line in buffer

        for (const line of lines) {
          if (line.startsWith('__SANDBOX_LOG__:')) {
            options.logger?.log(line.slice(16));
          } else if (line) {
            stdout += `${line}\n`;
          }
        }
      });

      // Collect stderr
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle process exit
      child.on('close', (exitCode) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }

        if (timedOut) {
          resolve({ success: false, timedOut: true });
          return;
        }

        if (exitCode !== 0 && !stdout) {
          resolve({
            success: false,
            error: `Process exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
          });
          return;
        }

        try {
          // Parse the JSON output from the runner script
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const result = JSON.parse(lastLine) as ProcessSandboxResult;
          resolve(result);
        } catch {
          resolve({
            success: false,
            error: `Failed to parse script output: ${stdout}`,
          });
        }
      });

      child.on('error', (error) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        resolve({
          success: false,
          error: `Failed to spawn process: ${error.message}`,
        });
      });
    });
  }

  /**
   * Clean up orphaned temp directories from previous sandbox executions.
   * Should be called on startup to remove directories left behind by
   * SIGKILL or process crashes.
   *
   * @param logger Optional logger for cleanup messages
   * @returns Number of directories cleaned up
   */
  static async cleanupOrphanedTempDirs(logger?: Logger): Promise<number> {
    let cleaned = 0;
    const tempBase = tmpdir();
    const now = Date.now();

    try {
      const entries = await readdir(tempBase, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(SANDBOX_TEMP_PREFIX)) {
          continue;
        }

        const dirPath = join(tempBase, entry.name);
        try {
          const stats = await stat(dirPath);
          const age = now - stats.mtimeMs;

          if (age > ORPHAN_TEMP_MAX_AGE_MS) {
            await rm(dirPath, { recursive: true, force: true });
            cleaned++;
            logger?.debug?.(`Cleaned up orphaned sandbox temp dir: ${entry.name}`);
          }
        } catch {
          // Ignore errors for individual directories (may already be deleted)
        }
      }

      if (cleaned > 0) {
        logger?.log(
          `Cleaned up ${cleaned} orphaned sandbox temp director${cleaned === 1 ? 'y' : 'ies'}`
        );
      }
    } catch {
      // Ignore errors reading temp directory
    }

    return cleaned;
  }
}
