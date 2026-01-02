import { describe, expect, it } from 'bun:test';
import * as vm from 'node:vm';
import { STANDARD_TOOLS } from './standard-tools';

describe('Standard Tools Execution Verification', () => {
  const scriptTools = STANDARD_TOOLS.filter(
    (t) => t.execution && t.execution.type === 'script' && typeof t.execution.run === 'string'
  );

  for (const tool of scriptTools) {
    it(`should compile and execute ${tool.name} without SyntaxError`, () => {
      const script = tool.execution.run as string;
      const sandbox = {
        args: { path: '.', pattern: '*', query: 'test' },
        require: (mod: string) => {
          if (mod === 'node:fs' || mod === 'fs') {
            return {
              existsSync: () => true,
              readdirSync: () => [],
              statSync: () => ({ size: 0 }),
              readFileSync: () => '',
              writeFileSync: () => {},
            };
          }
          if (mod === 'node:path' || mod === 'path') {
            return { join: (...args: string[]) => args.join('/') };
          }
          if (mod === 'glob') {
            return { globSync: () => [] };
          }
          if (mod === '@ast-grep/napi') {
            return {
              Lang: {
                JavaScript: 'javascript',
                TypeScript: 'typescript',
                Tsx: 'tsx',
                Python: 'python',
                Rust: 'rust',
                Go: 'go',
                C: 'c',
                Cpp: 'cpp',
                Java: 'java',
                Kotlin: 'kotlin',
                Swift: 'swift',
                Html: 'html',
                Css: 'css',
                Json: 'json',
              },
              parse: () => ({
                root: () => ({
                  findAll: () => [],
                  replace: () => '',
                }),
              }),
            };
          }
          if (mod === 'node:worker_threads') {
            return {
              Worker: class MockWorker {
                on() {}
                terminate() {}
              },
              parentPort: null,
              workerData: null,
            };
          }
          return {};
        },
      };

      expect(() => {
        // Wrap the script in an async IIFE to match ProcessSandbox behavior
        // ProcessSandbox wraps scripts: const __result = await (async () => { ${code} })();
        const wrappedScript = `(async () => { ${script} })()`;
        vm.runInNewContext(wrappedScript, sandbox);
      }).not.toThrow();
    });
  }
});
