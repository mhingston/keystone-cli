import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextInjector } from './context-injector';

describe('ContextInjector', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-injector-test-'));
    ContextInjector.clearCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findProjectRoot', () => {
    it('should find project root with .git directory', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      const subDir = path.join(tempDir, 'src', 'components');
      fs.mkdirSync(subDir, { recursive: true });

      const root = await ContextInjector.findProjectRoot(subDir);
      expect(root).toBe(tempDir);
    });

    it('should find project root with package.json', async () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
      const subDir = path.join(tempDir, 'lib');
      fs.mkdirSync(subDir, { recursive: true });

      const root = await ContextInjector.findProjectRoot(subDir);
      expect(root).toBe(tempDir);
    });

    it('should return start path if no marker found', async () => {
      const subDir = path.join(tempDir, 'nomarker');
      fs.mkdirSync(subDir, { recursive: true });

      const root = await ContextInjector.findProjectRoot(subDir);
      expect(root).toBe(subDir);
    });
  });

  describe('scanDirectoryContext', () => {
    it('should find README.md in parent directory', async () => {
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test Project');
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.git')); // Mark project root

      const context = await ContextInjector.scanDirectoryContext(subDir, 3);
      expect(context.readme).toBe('# Test Project');
    });

    it('should find AGENTS.md in parent directory', async () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Agent Guidelines');
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.git'));

      const context = await ContextInjector.scanDirectoryContext(subDir, 3);
      expect(context.agentsMd).toBe('# Agent Guidelines');
    });

    it('should prefer closer files over distant ones', async () => {
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Root README');
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'README.md'), '# Src README');
      fs.mkdirSync(path.join(tempDir, '.git'));

      const context = await ContextInjector.scanDirectoryContext(subDir, 3);
      expect(context.readme).toBe('# Src README');
    });

    it('should respect depth limit', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Root README');
      const deepDir = path.join(tempDir, 'a', 'b', 'c', 'd');
      fs.mkdirSync(deepDir, { recursive: true });

      // With depth 2, shouldn't find the README that's 4 levels up
      const context = await ContextInjector.scanDirectoryContext(deepDir, 2);
      expect(context.readme).toBeUndefined();
    });
  });

  describe('scanRules', () => {
    it('should find cursor rules', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.mkdirSync(path.join(tempDir, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.cursor', 'rules', 'general.md'),
        'Always use TypeScript'
      );

      const rules = await ContextInjector.scanRules([path.join(tempDir, 'src', 'test.ts')]);
      expect(rules).toContain('Always use TypeScript');
    });

    it('should find claude rules', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.mkdirSync(path.join(tempDir, '.claude', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.claude', 'rules', 'style.md'), 'Use 2 spaces');

      const rules = await ContextInjector.scanRules([path.join(tempDir, 'src', 'test.ts')]);
      expect(rules).toContain('Use 2 spaces');
    });

    it('should return empty array if no rules directory', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      const rules = await ContextInjector.scanRules([path.join(tempDir, 'src', 'test.ts')]);
      expect(rules).toEqual([]);
    });
  });

  describe('generateSystemPromptAddition', () => {
    it('should format AGENTS.md content', () => {
      const addition = ContextInjector.generateSystemPromptAddition({
        agentsMd: '# Guidelines\nFollow these rules',
      });
      expect(addition).toContain('=== AGENTS.MD');
      expect(addition).toContain('# Guidelines');
    });

    it('should format README content with truncation marker for long content', () => {
      const longReadme = 'x'.repeat(3000);
      const addition = ContextInjector.generateSystemPromptAddition({
        readme: longReadme,
      });
      expect(addition).toContain('=== README.md');
      expect(addition).toContain('[... README truncated ...]');
      expect(addition.length).toBeLessThan(3000);
    });

    it('should format cursor rules', () => {
      const addition = ContextInjector.generateSystemPromptAddition({
        cursorRules: ['Rule 1', 'Rule 2'],
      });
      expect(addition).toContain('=== Project Rules');
      expect(addition).toContain('Rule 1');
      expect(addition).toContain('Rule 2');
    });

    it('should return empty string for empty context', () => {
      const addition = ContextInjector.generateSystemPromptAddition({});
      expect(addition).toBe('');
    });
  });

  describe('getContext', () => {
    it('should return empty context when disabled', async () => {
      const context = await ContextInjector.getContext(tempDir, [], {
        enabled: false,
        search_depth: 3,
        sources: ['readme', 'agents_md', 'cursor_rules'],
      });
      expect(context).toEqual({});
    });

    it('should only return requested sources', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test');
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Agents');

      const context = await ContextInjector.getContext(tempDir, [], {
        enabled: true,
        search_depth: 3,
        sources: ['readme'],
      });
      expect(context.readme).toBe('# Test');
      expect(context.agentsMd).toBeUndefined();
    });

    it('should use cache on repeated calls', async () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Original');

      const config = {
        enabled: true,
        search_depth: 3,
        sources: ['readme'] as ('readme' | 'agents_md' | 'cursor_rules')[],
      };

      // First call
      const context1 = await ContextInjector.getContext(tempDir, [], config);
      expect(context1.readme).toBe('# Original');

      // Modify file
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Modified');

      // Second call should return cached value
      const context2 = await ContextInjector.getContext(tempDir, [], config);
      expect(context2.readme).toBe('# Original');
    });
  });
});
