import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
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

  /**
   * Find the project root by looking for common project markers
   */
  static findProjectRoot(startPath: string): string {
    const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', '.keystone'];
    let current = path.resolve(startPath);
    const root = path.parse(current).root;

    while (current !== root) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(current, marker))) {
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
  static scanDirectoryContext(dir: string, depth = 3): Omit<ContextData, 'cursorRules'> {
    const result: Omit<ContextData, 'cursorRules'> = {};
    const projectRoot = ContextInjector.findProjectRoot(dir);
    let current = path.resolve(dir);

    // Walk from current dir up to project root, limited by depth
    for (let i = 0; i < depth && current.length >= projectRoot.length; i++) {
      // Check for README.md (only use first one found, closest to working dir)
      if (!result.readme) {
        const readmePath = path.join(current, 'README.md');
        if (fs.existsSync(readmePath)) {
          try {
            result.readme = fs.readFileSync(readmePath, 'utf-8');
          } catch {
            // Ignore read errors
          }
        }
      }

      // Check for AGENTS.md (only use first one found, closest to working dir)
      if (!result.agentsMd) {
        const agentsMdPath = path.join(current, 'AGENTS.md');
        if (fs.existsSync(agentsMdPath)) {
          try {
            result.agentsMd = fs.readFileSync(agentsMdPath, 'utf-8');
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
  static scanRules(filesAccessed: string[]): string[] {
    const rules: string[] = [];
    const rulesDirs = ['.cursor/rules', '.claude/rules'];
    const projectRoot =
      filesAccessed.length > 0
        ? ContextInjector.findProjectRoot(path.dirname(filesAccessed[0]))
        : process.cwd();

    for (const rulesDir of rulesDirs) {
      const rulesPath = path.join(projectRoot, rulesDir);
      if (!fs.existsSync(rulesPath)) continue;

      try {
        const files = fs.readdirSync(rulesPath);
        for (const file of files) {
          const rulePath = path.join(rulesPath, file);
          if (!fs.statSync(rulePath).isFile()) continue;

          const content = fs.readFileSync(rulePath, 'utf-8');

          // Check if rule applies to any of the accessed files
          // Rules can have a glob pattern on the first line prefixed with "applies:"
          const firstLine = content.split('\n')[0];
          if (firstLine.startsWith('applies:')) {
            const pattern = firstLine.slice('applies:'.length).trim();
            const matchesAny = filesAccessed.some((f) => {
              const relativePath = path.relative(projectRoot, f);
              try {
                const matches = globSync(pattern, { cwd: projectRoot });
                return matches.includes(relativePath);
              } catch {
                return false;
              }
            });
            if (!matchesAny) continue;
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
  static getContext(
    dir: string,
    filesAccessed: string[],
    config?: ContextInjectorConfig
  ): ContextData {
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
      const dirContext = ContextInjector.scanDirectoryContext(dir, effectiveConfig.search_depth);
      if (effectiveConfig.sources.includes('readme')) {
        context.readme = dirContext.readme;
      }
      if (effectiveConfig.sources.includes('agents_md')) {
        context.agentsMd = dirContext.agentsMd;
      }
    }

    if (effectiveConfig.sources.includes('cursor_rules')) {
      context.cursorRules = ContextInjector.scanRules(filesAccessed);
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
