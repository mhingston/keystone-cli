import * as vm from 'node:vm';

export interface SandboxOptions {
  timeout?: number;
  memoryLimit?: number;
  allowInsecureFallback?: boolean;
}

export class SafeSandbox {
  /**
   * Execute a script in a secure sandbox
   */
  static async execute(
    code: string,
    context: Record<string, unknown> = {},
    options: SandboxOptions = {}
  ): Promise<unknown> {
    try {
      // Try to use isolated-vm if available (dynamic import)
      // Note: This will likely fail on Bun as it expects V8 host symbols
      const ivm = await import('isolated-vm').then((m) => m.default || m).catch(() => null);

      if (ivm && typeof ivm.Isolate === 'function') {
        const isolate = new ivm.Isolate({ memoryLimit: options.memoryLimit || 128 });
        try {
          const contextInstance = await isolate.createContext();
          const jail = contextInstance.global;

          // Set up global context
          await jail.set('global', jail.derefInto());

          // Inject context variables
          for (const [key, value] of Object.entries(context)) {
            // Only copy non-undefined values
            if (value !== undefined) {
              await jail.set(key, new ivm.ExternalCopy(value).copyInto());
            }
          }

          const script = await isolate.compileScript(code);
          const result = await script.run(contextInstance, { timeout: options.timeout || 5000 });

          if (result && typeof result === 'object' && result instanceof ivm.Reference) {
            return await result.copy();
          }
          return result;
        } finally {
          isolate.dispose();
        }
      }
    } catch (e) {
      // If isolated-vm failed during execution (not just loading), log it if we're debugging
    }

    // Fallback implementation using node:vm (built-in)
    // ONLY allowed if explicitly opted in via options
    if (!options.allowInsecureFallback) {
      throw new Error(
        'Execution in secure sandbox failed (isolated-vm not available) and insecure fallback is disabled.\n' +
          'To allow insecure execution, set allowInsecureFallback: true in sandbox options.\n' +
          'Note: Insecure execution is NOT recommended for untrusted code.'
      );
    }

    if (!SafeSandbox.warned) {
      const isBun = typeof Bun !== 'undefined';
      console.warn(
        `\n⚠️  SECURITY WARNING: Using ${isBun ? 'Bun' : 'Node.js'} built-in VM for script execution.\n   This sandbox is NOT secure against malicious code.\n   Only run workflows from trusted sources.\n`
      );
      SafeSandbox.warned = true;
    }

    const sandbox = { ...context };
    return vm.runInNewContext(code, sandbox, {
      timeout: options.timeout || 5000,
      displayErrors: true,
    });
  }

  private static warned = false;
}
