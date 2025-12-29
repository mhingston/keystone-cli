import * as fs from 'node:fs';
import * as path from 'node:path';
import { Lang, parse } from '@ast-grep/napi';
import type { AgentTool } from '../parser/schema';
import { LIMITS, TIMEOUTS } from '../utils/constants';
import { detectShellInjectionRisk } from './executors/shell-executor';

export const STANDARD_TOOLS: AgentTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
      },
      required: ['path'],
    },
    execution: {
      id: 'std_read_file',
      type: 'file',
      op: 'read',
      path: '${{ args.path }}',
    },
  },
  {
    name: 'read_file_lines',
    description: 'Read a specific range of lines from a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        start: { type: 'number', description: 'Starting line number (1-indexed)', default: 1 },
        count: { type: 'number', description: 'Number of lines to read', default: 100 },
      },
      required: ['path'],
    },
    execution: {
      id: 'std_read_file_lines',
      type: 'script',
      run: `
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const filePath = args.path;
          const start = args.start || 1;
          const count = args.count || 100;
  
          if (!fs.existsSync(filePath)) {
            throw new Error('File not found: ' + filePath);
          }
  
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\\n');
          return lines.slice(start - 1, start - 1 + count).join('\\n');
        })();
      `,
      allowInsecure: true,
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file with content',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
    execution: {
      id: 'std_write_file',
      type: 'file',
      op: 'write',
      path: '${{ args.path }}',
      content: '${{ args.content }}',
    },
  },
  {
    name: 'append_file',
    description: 'Append content to the end of a file (creates if not exists)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to append to' },
        content: { type: 'string', description: 'Content to append to the file' },
      },
      required: ['path', 'content'],
    },
    execution: {
      id: 'std_append_file',
      type: 'file',
      op: 'append',
      path: '${{ args.path }}',
      content: '${{ args.content }}',
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (defaults to current directory)',
          default: '.',
        },
      },
    },
    execution: {
      id: 'std_list_files',
      type: 'script',
      run: `
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const dir = args.path || '.';
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir, { withFileTypes: true });
            return files.map(f => ({
              name: f.name,
              type: f.isDirectory() ? 'directory' : 'file',
              size: f.isFile() ? fs.statSync(path.join(dir, f.name)).size : undefined
            }));
          }
          throw new Error('Directory not found: ' + dir);
        })();
      `,
      allowInsecure: true,
    },
  },
  {
    name: 'search_files',
    description: 'Search for files by pattern (glob)',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' },
        dir: { type: 'string', description: 'Directory to search in', default: '.' },
      },
      required: ['pattern'],
    },
    execution: {
      allowInsecure: true,
    },
  },
  {
    name: 'search_content',
    description: 'Search for a string or regex within files',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String or regex to search for' },
        pattern: {
          type: 'string',
          description: 'Glob pattern of files to search in',
          default: '**/*',
        },
        dir: { type: 'string', description: 'Directory to search in', default: '.' },
      },
      required: ['query'],
    },
    execution: {
      id: 'std_search_content',
      type: 'script',
      run: `
        (async function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const { globSync } = require('glob');
          // Try to request worker_threads. If not available, we might fall back or fail safely.
          // Standard Node environment carries it.
          const { Worker } = require('node:worker_threads');
          
          const dir = args.dir || '.';
          const pattern = args.pattern || '**/*';
          const query = args.query;
          
          const LIMITS = ${JSON.stringify(LIMITS)};
          const TIMEOUTS = ${JSON.stringify(TIMEOUTS)};

          if (query.length > LIMITS.MAX_SEARCH_QUERY_LENGTH) {
            throw new Error('Search query exceeds maximum length of ' + LIMITS.MAX_SEARCH_QUERY_LENGTH + ' characters');
          }

          const isRegex = query.startsWith('/') && query.endsWith('/') && query.length > 1;

          // If NOT regex, use simple main-thread search (safe)
          if (!isRegex) {
             const normalizedQuery = query.toLowerCase();
             const files = globSync(pattern, { cwd: dir, nodir: true });
             const results = [];
             for (const file of files) {
                const fullPath = path.join(dir, file);
                try {
                  const stat = fs.statSync(fullPath);
                  if (stat.size > LIMITS.MAX_SEARCH_FILE_BYTES) continue;
                  const content = fs.readFileSync(fullPath, 'utf8');
                  const lines = content.split('\\n');
                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.length > LIMITS.MAX_SEARCH_LINE_LENGTH) continue;
                    if (line.toLowerCase().includes(normalizedQuery)) {
                      results.push({
                        file,
                        line: i + 1,
                        content: line.trim()
                      });
                    }
                    if (results.length >= LIMITS.MAX_SEARCH_RESULTS) break;
                  }
                } catch {}
                if (results.length >= LIMITS.MAX_SEARCH_RESULTS) break;
             }
             return results;
          }

          // For REGEX, use a Worker to handle ReDoS/Timeouts
          // We pass the files list to the worker so it does the heavy lifting
          const files = globSync(pattern, { cwd: dir, nodir: true });
          
          const workerScript = \`
            const { parentPort, workerData } = require('node:worker_threads');
            const fs = require('node:fs');
            const path = require('node:path');
            
            try {
              const { files, dir, query, LIMITS } = workerData;
              let Re2;
              try { Re2 = require('re2'); } catch {}
              
              const patternStr = query.slice(1, -1);
              let regex;
              try {
                regex = Re2 ? new Re2(patternStr) : new RegExp(patternStr);
              } catch (e) {
                parentPort.postMessage({ error: 'Invalid regex: ' + e.message });
                process.exit(0);
              }

              const results = [];
              
              for (const file of files) {
                const fullPath = path.join(dir, file);
                try {
                  const stat = fs.statSync(fullPath);
                  if (stat.size > LIMITS.MAX_SEARCH_FILE_BYTES) continue;
                  const content = fs.readFileSync(fullPath, 'utf8');
                  const lines = content.split('\\n');
                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.length > LIMITS.MAX_SEARCH_LINE_LENGTH) continue;
                    
                    // This matching is interruptible by thread termination
                    if (regex.test(line)) {
                      results.push({
                         file,
                         line: i + 1,
                         content: line.trim()
                      });
                    }
                    if (results.length >= LIMITS.MAX_SEARCH_RESULTS) break;
                  }
                } catch {}
                if (results.length >= LIMITS.MAX_SEARCH_RESULTS) break;
              }
              
              parentPort.postMessage({ results });
            } catch (err) {
              parentPort.postMessage({ error: err.message });
            }
          \`;

          return new Promise((resolve, reject) => {
            const worker = new Worker(workerScript, {
              eval: true,
              workerData: { files, dir, query, LIMITS }
            });

            // Hard timeout
            const timeout = setTimeout(() => {
              worker.terminate();
              reject(new Error('Regex search timed out (possible ReDoS or large working set).'));
            }, TIMEOUTS.REGEX_TIMEOUT_MS);

            worker.on('message', (msg) => {
              clearTimeout(timeout);
              if (msg.error) {
                reject(new Error(msg.error));
              } else {
                resolve(msg.results);
              }
              worker.terminate();
            });

            worker.on('error', (err) => {
               clearTimeout(timeout);
               reject(err);
            });

            worker.on('exit', (code) => {
              if (code !== 0) {
                 clearTimeout(timeout);
                 reject(new Error(\`Worker stopped with exit code \${code}\`));
              }
            });
          });
        })();
      `,
      allowInsecure: true,
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        dir: { type: 'string', description: 'Working directory for the command' },
      },
      required: ['command'],
    },
    execution: {
      id: 'std_run_command',
      type: 'shell',
      run: '${{ args.command }}',
      dir: '${{ args.dir }}',
    },
  },
  {
    name: 'ast_grep_search',
    description:
      'Search for structural code patterns using AST pattern matching. More precise than regex for code refactoring.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'AST-grep pattern to search for, e.g. "console.log($A)"',
        },
        language: {
          type: 'string',
          description: 'Programming language (javascript, typescript, python, rust, go, etc.)',
          default: 'typescript',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to search in',
        },
      },
      required: ['pattern', 'paths'],
    },
    execution: {
      id: 'std_ast_grep_search',
      type: 'script',
      run: `
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const { Lang, parse } = require('@ast-grep/napi');

          const pattern = args.pattern;
          const language = args.language || 'typescript';
          const paths = args.paths || [];

          const langMap = {
            javascript: Lang.JavaScript,
            typescript: Lang.TypeScript,
            tsx: Lang.Tsx,
            python: Lang.Python,
            rust: Lang.Rust,
            go: Lang.Go,
            c: Lang.C,
            cpp: Lang.Cpp,
            java: Lang.Java,
            kotlin: Lang.Kotlin,
            swift: Lang.Swift,
            html: Lang.Html,
            css: Lang.Css,
            json: Lang.Json,
          };

          const lang = langMap[language.toLowerCase()];
          if (!lang) {
            throw new Error('Unsupported language: ' + language);
          }

          const results = [];
          for (const filePath of paths) {
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const tree = parse(lang, content);
            const root = tree.root();
            const matches = root.findAll(pattern);

            for (const match of matches) {
              const range = match.range();
              results.push({
                file: filePath,
                line: range.start.line + 1,
                column: range.start.column + 1,
                content: match.text(),
              });
            }
          }
          return results;
        })();
      `,
      allowInsecure: true,
    },
  },
  {
    name: 'ast_grep_replace',
    description:
      'Replace structural code patterns using AST-aware rewriting. Safer than regex for code refactoring.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'AST-grep pattern to match, e.g. "console.log($A)"',
        },
        rewrite: { type: 'string', description: 'Replacement pattern, e.g. "logger.info($A)"' },
        language: {
          type: 'string',
          description: 'Programming language (javascript, typescript, python, rust, go, etc.)',
          default: 'typescript',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to apply replacements to',
        },
      },
      required: ['pattern', 'rewrite', 'paths'],
    },
    execution: {
      id: 'std_ast_grep_replace',
      type: 'script',
      run: `
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const { Lang, parse } = require('@ast-grep/napi');

          const pattern = args.pattern;
          const rewrite = args.rewrite;
          const language = args.language || 'typescript';
          const paths = args.paths || [];

          const langMap = {
            javascript: Lang.JavaScript,
            typescript: Lang.TypeScript,
            tsx: Lang.Tsx,
            python: Lang.Python,
            rust: Lang.Rust,
            go: Lang.Go,
            c: Lang.C,
            cpp: Lang.Cpp,
            java: Lang.Java,
            kotlin: Lang.Kotlin,
            swift: Lang.Swift,
            html: Lang.Html,
            css: Lang.Css,
            json: Lang.Json,
          };

          const lang = langMap[language.toLowerCase()];
          if (!lang) {
            throw new Error('Unsupported language: ' + language);
          }

          const results = [];
          for (const filePath of paths) {
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const tree = parse(lang, content);
            const root = tree.root();
            const edit = root.replace(pattern, rewrite);

            if (edit !== content) {
              fs.writeFileSync(filePath, edit);
              results.push({
                file: filePath,
                modified: true,
              });
            }
          }
          return results;
        })();
      `,
      allowInsecure: true,
    },
  },
  {
    name: 'fetch',
    description: 'Fetch content from a URL (GET request)',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
    execution: {
      id: 'std_fetch',
      type: 'request',
      url: '${{ args.url }}',
      method: 'GET',
    },
  },
];

