import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { STANDARD_TOOLS, validateStandardToolSecurity } from './standard-tools';

describe('AST-Grep Tools', () => {
  let tempDir: string;
  let testFile: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grep-test-'));
    testFile = path.join(tempDir, 'test.js');
    fs.writeFileSync(
      testFile,
      `function hello() {
  console.log("world");
  console.log("hello");
}
`
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Tool Definitions', () => {
    it('should have ast_grep_search tool', () => {
      const tool = STANDARD_TOOLS.find((t) => t.name === 'ast_grep_search');
      expect(tool).toBeDefined();
      expect(tool?.execution?.type).toBe('script');
      expect(tool?.parameters?.required).toContain('pattern');
      expect(tool?.parameters?.required).toContain('paths');
    });

    it('should have ast_grep_replace tool', () => {
      const tool = STANDARD_TOOLS.find((t) => t.name === 'ast_grep_replace');
      expect(tool).toBeDefined();
      expect(tool?.execution?.type).toBe('script');
      expect(tool?.parameters?.required).toContain('pattern');
      expect(tool?.parameters?.required).toContain('rewrite');
      expect(tool?.parameters?.required).toContain('paths');
    });

    it('should have append_file tool', () => {
      const tool = STANDARD_TOOLS.find((t) => t.name === 'append_file');
      expect(tool).toBeDefined();
      expect(tool?.execution?.type).toBe('file');
      expect(tool?.execution?.op).toBe('append');
    });
  });

  describe('Security Validation', () => {
    const cwd = process.cwd();

    it('should allow AST tools for paths within CWD', () => {
      expect(() => {
        validateStandardToolSecurity(
          'ast_grep_search',
          { pattern: 'console.log($A)', paths: ['src/test.ts'] },
          { allowOutsideCwd: false }
        );
      }).not.toThrow();
    });

    it('should block AST tools for paths outside CWD', () => {
      expect(() => {
        validateStandardToolSecurity(
          'ast_grep_search',
          { pattern: 'console.log($A)', paths: ['/etc/passwd'] },
          { allowOutsideCwd: false }
        );
      }).toThrow(/Access denied/);
    });

    it('should allow AST tools for paths outside CWD when allowOutsideCwd is true', () => {
      expect(() => {
        validateStandardToolSecurity(
          'ast_grep_replace',
          { pattern: 'foo', rewrite: 'bar', paths: ['/tmp/test.js'] },
          { allowOutsideCwd: true }
        );
      }).not.toThrow();
    });

    it('should validate all paths in the array', () => {
      expect(() => {
        validateStandardToolSecurity(
          'ast_grep_search',
          { pattern: 'test', paths: ['src/ok.ts', '../../outside.ts'] },
          { allowOutsideCwd: false }
        );
      }).toThrow(/Access denied/);
    });

    it('should allow append_file within CWD', () => {
      expect(() => {
        validateStandardToolSecurity(
          'append_file',
          { path: 'test.log', content: 'test' },
          { allowOutsideCwd: false }
        );
      }).not.toThrow();
    });
  });

  describe('AST-Grep Search Execution', () => {
    it('should compile ast_grep_search script without errors', () => {
      const tool = STANDARD_TOOLS.find((t) => t.name === 'ast_grep_search');
      expect(tool).toBeDefined();

      const script = tool?.execution?.run as string;
      const sandbox = {
        args: { pattern: 'console.log($A)', language: 'javascript', paths: [] },
        require: (mod: string) => {
          if (mod === 'node:fs' || mod === 'fs') {
            return {
              existsSync: () => false,
              readFileSync: () => '',
            };
          }
          if (mod === 'node:path' || mod === 'path') {
            return { join: (...args: string[]) => args.join('/') };
          }
          if (mod === '@ast-grep/napi') {
            return {
              Lang: {
                JavaScript: 'javascript',
                TypeScript: 'typescript',
              },
              parse: () => ({
                root: () => ({
                  findAll: () => [],
                }),
              }),
            };
          }
          return {};
        },
      };

      expect(() => {
        // Wrap in async IIFE to support top-level return
        vm.runInNewContext(`(async () => { ${script} })();`, sandbox);
      }).not.toThrow();
    });
  });

  describe('AST-Grep Replace Execution', () => {
    it('should compile ast_grep_replace script without errors', () => {
      const tool = STANDARD_TOOLS.find((t) => t.name === 'ast_grep_replace');
      expect(tool).toBeDefined();

      const script = tool?.execution?.run as string;
      const sandbox = {
        args: {
          pattern: 'console.log($A)',
          rewrite: 'logger.info($A)',
          language: 'javascript',
          paths: [],
        },
        require: (mod: string) => {
          if (mod === 'node:fs' || mod === 'fs') {
            return {
              existsSync: () => false,
              readFileSync: () => '',
              writeFileSync: () => {},
            };
          }
          if (mod === 'node:path' || mod === 'path') {
            return { join: (...args: string[]) => args.join('/') };
          }
          if (mod === '@ast-grep/napi') {
            return {
              Lang: {
                JavaScript: 'javascript',
                TypeScript: 'typescript',
              },
              parse: () => ({
                root: () => ({
                  replace: () => '',
                }),
              }),
            };
          }
          return {};
        },
      };

      expect(() => {
        // Wrap in async IIFE to support top-level return
        vm.runInNewContext(`(async () => { ${script} })();`, sandbox);
      }).not.toThrow();
    });
  });
});
