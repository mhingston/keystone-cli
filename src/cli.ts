#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';

import exploreAgent from './templates/agents/explore.md' with { type: 'text' };
import generalAgent from './templates/agents/general.md' with { type: 'text' };
import architectAgent from './templates/agents/keystone-architect.md' with { type: 'text' };
// Default templates
import scaffoldWorkflow from './templates/scaffold-feature.yaml' with { type: 'text' };

import { WorkflowDb } from './db/workflow-db.ts';
import { WorkflowParser } from './parser/workflow-parser.ts';
import { ConfigLoader } from './utils/config-loader.ts';
import { generateMermaidGraph, renderWorkflowAsAscii } from './utils/mermaid.ts';
import { WorkflowRegistry } from './utils/workflow-registry.ts';

import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('keystone')
  .description('A local-first, declarative, agentic workflow orchestrator')
  .version(pkg.version);

// ===== keystone init =====
program
  .command('init')
  .description('Initialize a new Keystone project')
  .action(() => {
    console.log('🏛️  Initializing Keystone project...\n');

    // Create directories
    const dirs = ['.keystone', '.keystone/workflows', '.keystone/workflows/agents'];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        console.log(`✓ Created ${dir}/`);
      } else {
        console.log(`⊘ ${dir}/ already exists`);
      }
    }

    // Create default config
    const configPath = '.keystone/config.yaml';
    if (!existsSync(configPath)) {
      const defaultConfig = `# Keystone Configuration
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

storage:
  retention_days: 30
workflows_directory: workflows
`;
      writeFileSync(configPath, defaultConfig);
      console.log(`✓ Created ${configPath}`);
    } else {
      console.log(`⊘ ${configPath} already exists`);
    }

    // Create example .env
    const envPath = '.env';
    if (!existsSync(envPath)) {
      const envTemplate = `# API Keys and Secrets
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
`;
      writeFileSync(envPath, envTemplate);
      console.log(`✓ Created ${envPath}`);
    } else {
      console.log(`⊘ ${envPath} already exists`);
    }

    // Seed default workflows and agents
    const seeds = [
      {
        path: '.keystone/workflows/scaffold-feature.yaml',
        content: scaffoldWorkflow,
      },
      {
        path: '.keystone/workflows/agents/keystone-architect.md',
        content: architectAgent,
      },
      {
        path: '.keystone/workflows/agents/general.md',
        content: generalAgent,
      },
      {
        path: '.keystone/workflows/agents/explore.md',
        content: exploreAgent,
      },
    ];

    for (const seed of seeds) {
      if (!existsSync(seed.path)) {
        writeFileSync(seed.path, seed.content);
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

// ===== keystone validate =====
program
  .command('validate')
  .description('Validate workflow files')
  .argument('[path]', 'Workflow file or directory to validate (default: .keystone/workflows/)')
  .action(async (pathArg) => {
    const path = pathArg || '.keystone/workflows/';

    try {
      let files: string[] = [];
      if (existsSync(path) && (path.endsWith('.yaml') || path.endsWith('.yml'))) {
        files = [path];
      } else if (existsSync(path)) {
        const glob = new Bun.Glob('**/*.{yaml,yml}');
        for await (const file of glob.scan(path)) {
          files.push(join(path, file));
        }
      } else {
        try {
          const resolved = WorkflowRegistry.resolvePath(path);
          files = [resolved];
        } catch {
          console.error(`✗ Path not found: ${path}`);
          process.exit(1);
        }
      }

      if (files.length === 0) {
        console.log('⊘ No workflow files found to validate.');
        return;
      }

      console.log(`🔍 Validating ${files.length} workflow(s)...\n`);

      let successCount = 0;
      let failCount = 0;

      for (const file of files) {
        try {
          const workflow = WorkflowParser.loadWorkflow(file);
          console.log(`  ✓ ${file.padEnd(40)} ${workflow.name} (${workflow.steps.length} steps)`);
          successCount++;
        } catch (error) {
          console.error(
            `  ✗ ${file.padEnd(40)} ${error instanceof Error ? error.message : String(error)}`
          );
          failCount++;
        }
      }

      console.log(`\nSummary: ${successCount} passed, ${failCount} failed.`);
      if (failCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error('✗ Validation failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone graph =====
program
  .command('graph')
  .description('Visualize a workflow as a Mermaid.js graph')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .action(async (workflowPath) => {
    try {
      const resolvedPath = WorkflowRegistry.resolvePath(workflowPath);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);
      const ascii = renderWorkflowAsAscii(workflow);
      if (ascii) {
        console.log(`\n${ascii}\n`);
      } else {
        const mermaid = generateMermaidGraph(workflow);
        console.log('\n```mermaid');
        console.log(mermaid);
        console.log('```\n');
      }
    } catch (error) {
      console.error('✗ Failed to generate graph:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone run =====
program
  .command('run')
  .description('Execute a workflow')
  .argument('<workflow>', 'Workflow name or path to workflow file')
  .option('-i, --input <key=value...>', 'Input values')
  .option('--dry-run', 'Show what would be executed without actually running it')
  .action(async (workflowPath, options) => {
    // Parse inputs
    const inputs: Record<string, unknown> = {};
    if (options.input) {
      for (const pair of options.input) {
        const index = pair.indexOf('=');
        if (index > 0) {
          const key = pair.slice(0, index);
          const value = pair.slice(index + 1);
          // Try to parse as JSON, otherwise use as string
          try {
            inputs[key] = JSON.parse(value);
          } catch {
            inputs[key] = value;
          }
        }
      }
    }

    // Load and validate workflow
    try {
      const resolvedPath = WorkflowRegistry.resolvePath(workflowPath);
      const workflow = WorkflowParser.loadWorkflow(resolvedPath);

      // Auto-prune old runs
      try {
        const config = ConfigLoader.load();
        const db = new WorkflowDb();
        const deleted = await db.pruneRuns(config.storage.retention_days);
        if (deleted > 0) {
          await db.vacuum();
        }
        db.close();
      } catch (error) {
        // Non-fatal
      }

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const runner = new WorkflowRunner(workflow, {
        inputs,
        workflowDir: dirname(resolvedPath),
        dryRun: !!options.dryRun,
      });

      const outputs = await runner.run();

      if (Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error(
        '✗ Failed to execute workflow:',
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  });

// ===== keystone resume =====
program
  .command('resume')
  .description('Resume a paused or failed workflow run')
  .argument('<run_id>', 'Run ID to resume')
  .option('-w, --workflow <path>', 'Path to workflow file (auto-detected if not specified)')
  .action(async (runId, options) => {
    try {
      const config = ConfigLoader.load();
      const db = new WorkflowDb();

      // Auto-prune old runs
      try {
        const deleted = await db.pruneRuns(config.storage.retention_days);
        if (deleted > 0) {
          await db.vacuum();
        }
      } catch (error) {
        // Non-fatal
      }

      // Load run from database to get workflow name
      const run = db.getRun(runId);

      if (!run) {
        console.error(`✗ Run not found: ${runId}`);
        db.close();
        process.exit(1);
      }

      console.log(`Found run: ${run.workflow_name} (status: ${run.status})`);

      // Determine workflow file path
      let workflowPath = options.workflow;

      if (!workflowPath) {
        try {
          workflowPath = WorkflowRegistry.resolvePath(run.workflow_name);
        } catch (error) {
          console.error(
            `✗ Could not find workflow file for '${run.workflow_name}'.\n   Use --workflow <path> to specify the path manually.`
          );
          db.close();
          process.exit(1);
        }
      }

      console.log(`Loading workflow from: ${workflowPath}\n`);

      // Close DB before loading workflow (will be reopened by runner)
      db.close();

      // Load and validate workflow
      const workflow = WorkflowParser.loadWorkflow(workflowPath);

      // Import WorkflowRunner dynamically
      const { WorkflowRunner } = await import('./runner/workflow-runner.ts');
      const runner = new WorkflowRunner(workflow, {
        resumeRunId: runId,
        workflowDir: dirname(workflowPath),
      });

      const outputs = await runner.run();

      if (Object.keys(outputs).length > 0) {
        console.log('Outputs:');
        console.log(JSON.stringify(runner.redact(outputs), null, 2));
      }
      process.exit(0);
    } catch (error) {
      console.error('✗ Failed to resume workflow:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone workflows =====
program
  .command('workflows')
  .description('List available workflows')
  .action(() => {
    try {
      const workflows = WorkflowRegistry.listWorkflows();
      if (workflows.length === 0) {
        console.log('No workflows found.');
        return;
      }

      console.log('\nAvailable workflows:\n');
      for (const w of workflows) {
        const description = w.description ? ` - ${w.description}` : '';
        console.log(`  ${w.name.padEnd(25)}${description}`);
      }
      console.log();
    } catch (error) {
      console.error('✗ Failed to list workflows:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone history =====
program
  .command('history')
  .description('List recent workflow runs')
  .option('-n, --limit <number>', 'Number of runs to show', '20')
  .action((options) => {
    try {
      const db = new WorkflowDb();
      const runs = db.listRuns(Number.parseInt(options.limit));

      if (runs.length === 0) {
        console.log('No workflow runs found.');
        return;
      }

      console.log('\nRecent workflow runs:\n');
      for (const run of runs) {
        const status = run.status.toUpperCase().padEnd(10);
        const date = new Date(run.started_at).toLocaleString();
        console.log(
          `${run.id.substring(0, 8)}  ${status}  ${run.workflow_name.padEnd(20)}  ${date}`
        );
      }

      db.close();
    } catch (error) {
      console.error('✗ Failed to list runs:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone logs =====
program
  .command('logs')
  .description('Show logs for a workflow run')
  .argument('<run_id>', 'Run ID')
  .action((runId) => {
    try {
      const db = new WorkflowDb();
      const run = db.getRun(runId);

      if (!run) {
        console.error(`✗ Run not found: ${runId}`);
        process.exit(1);
      }

      console.log(`\n📋 Workflow: ${run.workflow_name}`);
      console.log(`Status: ${run.status}`);
      console.log(`Started: ${new Date(run.started_at).toLocaleString()}`);

      const steps = db.getStepsByRun(runId);
      if (steps.length > 0) {
        console.log('\nSteps:');
        for (const step of steps) {
          const status = step.status.toUpperCase().padEnd(10);
          console.log(`  ${step.step_id.padEnd(20)}  ${status}`);
        }
      }

      db.close();
    } catch (error) {
      console.error('✗ Failed to show logs:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone prune =====
program
  .command('prune')
  .description('Delete old workflow runs from the database')
  .option('--days <days>', 'Delete runs older than this many days', '7')
  .action(async (options) => {
    try {
      const days = Number.parseInt(options.days, 10);
      if (Number.isNaN(days) || days < 0) {
        console.error('✗ Invalid days value. Must be a positive number.');
        process.exit(1);
      }

      const db = new WorkflowDb();
      const deleted = await db.pruneRuns(days);
      if (deleted > 0) {
        await db.vacuum();
      }
      db.close();

      console.log(`✓ Deleted ${deleted} workflow run(s) older than ${days} days`);
    } catch (error) {
      console.error('✗ Failed to prune runs:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ===== keystone ui =====
program
  .command('ui')
  .description('Open the TUI dashboard')
  .action(async () => {
    const { startDashboard } = await import('./ui/dashboard.tsx');
    startDashboard();
  });

// ===== keystone mcp =====
const mcp = program.command('mcp').description('Model Context Protocol management');

mcp
  .command('login')
  .description('Login to an MCP server')
  .argument('<server>', 'Server name (from config)')
  .action(async (serverName) => {
    const { ConfigLoader } = await import('./utils/config-loader.ts');
    const { AuthManager } = await import('./utils/auth-manager.ts');

    const config = ConfigLoader.load();
    const server = config.mcp_servers[serverName];

    if (!server || !server.oauth) {
      console.error(`✗ MCP server '${serverName}' is not configured with OAuth.`);
      process.exit(1);
    }

    let url = server.url;

    // If it's a local server using mcp-remote, try to find the URL in args
    if (!url && server.type === 'local' && server.args) {
      url = server.args.find((arg) => arg.startsWith('http'));
    }

    if (!url) {
      console.error(
        `✗ MCP server '${serverName}' does not have a URL configured for authentication.`
      );
      console.log('  Please add a "url" property to your server configuration.');
      process.exit(1);
    }

    console.log(`\n🔐 Authenticating with MCP server: ${serverName}`);
    console.log(`   URL: ${url}\n`);

    // For now, we'll support a manual token entry until we have a full browser redirect flow
    // Most MCP OAuth servers provide a way to get a token via a URL
    const authUrl = url.replace('/sse', '/authorize') || url;
    console.log('1. Visit the following URL to authorize:');
    console.log(`   ${authUrl}`);
    console.log(
      '\n   Note: If you encounter errors, ensure the server is correctly configured and accessible.'
    );
    console.log('   You can still manually provide an OAuth token below if you have one.');
    console.log('\n2. Paste the access token below:\n');

    const prompt = 'Access Token: ';
    process.stdout.write(prompt);

    let token = '';
    for await (const line of console) {
      token = line.trim();
      break;
    }

    if (token) {
      const auth = AuthManager.load();
      const mcp_tokens = auth.mcp_tokens || {};
      mcp_tokens[serverName] = { access_token: token };
      AuthManager.save({ mcp_tokens });
      console.log(`\n✓ Successfully saved token for MCP server: ${serverName}`);
    } else {
      console.error('✗ No token provided.');
      process.exit(1);
    }
  });

mcp
  .command('start')
  .description('Start the Keystone MCP server (to use Keystone as a tool)')
  .action(async () => {
    const { MCPServer } = await import('./runner/mcp-server.ts');

    if (process.stdin.isTTY) {
      const DIM = '\x1b[2m';
      const CYAN = '\x1b[36m';
      const RESET = '\x1b[0m';

      process.stderr.write(`${CYAN}🏛️  Keystone MCP Server${RESET}\n\n`);
      process.stderr.write(
        'To add this server to Claude Desktop, include this in your configuration:\n'
      );
      process.stderr.write(
        `${DIM}${JSON.stringify(
          {
            mcpServers: {
              keystone: {
                command: 'keystone',
                args: ['mcp'],
              },
            },
          },
          null,
          2
        )}${RESET}\n`
      );
      process.stderr.write(
        `\nStatus: ${CYAN}Running...${RESET} ${DIM}(Press Ctrl+C to stop)${RESET}\n`
      );
    } else {
      process.stderr.write('Keystone MCP Server started\n');
    }

    const server = new MCPServer();
    await server.start();
  });

// ===== keystone config =====
program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const { ConfigLoader } = await import('./utils/config-loader.ts');
    try {
      const config = ConfigLoader.load();
      console.log('\n🏛️  Keystone Configuration:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('✗ Failed to load config:', error instanceof Error ? error.message : error);
    }
  });

// ===== keystone auth =====
const auth = program.command('auth').description('Authentication management');

auth
  .command('login')
  .description('Login to an authentication provider')
  .argument('[provider]', 'Authentication provider', 'github')
  .option(
    '-p, --provider <provider>',
    'Authentication provider (deprecated, use positional argument)'
  )
  .option('-t, --token <token>', 'Personal Access Token (if not using interactive mode)')
  .action(async (providerArg, options) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const provider = (options.provider || providerArg).toLowerCase();

    if (provider === 'github') {
      let token = options.token;

      if (!token) {
        try {
          const deviceLogin = await AuthManager.initGitHubDeviceLogin();

          console.log('\nTo login with GitHub:');
          console.log(`1. Visit: ${deviceLogin.verification_uri}`);
          console.log(`2. Enter code: ${deviceLogin.user_code}\n`);

          console.log('Waiting for authorization...');
          token = await AuthManager.pollGitHubDeviceLogin(deviceLogin.device_code);
        } catch (error) {
          console.error(
            '\n✗ Failed to login with GitHub device flow:',
            error instanceof Error ? error.message : error
          );
          console.log('\nFalling back to manual token entry...');

          console.log('\nTo login with GitHub manually:');
          console.log(
            '1. Generate a Personal Access Token (Classic) with "copilot" scope (or full repo access).'
          );
          console.log('   https://github.com/settings/tokens/new');
          console.log('2. Paste the token below:\n');

          const prompt = 'Token: ';
          process.stdout.write(prompt);
          for await (const line of console) {
            token = line.trim();
            break;
          }
        }
      }

      if (token) {
        AuthManager.save({ github_token: token });
        // Force refresh of Copilot token to verify
        try {
          const copilotToken = await AuthManager.getCopilotToken();
          if (copilotToken) {
            console.log('\n✓ Successfully logged in to GitHub and retrieved Copilot token.');
          } else {
            console.error(
              '\n✗ Saved GitHub token, but failed to retrieve Copilot token. Please check scopes.'
            );
          }
        } catch (e) {
          console.error('\n✗ Failed to verify token:', e instanceof Error ? e.message : e);
        }
      } else {
        console.error('✗ No token provided.');
        process.exit(1);
      }
    } else if (provider === 'openai' || provider === 'anthropic') {
      let key = options.token; // Use --token if provided as the API key

      if (!key) {
        console.log(`\n🔑 Login to ${provider.toUpperCase()}`);
        console.log(`   Please provide your ${provider.toUpperCase()} API key.\n`);
        const prompt = 'API Key: ';
        process.stdout.write(prompt);
        for await (const line of console) {
          key = line.trim();
          break;
        }
      }

      if (key) {
        if (provider === 'openai') {
          AuthManager.save({ openai_api_key: key });
        } else {
          AuthManager.save({ anthropic_api_key: key });
        }
        console.log(`\n✓ Successfully saved ${provider.toUpperCase()} API key.`);
      } else {
        console.error('✗ No API key provided.');
        process.exit(1);
      }
    } else {
      console.error(`✗ Unsupported provider: ${provider}`);
      process.exit(1);
    }
  });

auth
  .command('status')
  .description('Show authentication status')
  .argument('[provider]', 'Authentication provider')
  .option('-p, --provider <provider>', 'Authentication provider')
  .action(async (providerArg, options) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const auth = AuthManager.load();
    const provider = (options.provider || providerArg)?.toLowerCase();

    console.log('\n🏛️  Authentication Status:');

    if (!provider || provider === 'github' || provider === 'copilot') {
      if (auth.github_token) {
        console.log('  ✓ Logged into GitHub');
        if (auth.copilot_expires_at) {
          const expires = new Date(auth.copilot_expires_at * 1000);
          console.log(`  ✓ Copilot session expires: ${expires.toLocaleString()}`);
        }
      } else if (provider) {
        console.log(
          `  ⊘ Not logged into GitHub. Run "keystone auth login github" to authenticate.`
        );
      }
    }

    if (!provider || provider === 'openai') {
      if (auth.openai_api_key) {
        console.log('  ✓ OpenAI API key configured');
      } else if (provider) {
        console.log(
          `  ⊘ OpenAI API key not configured. Run "keystone auth login openai" to authenticate.`
        );
      }
    }

    if (!provider || provider === 'anthropic') {
      if (auth.anthropic_api_key) {
        console.log('  ✓ Anthropic API key configured');
      } else if (provider) {
        console.log(
          `  ⊘ Anthropic API key not configured. Run "keystone auth login anthropic" to authenticate.`
        );
      }
    }

    if (!auth.github_token && !auth.openai_api_key && !auth.anthropic_api_key && !provider) {
      console.log('  ⊘ No providers configured. Run "keystone auth login" to authenticate.');
    }
  });

auth
  .command('logout')
  .description('Logout and clear authentication tokens')
  .argument('[provider]', 'Authentication provider')
  .option(
    '-p, --provider <provider>',
    'Authentication provider (deprecated, use positional argument)'
  )
  .action(async (providerArg, options) => {
    const { AuthManager } = await import('./utils/auth-manager.ts');
    const provider = (options.provider || providerArg)?.toLowerCase();

    if (!provider || provider === 'github' || provider === 'copilot') {
      AuthManager.save({
        github_token: undefined,
        copilot_token: undefined,
        copilot_expires_at: undefined,
      });
      console.log('✓ Successfully logged out of GitHub.');
    } else if (provider === 'openai') {
      AuthManager.save({ openai_api_key: undefined });
      console.log('✓ Successfully cleared OpenAI API key.');
    } else if (provider === 'anthropic') {
      AuthManager.save({ anthropic_api_key: undefined });
      console.log('✓ Successfully cleared Anthropic API key.');
    } else {
      console.error(`✗ Unknown provider: ${provider}`);
      process.exit(1);
    }
  });

// ===== Internal Helper Commands (Hidden) =====
program.command('_list-workflows', { hidden: true }).action(() => {
  const workflows = WorkflowRegistry.listWorkflows();
  for (const w of workflows) {
    console.log(w.name);
  }
});

program.command('_list-runs', { hidden: true }).action(() => {
  try {
    const db = new WorkflowDb();
    const runs = db.listRuns(50);
    for (const run of runs) {
      console.log(run.id);
    }
    db.close();
  } catch (e) {
    // Ignore errors in helper
  }
});

// ===== keystone completion =====
program
  .command('completion')
  .description('Generate shell completion script')
  .argument('[shell]', 'Shell type (zsh, bash)', 'zsh')
  .action((shell) => {
    if (shell === 'zsh') {
      console.log(`#compdef keystone

if [[ -n $ZSH_VERSION ]]; then
  compdef _keystone keystone
fi

_keystone() {
  local line state

  _arguments -C \\
    "1: :->command" \\
    "*:: :->args"

  case $state in
    command)
      local -a commands
      commands=(
        'init:Initialize a new Keystone project'
        'validate:Validate workflow files'
        'graph:Visualize a workflow as a Mermaid.js graph'
        'run:Execute a workflow'
        'resume:Resume a paused or failed workflow run'
        'workflows:List available workflows'
        'history:List recent workflow runs'
        'logs:Show logs for a workflow run'
        'prune:Delete old workflow runs from the database'
        'ui:Open the TUI dashboard'
        'mcp:Start the Model Context Protocol server'
        'config:Show current configuration'
        'auth:Authentication management'
        'completion:Generate shell completion script'
      )
      _describe -t commands 'keystone command' commands
      ;;
    args)
      case $words[1] in
        run)
          _arguments \\
            '(-i --input)'{-i,--input}'[Input values]:key=value' \\
            ':workflow:__keystone_workflows'
          ;;
        graph)
          _arguments ':workflow:__keystone_workflows'
          ;;
        validate)
          _arguments ':path:_files'
          ;;
        resume|logs)
          _arguments ':run_id:__keystone_runs'
          ;;
        auth)
          local -a auth_commands
          auth_commands=(
            'login:Login to an authentication provider'
            'status:Show authentication status'
            'logout:Logout and clear authentication tokens'
          )
          _describe -t auth_commands 'auth command' auth_commands
          ;;
      esac
      ;;
  esac
}

__keystone_workflows() {
  local -a workflows
  workflows=($(keystone _list-workflows 2>/dev/null))
  _describe -t workflows 'workflow' workflows
}

__keystone_runs() {
  local -a runs
  runs=($(keystone _list-runs 2>/dev/null))
  _describe -t runs 'run_id' runs
}
`);
    } else if (shell === 'bash') {
      console.log(`_keystone_completion() {
  local cur prev opts
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"
  opts="init validate graph run resume workflows history logs prune ui mcp config auth completion"

  case "${prev}" in
    run|graph)
      local workflows=$(keystone _list-workflows 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${workflows}" -- \${cur}) )
      return 0
      ;;
    resume|logs)
      local runs=$(keystone _list-runs 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${runs}" -- \${cur}) )
      return 0
      ;;
  esac

  COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}
complete -F _keystone_completion keystone`);
    } else {
      console.error(`✗ Unsupported shell: ${shell}. Supported: zsh, bash`);
      process.exit(1);
    }
  });

program.parse();
