import { homedir } from 'node:os';
import { join } from 'node:path';
import { WorkflowParser } from '../parser/workflow-parser.ts';
import { ConsoleLogger } from './logger.ts';
import { ResourceLoader } from './resource-loader.ts';

export class WorkflowRegistry {
  private static logger = new ConsoleLogger();

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
      if (!ResourceLoader.exists(dir)) continue;

      try {
        const files = ResourceLoader.listDirectory(dir);
        for (const file of files) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

          const fullPath = join(dir, file);
          if (ResourceLoader.isDirectory(fullPath)) continue;

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
        WorkflowRegistry.logger.warn(`Failed to scan directory ${dir}: ${String(e)}`);
      }
    }

    return workflows;
  }

  /**
   * Resolve a workflow name to a file path
   */
  static resolvePath(name: string, baseDir?: string): string {
    // 1. Check if it's already a path
    if (ResourceLoader.exists(name) && (name.endsWith('.yaml') || name.endsWith('.yml'))) {
      return name;
    }

    // 2. Check relative to baseDir if name ends with yaml/yml
    if (baseDir && (name.endsWith('.yaml') || name.endsWith('.yml'))) {
      const fullPath = join(baseDir, name);
      if (ResourceLoader.exists(fullPath)) return fullPath;
    }

    const searchPaths = WorkflowRegistry.getSearchPaths();
    if (baseDir) {
      searchPaths.unshift(baseDir);
      // Also check .keystone/workflows relative to baseDir if any
      const relativeKeystone = join(baseDir, '.keystone', 'workflows');
      if (ResourceLoader.exists(relativeKeystone)) searchPaths.unshift(relativeKeystone);
    }

    // 3. Search by filename in standard dirs
    for (const dir of searchPaths) {
      if (!ResourceLoader.exists(dir)) continue;

      // Check exact filename match (name.yaml) - only if name doesn't already HAVE extension
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
        const pathYaml = join(dir, `${name}.yaml`);
        if (ResourceLoader.exists(pathYaml)) return pathYaml;

        const pathYml = join(dir, `${name}.yml`);
        if (ResourceLoader.exists(pathYml)) return pathYml;
      } else {
        // Just check if name exists in this dir
        const fullPath = join(dir, name);
        if (ResourceLoader.exists(fullPath)) return fullPath;
      }
    }

    // 4. Search by internal workflow name
    for (const dir of searchPaths) {
      if (!ResourceLoader.exists(dir)) continue;

      try {
        const files = ResourceLoader.listDirectory(dir);
        for (const file of files) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

          const fullPath = join(dir, file);
          if (ResourceLoader.isDirectory(fullPath)) continue;

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
