import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { type Agent, AgentSchema } from './schema';
import { ResourceLoader } from '../utils/resource-loader';

export function parseAgent(filePath: string): Agent {
  const content = ResourceLoader.readFile(filePath);
  if (content === null) {
    throw new Error(`Agent file not found at ${filePath}`);
  }
  // Flexible regex to handle both standard and single-line frontmatter
  const match = content.match(/^---[\r\n]*([\s\S]*?)[\r\n]*---(?:\r?\n?([\s\S]*))?$/);

  if (!match) {
    throw new Error(`Invalid agent format in ${filePath}. Missing frontmatter.`);
  }

  const frontmatter = yaml.load(match[1]) as Record<string, unknown>;

  // Inject IDs into tool executions if missing
  if (frontmatter.tools && Array.isArray(frontmatter.tools)) {
    frontmatter.tools = frontmatter.tools.map((tool: unknown) => {
      const t = tool as Record<string, unknown>;
      if (t.execution && typeof t.execution === 'object') {
        const exec = t.execution as Record<string, unknown>;
        if (!exec.id) {
          exec.id = `tool-${t.name || 'unknown'}`;
        }
      }
      return t;
    });
  }

  const systemPrompt = match[2]?.trim() || '';

  const agentData = {
    ...frontmatter,
    systemPrompt,
  };

  const result = AgentSchema.safeParse(agentData);
  if (!result.success) {
    throw new Error(`Invalid agent definition in ${filePath}: ${result.error.message}`);
  }

  return result.data;
}

export function resolveAgentPath(agentName: string, baseDir?: string): string {
  const possiblePaths: string[] = [];

  if (baseDir) {
    possiblePaths.push(join(baseDir, 'agents', `${agentName}.md`));
    possiblePaths.push(join(baseDir, '..', 'agents', `${agentName}.md`));
  }

  possiblePaths.push(
    join(process.cwd(), '.keystone', 'workflows', 'agents', `${agentName}.md`),
    join(homedir(), '.keystone', 'workflows', 'agents', `${agentName}.md`)
  );

  for (const path of possiblePaths) {
    if (ResourceLoader.exists(path)) {
      return path;
    }
  }

  throw new Error(`Agent "${agentName}" not found. Expected one of:\n${possiblePaths.join('\n')}`);
}
