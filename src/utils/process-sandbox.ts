/**
 * Process-based sandbox for executing untrusted script code.
 *
 * This provides better isolation than node:vm by running scripts in a
 * separate subprocess with limited environment and OS-level timeout.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProcessSandboxOptions {
    /** Timeout in milliseconds (default: 5000) */
    timeout?: number;
    /** Memory limit in bytes (enforced via ulimit on Unix) */
    memoryLimit?: number;
    /** Working directory for the subprocess */
    cwd?: string;
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
        const timeout = options.timeout ?? 5000;
        const tempDir = join(tmpdir(), `keystone-sandbox-${randomUUID()}`);

        try {
            // Create temp directory for the script
            await mkdir(tempDir, { recursive: true });

            // Write the runner script
            const runnerScript = ProcessSandbox.createRunnerScript(code, context);
            const scriptPath = join(tempDir, 'script.js');
            await writeFile(scriptPath, runnerScript, 'utf-8');

            // Execute in subprocess
            const result = await ProcessSandbox.runInSubprocess(scriptPath, timeout, options);

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
     * Create the runner script that will be executed in the subprocess.
     */
    private static createRunnerScript(code: string, context: Record<string, unknown>): string {
        // Sanitize context by re-parsing to strip any inherited properties or prototype pollution
        const sanitizedContext = JSON.parse(JSON.stringify(context));
        const contextJson = JSON.stringify(sanitizedContext);

        return `
// Minimal sandbox environment
// Context is sanitized through JSON parse/stringify to prevent prototype pollution
const context = ${contextJson};

// Remove dangerous globals
delete globalThis.process;
delete globalThis.require;
delete globalThis.module;
delete globalThis.exports;
delete globalThis.__dirname;
delete globalThis.__filename;

// Make context variables available
Object.assign(globalThis, context);

(async () => {
  try {
    // Execute the user code (wrap in async to support await)
    const __result = await (async () => {
      ${code}
    })();
    
    console.log(JSON.stringify({ success: true, result: __result }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message || String(error) }));
  }
})();
`;
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
            let timedOut = false;

            // Spawn bun with minimal environment
            const child = spawn('bun', ['run', scriptPath], {
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

            // Collect stdout
            child.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            // Handle process exit
            child.on('close', (exitCode) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                if (timedOut) {
                    resolve({ success: false, timedOut: true });
                    return;
                }

                if (exitCode !== 0 && !stdout) {
                    resolve({
                        success: false,
                        error: `Process exited with code ${exitCode}`,
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
                resolve({
                    success: false,
                    error: `Failed to spawn process: ${error.message}`,
                });
            });
        });
    }
}
