import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTool } from '../parser/schema';
import { LIMITS, TIMEOUTS } from '../utils/constants';
import { detectShellInjectionRisk } from './shell-executor';

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
      id: 'std_search_files',
      type: 'script',
      run: `
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const { globSync } = require('glob');
          const dir = args.dir || '.';
          const pattern = args.pattern;
          try {
            return globSync(pattern, { cwd: dir, nodir: true });
          } catch (e) {
            throw new Error('Search failed: ' + e.message);
          }
        })();
      `,
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
        (function() {
          const fs = require('node:fs');
          const path = require('node:path');
          const { globSync } = require('glob');
          const dir = args.dir || '.';
          const pattern = args.pattern || '**/*';
          const query = args.query;
          const Re2 = (() => {
            try {
              return require('re2');
            } catch {
              return null;
            }
          })();
          const maxQueryLength = ${LIMITS.MAX_SEARCH_QUERY_LENGTH};
          const maxPatternLength = ${LIMITS.MAX_REGEX_PATTERN_LENGTH};
          const maxResults = ${LIMITS.MAX_SEARCH_RESULTS};
          const maxFileBytes = ${LIMITS.MAX_SEARCH_FILE_BYTES};
          const maxLineLength = ${LIMITS.MAX_SEARCH_LINE_LENGTH};
          const regexTimeoutMs = ${TIMEOUTS.REGEX_TIMEOUT_MS};

          if (query.length > maxQueryLength) {
            throw new Error('Search query exceeds maximum length of ' + maxQueryLength + ' characters');
          }

          const isRegex = query.startsWith('/') && query.endsWith('/') && query.length > 1;
          let regex;
          let normalizedQuery = '';
          let regexDeadline;
          
          // ReDoS protection: detect dangerous regex patterns
          if (isRegex) {
            const pattern = query.slice(1, -1);
            if (pattern.length > maxPatternLength) {
              throw new Error('Regex pattern exceeds maximum length of ' + maxPatternLength + ' characters');
            }
            // Detect common ReDoS patterns: nested quantifiers, overlapping alternations
            const dangerousPatterns = [
              /\\([^)]*(?:[+*]|\\{\\d+(?:,\\d*)?\\})[^)]*\\)(?:[+*]|\\{\\d+(?:,\\d*)?\\})/, // (x+)+, (x{1,3})*
              /\\([^)]*\\|[^)]*\\)(?:[+*]|\\{\\d+(?:,\\d*)?\\})/, // (a|aa)+
              /(?:[+*]|\\{\\d+(?:,\\d*)?\\}){2,}/, // consecutive quantifiers
            ];
            if (dangerousPatterns.some(p => p.test(pattern))) {
              throw new Error('Regex pattern contains potentially dangerous constructs (possible ReDoS). Simplify the pattern.');
            }

            try {
              regex = Re2 ? new Re2(pattern) : new RegExp(pattern);
            } catch (e) {
              throw new Error('Invalid regular expression: ' + e.message);
            }

          } else {
            normalizedQuery = query.toLowerCase();
          }
  
          const files = globSync(pattern, { cwd: dir, nodir: true });
          const results = [];
          for (const file of files) {
            if (isRegex) {
              regexDeadline = Date.now() + regexTimeoutMs;
            }
            const fullPath = path.join(dir, file);
            let stat;
            try {
              stat = fs.statSync(fullPath);
            } catch {
              continue;
            }
            if (stat.size > maxFileBytes) {
              continue;
            }
            let content;
            try {
              content = fs.readFileSync(fullPath, 'utf8');
            } catch {
              continue;
            }
            const lines = content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              if (regexDeadline && Date.now() > regexDeadline) {
                throw new Error('Regex search exceeded time limit');
              }
              const line = lines[i];
              if (line.length > maxLineLength) {
                continue;
              }
              const matched = isRegex ? regex.test(line) : line.toLowerCase().includes(normalizedQuery);
              if (matched) {
                results.push({
                  file,
                  line: i + 1,
                  content: line.trim()
                });
              }
              if (results.length >= maxResults) break;
            }
            if (results.length >= maxResults) break;
          }
          return results;
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
];

/**
 * Validate that a tool call is safe to execute based on the LLM step's security flags.
 */
export function validateStandardToolSecurity(
  toolName: string,
  // biome-ignore lint/suspicious/noExplicitAny: arguments can be any shape
  args: any,
  options: { allowOutsideCwd?: boolean; allowInsecure?: boolean }
): void {
  // 1. Check path traversal for file tools
  if (
    [
      'read_file',
      'read_file_lines',
      'write_file',
      'list_files',
      'search_files',
      'search_content',
    ].includes(toolName)
  ) {
    const rawPath = args.path || args.dir || '.';
    const cwd = process.cwd();
    const resolvedPath = path.resolve(cwd, rawPath);
    const realCwd = fs.realpathSync(cwd);

    const isWithin = (target: string) => {
      // Find the first existing ancestor to resolve the real path correctly
      let current = target;
      while (current !== path.dirname(current) && !fs.existsSync(current)) {
        current = path.dirname(current);
      }
      const realTarget = fs.existsSync(current) ? fs.realpathSync(current) : current;
      const relativePath = path.relative(realCwd, realTarget);
      return !(relativePath.startsWith('..') || path.isAbsolute(relativePath));
    };

    if (!options.allowOutsideCwd && !isWithin(resolvedPath)) {
      throw new Error(
        `Access denied: Path '${rawPath}' resolves outside the working directory. Use 'allowOutsideCwd: true' to override.`
      );
    }
  }

  // 2. Check shell risk for run_command
  if (toolName === 'run_command' && !options.allowInsecure) {
    if (detectShellInjectionRisk(args.command)) {
      throw new Error(
        `Security Error: Command contains risky shell characters. Use 'allowInsecure: true' on the llm step to execute this.`
      );
    }
  }
}
