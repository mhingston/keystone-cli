import { existsSync } from 'node:fs'; // Keep for synchronous fallbacks if absolutely needed, but prefer async
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { ConfigLoader } from './config-loader';

export interface ContextData {
  readme?: string;
  agentsMd?: string;
  cursorRules?: string[];
}

export interface ContextInjectorConfig {
  enabled: boolean;
  search_depth: number;
  sources: ('readme' | 'agents_md' | 'cursor_rules')[];
}

/**
 * Utility for discovering and injecting project context (README.md, AGENTS.md, .cursor/rules)
 * into LLM system prompts.
 */
export class ContextInjector {
  private static contextCache = new Map<string, { context: ContextData; timestamp: number }>();
  private static CACHE_TTL_MS = 60000; // 1 minute cache

  // Helper to check file existence asynchronously
  private static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find the project root by looking for common project markers
   */
  static async findProjectRoot(startPath: string): Promise<string> {
    const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', '.keystone'];
    let current = path.resolve(startPath);
    const root = path.parse(current).root;

    while (current !== root) {
      for (const marker of markers) {
        if (await ContextInjector.exists(path.join(current, marker))) {
          return current;
        }
      }
      current = path.dirname(current);
    }

    return startPath; // Fallback to original path if no marker found
  }

  /**
   * Scan directories for README.md and AGENTS.md files
   */
  static async scanDirectoryContext(
    dir: string,
    depth = 3
  ): Promise<Omit<ContextData, 'cursorRules'>> {
    const result: Omit<ContextData, 'cursorRules'> = {};
    const projectRoot = await ContextInjector.findProjectRoot(dir);
    let current = path.resolve(dir);

    // Walk from current dir up to project root, limited by depth
    for (let i = 0; i < depth && current.length >= projectRoot.length; i++) {
      // Check for README.md (only use first one found, closest to working dir)
      if (!result.readme) {
        const readmePath = path.join(current, 'README.md');
        if (await ContextInjector.exists(readmePath)) {
          try {
            result.readme = await fs.readFile(readmePath, 'utf-8');
          } catch {
            // Ignore read errors
          }
        }
      }

      // Check for AGENTS.md (only use first one found, closest to working dir)
      if (!result.agentsMd) {
        const agentsMdPath = path.join(current, 'AGENTS.md');
        if (await ContextInjector.exists(agentsMdPath)) {
          try {
            result.agentsMd = await fs.readFile(agentsMdPath, 'utf-8');
          } catch {
            // Ignore read errors
          }
        }
      }

      // Move up one directory
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return result;
  }

  /**
   * Scan for .cursor/rules or .claude/rules files that apply to accessed files
   */
  static async scanRules(filesAccessed: string[]): Promise<string[]> {
    const rules: string[] = [];
    const rulesDirs = ['.cursor/rules', '.claude/rules'];

    let projectRoot = process.cwd();
    if (filesAccessed.length > 0) {
      projectRoot = await ContextInjector.findProjectRoot(path.dirname(filesAccessed[0]));
    }

    for (const rulesDir of rulesDirs) {
      const rulesPath = path.join(projectRoot, rulesDir);
      if (!(await ContextInjector.exists(rulesPath))) continue;

      try {
        const files = await fs.readdir(rulesPath);
        for (const file of files) {
          const rulePath = path.join(rulesPath, file);
          const stats = await fs.stat(rulePath);
          if (!stats.isFile()) continue;

          const content = await fs.readFile(rulePath, 'utf-8');

          // Check if rule applies to any of the accessed files
          // Rules can have a glob pattern on the first line prefixed with "applies:"
          const firstLine = content.split('\n')[0];
          if (firstLine.startsWith('applies:')) {
            const pattern = firstLine.slice('applies:'.length).trim();
            const matchesAny = filesAccessed.some((f) => {
              const relativePath = path.relative(projectRoot, f);
              try {
                // Using synchronous glob logic for pattern matching against specific files is tricky with 'glob' package
                // 'glob' package usually searches the filesystem.
                // We want minimatch-style matching.
                // Typically 'glob' exports 'minimatch' or we use 'minimatch' package.
                // Assuming we can fallback to checking if the file matches the glob by expanding the glob?
                // Or simplified: use glob to find files matching pattern and see if ours is in it.
                // NOTE: For performance, ideally we'd use 'minimatch'. But we don't know if it's installed.
                // We'll stick to 'glob' to list matches and check inclusion.
                // This might be slow if the glob matches EVERYTHING.
                // Optimization: If pattern is simple, maybe regex.
                // Given constraints, we will attempt to limit the scope or assume 'glob' is efficient enough.
                // Actually, 'glob' function is async.
                return false; // Placeholder, real impl below
              } catch {
                return false;
              }
            });

            // Use minimatch to check if the file matches the pattern
            // This avoids scanning the entire filesystem with glob
            const relativePath = path.relative(projectRoot, filesAccessed[0]); // Check the first file for now, or loop all

            // Note: In real usage, we should probably check against ALL accessed files.
            // The current logic only checked filesAccessed vs the glob list.
            const isMatch = filesAccessed.some((f) =>
              minimatch(path.relative(projectRoot, f), pattern)
            );

            if (!isMatch) continue;
          }

          rules.push(content);
        }
      } catch {
        // Ignore errors reading rules directory
      }
    }

    return rules;
  }

  /**
   * Generate the system prompt addition from context data
   */
  static generateSystemPromptAddition(context: ContextData): string {
    const parts: string[] = [];

    if (context.agentsMd) {
      parts.push('=== AGENTS.MD (Project AI Guidelines) ===');
      parts.push(context.agentsMd);
      parts.push('');
    }

    if (context.readme) {
      // Truncate README to first 2000 chars to avoid overwhelming the context
      const truncatedReadme =
        context.readme.length > 2000
          ? `${context.readme.slice(0, 2000)}\n[... README truncated ...]`
          : context.readme;
      parts.push('=== README.md (Project Overview) ===');
      parts.push(truncatedReadme);
      parts.push('');
    }

    if (context.cursorRules && context.cursorRules.length > 0) {
      parts.push('=== Project Rules ===');
      for (const rule of context.cursorRules) {
        parts.push(rule);
        parts.push('---');
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Get context for a directory, using cache if available
   */
  static async getContext(
    dir: string,
    filesAccessed: string[],
    config?: ContextInjectorConfig
  ): Promise<ContextData> {
    // Default config from ConfigLoader
    let effectiveConfig = config;
    if (!effectiveConfig) {
      try {
        const appConfig = ConfigLoader.load();
        const contextConfig = appConfig.features?.context_injection;
        if (!contextConfig?.enabled) {
          return {};
        }
        effectiveConfig = {
          enabled: contextConfig.enabled,
          search_depth: contextConfig.search_depth ?? 3,
          sources: contextConfig.sources ?? ['readme', 'agents_md', 'cursor_rules'],
        };
      } catch {
        return {};
      }
    }

    if (!effectiveConfig.enabled) {
      return {};
    }

    // Check cache
    const cacheKey = dir;
    const cached = ContextInjector.contextCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ContextInjector.CACHE_TTL_MS) {
      return cached.context;
    }

    // Build context based on sources
    const context: ContextData = {};

    if (
      effectiveConfig.sources.includes('readme') ||
      effectiveConfig.sources.includes('agents_md')
    ) {
      const dirContext = await ContextInjector.scanDirectoryContext(
        dir,
        effectiveConfig.search_depth
      );
      if (effectiveConfig.sources.includes('readme')) {
        context.readme = dirContext.readme;
      }
      if (effectiveConfig.sources.includes('agents_md')) {
        context.agentsMd = dirContext.agentsMd;
      }
    }

    if (effectiveConfig.sources.includes('cursor_rules')) {
      context.cursorRules = await ContextInjector.scanRules(filesAccessed);
    }

    // Cache the result
    ContextInjector.contextCache.set(cacheKey, { context, timestamp: Date.now() });

    return context;
  }

  /**
   * Clear the context cache
   */
  static clearCache(): void {
    ContextInjector.contextCache.clear();
  }
}
