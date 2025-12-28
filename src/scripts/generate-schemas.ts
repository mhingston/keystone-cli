import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentSchema, WorkflowSchema } from '../parser/schema';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const schemasDir = join(process.cwd(), 'schemas');

console.log('Generating schemas...');

// Workflow Schema
const workflowJson = zodToJsonSchema(WorkflowSchema, 'keystone-workflow');
writeFileSync(join(schemasDir, 'workflow.json'), JSON.stringify(workflowJson, null, 2));
console.log('Written schemas/workflow.json');

// Agent Schema
// We omit systemPrompt because it comes from the markdown body, not the frontmatter
const agentFrontmatterSchema = AgentSchema.omit({ systemPrompt: true });
const agentJson = zodToJsonSchema(agentFrontmatterSchema, 'keystone-agent');
writeFileSync(join(schemasDir, 'agent.json'), JSON.stringify(agentJson, null, 2));
console.log('Written schemas/agent.json');

console.log('Done.');
