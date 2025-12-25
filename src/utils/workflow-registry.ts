import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { Workflow } from '../parser/schema.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { ConfigLoader } from './config-loader.ts';

export class WorkflowRegistry {
  private static getSearchPaths(): string[] {
    const paths = new Set<string>();

    paths.add(join(process.cwd(), '.keystone', 'workflows'));
    paths.add(join(homedir(), '.keystone', 'workflows'));

    return Array.from(paths);
  }

  /**
   * List all available workflows with their metadata
   */
  static listWorkflows(): Array<{
    name: string;
    description?: string;
    inputs?: Record<string, unknown>;
  }> {
    const workflows: Array<{
      name: string;
      description?: string;
      inputs?: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();

    for (const dir of WorkflowRegistry.getSearchPaths()) {
      if (!existsSync(dir)) continue;

      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

          const fullPath = join(dir, file);
          if (statSync(fullPath).isDirectory()) continue;

          try {
            // Parse strictly to get metadata
            const workflow = WorkflowParser.loadWorkflow(fullPath);

            // Deduplicate by name
            if (seen.has(workflow.name)) continue;
            seen.add(workflow.name);

            workflows.push({
              name: workflow.name,
              description: workflow.description,
              inputs: workflow.inputs,
            });
          } catch (e) {
            // Skip invalid workflows during listing
          }
        }
      } catch (e) {
        console.warn(`Failed to scan directory ${dir}:`, e);
      }
    }

    return workflows;
  }

  /**
   * Resolve a workflow name to a file path
   */
  static resolvePath(name: string, baseDir?: string): string {
    // 1. Check if it's already a path
    if (existsSync(name) && (name.endsWith('.yaml') || name.endsWith('.yml'))) {
      return name;
    }

    // 2. Check relative to baseDir if name ends with yaml/yml
    if (baseDir && (name.endsWith('.yaml') || name.endsWith('.yml'))) {
      const fullPath = join(baseDir, name);
      if (existsSync(fullPath)) return fullPath;
    }

    const searchPaths = WorkflowRegistry.getSearchPaths();
    if (baseDir) {
      searchPaths.unshift(baseDir);
      // Also check .keystone/workflows relative to baseDir if any
      const relativeKeystone = join(baseDir, '.keystone', 'workflows');
      if (existsSync(relativeKeystone)) searchPaths.unshift(relativeKeystone);
    }

    // 3. Search by filename in standard dirs
    for (const dir of searchPaths) {
      if (!existsSync(dir)) continue;

      // Check exact filename match (name.yaml) - only if name doesn't already HAVE extension
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
        const pathYaml = join(dir, `${name}.yaml`);
        if (existsSync(pathYaml)) return pathYaml;

        const pathYml = join(dir, `${name}.yml`);
        if (existsSync(pathYml)) return pathYml;
      } else {
        // Just check if name exists in this dir
        const fullPath = join(dir, name);
        if (existsSync(fullPath)) return fullPath;
      }
    }

    // 4. Search by internal workflow name
    for (const dir of searchPaths) {
      if (!existsSync(dir)) continue;

      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

          const fullPath = join(dir, file);
          const stats = statSync(fullPath);
          if (stats.isDirectory()) continue;

          try {
            const workflow = WorkflowParser.loadWorkflow(fullPath);
            if (workflow.name === name) {
              return fullPath;
            }
          } catch (e) {
            // Skip invalid workflows
          }
        }
      } catch (e) {
        // Skip errors scanning directories
      }
    }

    throw new Error(`Workflow "${name}" not found in: ${searchPaths.join(', ')}`);
  }
}
