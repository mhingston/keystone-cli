import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STANDARD_TOOLS, validateStandardToolSecurity } from './standard-tools';

describe('Standard Tools Security', () => {
  const options = { allowOutsideCwd: false, allowInsecure: false };

  it('should allow paths within CWD', () => {
    expect(() => {
      validateStandardToolSecurity('read_file', { path: 'src/cli.ts' }, options);
    }).not.toThrow();
    expect(() => {
      validateStandardToolSecurity('search_files', { pattern: '**/*.ts', dir: 'src' }, options);
    }).not.toThrow();
  });

  it('should block paths outside CWD by default', () => {
    expect(() => {
      validateStandardToolSecurity('read_file', { path: '../../etc/passwd' }, options);
    }).toThrow(/Access denied/);
    expect(() => {
      validateStandardToolSecurity('read_file_lines', { path: '../../etc/passwd' }, options);
    }).toThrow(/Access denied/);
    expect(() => {
      validateStandardToolSecurity('search_files', { pattern: '*', dir: '/etc' }, options);
    }).toThrow(/Access denied/);
  });

  it('should allow paths outside CWD if allowOutsideCwd is true', () => {
    expect(() => {
      validateStandardToolSecurity(
        'read_file',
        { path: '../../etc/passwd' },
        { allowOutsideCwd: true }
      );
    }).not.toThrow();
  });

  it('should block risky commands by default', () => {
    expect(() => {
      validateStandardToolSecurity('run_command', { command: 'ls; rm -rf /' }, options);
    }).toThrow(/Security Error/);
  });

  it('should allow risky commands if allowInsecure is true', () => {
    expect(() => {
      validateStandardToolSecurity(
        'run_command',
        { command: 'ls; rm -rf /' },
        { allowInsecure: true }
      );
    }).not.toThrow();
  });
});

describe('Standard Tools Definition', () => {
  it('should have read_file tool', () => {
    const readTool = STANDARD_TOOLS.find((t) => t.name === 'read_file');
    expect(readTool).toBeDefined();
    expect(readTool?.execution?.type).toBe('file');
  });

  it('should have list_files tool with script execution', () => {
    const listTool = STANDARD_TOOLS.find((t) => t.name === 'list_files');
    expect(listTool).toBeDefined();
    expect(listTool?.execution?.type).toBe('script');
  });
});