/**
 * Validate that a tool call is safe to execute based on the LLM step's security flags.
 */
export function validateStandardToolSecurity(
  toolName: string,
  args: unknown,
  options: { allowOutsideCwd?: boolean; allowInsecure?: boolean }
): void {
  const cwd = process.cwd();
  const realCwd = fs.realpathSync(cwd);
  const normalizePath = (rawPath: unknown): string => {
    if (typeof rawPath === 'string' && rawPath.trim() !== '') {
      return rawPath;
    }
    return '.';
  };
  const isWithin = (rawPath: string) => {
    const resolvedPath = path.resolve(cwd, rawPath);
    // Find the first existing ancestor to resolve the real path correctly
    let current = resolvedPath;
    while (current !== path.dirname(current) && !fs.existsSync(current)) {
      current = path.dirname(current);
    }
    const realTarget = fs.existsSync(current) ? fs.realpathSync(current) : current;
    const relativePath = path.relative(realCwd, realTarget);
    return !(relativePath.startsWith('..') || path.isAbsolute(relativePath));
  };
  const assertWithinCwd = (rawPath: unknown, label = 'Path') => {
    const normalizedPath = normalizePath(rawPath);
    if (!options.allowOutsideCwd && !isWithin(normalizedPath)) {
      throw new Error(
        `Access denied: ${label} '${normalizedPath}' resolves outside the working directory. Use 'allowOutsideCwd: true' to override.`
      );
    }
  };

  // 1. Check path traversal for file tools
  if (
    [
      'read_file',
      'read_file_lines',
      'write_file',
      'append_file',
      'list_files',
      'search_files',
      'search_content',
      'ast_grep_search',
      'ast_grep_replace',
    ].includes(toolName)
  ) {
    const rawPath = args.path || args.dir || '.';
    assertWithinCwd(rawPath);

    // For AST tools, validate all paths in the array
    if (['ast_grep_search', 'ast_grep_replace'].includes(toolName) && Array.isArray(args.paths)) {
      for (const p of args.paths) {
        assertWithinCwd(p);
      }
    }
  }

  // 2. Check shell risk for run_command and guard working directory
  if (toolName === 'run_command') {
    assertWithinCwd(args.dir, 'Directory');
    if (!options.allowInsecure && detectShellInjectionRisk(args.command)) {
      throw new Error(
        `Security Error: Command contains risky shell characters. Use 'allowInsecure: true' on the llm step to execute this.`
      );
    }
  }
}
