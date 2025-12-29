/**
 * keystone init command
 * Initialize a new Keystone project
 */

import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';

import exploreAgent from '../templates/agents/explore.md' with { type: 'text' };
import generalAgent from '../templates/agents/general.md' with { type: 'text' };
import handoffRouterAgent from '../templates/agents/handoff-router.md' with { type: 'text' };
import handoffSpecialistAgent from '../templates/agents/handoff-specialist.md' with {
  type: 'text',
};
import architectAgent from '../templates/agents/keystone-architect.md' with { type: 'text' };
import softwareEngineerAgent from '../templates/agents/software-engineer.md' with { type: 'text' };
import summarizerAgent from '../templates/agents/summarizer.md' with { type: 'text' };
import testerAgent from '../templates/agents/tester.md' with { type: 'text' };
import fullFeatureDemo from '../templates/basics/full-feature-demo.yaml' with { type: 'text' };
import idempotencyExample from '../templates/control-flow/idempotency-example.yaml' with {
  type: 'text',
};
import artifactExample from '../templates/features/artifact-example.yaml' with { type: 'text' };
import scriptExample from '../templates/features/script-example.yaml' with { type: 'text' };
// Import templates
import agentHandoffWorkflow from '../templates/patterns/agent-handoff.yaml' with { type: 'text' };
import decomposeImplementWorkflow from '../templates/scaffolding/decompose-implement.yaml' with {
  type: 'text',
};
import decomposeWorkflow from '../templates/scaffolding/decompose-problem.yaml' with {
  type: 'text',
};
import decomposeResearchWorkflow from '../templates/scaffolding/decompose-research.yaml' with {
  type: 'text',
};
import decomposeReviewWorkflow from '../templates/scaffolding/decompose-review.yaml' with {
  type: 'text',
};
import devWorkflow from '../templates/scaffolding/dev.yaml' with { type: 'text' };
import reviewLoopWorkflow from '../templates/scaffolding/review-loop.yaml' with { type: 'text' };
import scaffoldWorkflow from '../templates/scaffolding/scaffold-feature.yaml' with { type: 'text' };
import scaffoldGenerateWorkflow from '../templates/scaffolding/scaffold-generate.yaml' with {
  type: 'text',
};
import scaffoldPlanWorkflow from '../templates/scaffolding/scaffold-plan.yaml' with {
  type: 'text',
};

const DEFAULT_CONFIG = `# Keystone Configuration
default_provider: openai

providers:
  openai:
    type: openai
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    default_model: gpt-4o
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com/v1
    api_key_env: ANTHROPIC_API_KEY
    default_model: claude-3-5-sonnet-20240620
  groq:
    type: openai
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY
    default_model: llama-3.3-70b-versatile

model_mappings:
  "gpt-*": openai
  "claude-*": anthropic
  "o1-*": openai
  "llama-*": groq

# mcp_servers:
#   filesystem:
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

# engines:
#   allowlist:
#     codex:
#       command: codex
#       version: "1.2.3"
#       versionArgs: ["--version"]

storage:
  retention_days: 30

expression:
  strict: false
`;

const ENV_TEMPLATE = `# API Keys and Secrets
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
`;

const SEEDS = [
  { path: '.keystone/workflows/scaffold-feature.yaml', content: scaffoldWorkflow },
  { path: '.keystone/workflows/scaffold-plan.yaml', content: scaffoldPlanWorkflow },
  { path: '.keystone/workflows/scaffold-generate.yaml', content: scaffoldGenerateWorkflow },
  { path: '.keystone/workflows/decompose-problem.yaml', content: decomposeWorkflow },
  { path: '.keystone/workflows/decompose-research.yaml', content: decomposeResearchWorkflow },
  { path: '.keystone/workflows/decompose-implement.yaml', content: decomposeImplementWorkflow },
  { path: '.keystone/workflows/decompose-review.yaml', content: decomposeReviewWorkflow },
  { path: '.keystone/workflows/review-loop.yaml', content: reviewLoopWorkflow },
  { path: '.keystone/workflows/agent-handoff.yaml', content: agentHandoffWorkflow },
  { path: '.keystone/workflows/agents/keystone-architect.md', content: architectAgent },
  { path: '.keystone/workflows/agents/general.md', content: generalAgent },
  { path: '.keystone/workflows/agents/explore.md', content: exploreAgent },
  { path: '.keystone/workflows/agents/software-engineer.md', content: softwareEngineerAgent },
  { path: '.keystone/workflows/agents/summarizer.md', content: summarizerAgent },
  { path: '.keystone/workflows/agents/handoff-router.md', content: handoffRouterAgent },
  { path: '.keystone/workflows/agents/handoff-specialist.md', content: handoffSpecialistAgent },
  { path: '.keystone/workflows/dev.yaml', content: devWorkflow },
  { path: '.keystone/workflows/agents/tester.md', content: testerAgent },
  { path: '.keystone/workflows/script-example.yaml', content: scriptExample },
  { path: '.keystone/workflows/artifact-example.yaml', content: artifactExample },
  { path: '.keystone/workflows/idempotency-example.yaml', content: idempotencyExample },
  { path: '.keystone/workflows/full-feature-demo.yaml', content: fullFeatureDemo },
];

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new Keystone project')
    .action(async () => {
      console.log('🏛️  Initializing Keystone project...\n');

      // Helper to check existence
      const exists = async (path: string) => {
        try {
          await access(path, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      };

      // Create directories
      const dirs = ['.keystone', '.keystone/workflows', '.keystone/workflows/agents'];
      for (const dir of dirs) {
        if (!(await exists(dir))) {
          await mkdir(dir, { recursive: true });
          console.log(`✓ Created ${dir}/`);
        } else {
          console.log(`⊘ ${dir}/ already exists`);
        }
      }

      // Create default config
      const configPath = '.keystone/config.yaml';
      if (!(await exists(configPath))) {
        await writeFile(configPath, DEFAULT_CONFIG);
        console.log(`✓ Created ${configPath}`);
      } else {
        console.log(`⊘ ${configPath} already exists`);
      }

      // Create example .env
      const envPath = '.env';
      if (!(await exists(envPath))) {
        await writeFile(envPath, ENV_TEMPLATE);
        console.log(`✓ Created ${envPath}`);
      } else {
        console.log(`⊘ ${envPath} already exists`);
      }

      // Seed default workflows and agents
      for (const seed of SEEDS) {
        if (!(await exists(seed.path))) {
          await writeFile(seed.path, seed.content);
          console.log(`✓ Seeded ${seed.path}`);
        } else {
          console.log(`⊘ ${seed.path} already exists`);
        }
      }

      console.log('\n✨ Keystone project initialized!');
      console.log('\nNext steps:');
      console.log('  1. Add your API keys to .env');
      console.log('  2. Create a workflow in .keystone/workflows/');
      console.log('  3. Run: keystone run <workflow>');
    });
}
