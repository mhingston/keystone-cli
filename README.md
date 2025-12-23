<p align="center">
  <img src="logo.png" width="250" alt="Keystone CLI Logo">
</p>

# 🏛️ Keystone CLI

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun&logoColor=white)](https://bun.sh)
[![npm version](https://img.shields.io/npm/v/keystone-cli.svg?style=flat)](https://www.npmjs.com/package/keystone-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A local-first, declarative, agentic workflow orchestrator built on **Bun**.

Keystone allows you to define complex automation workflows using a simple YAML syntax, with first-class support for LLM agents, state persistence, and parallel execution.

---

## ✨ Features

- ⚡ **Local-First:** Built on Bun with a local SQLite database for state management.
- 🧩 **Declarative:** Define workflows in YAML with automatic dependency tracking (DAG).
- 🤖 **Agentic:** First-class support for LLM agents defined in Markdown with YAML frontmatter.
- 🧑‍💻 **Human-in-the-Loop:** Support for manual approval and text input steps.
- 🔄 **Resilient:** Built-in retries, timeouts, and state persistence. Resume failed or paused runs exactly where they left off.
- 📊 **TUI Dashboard:** Built-in interactive dashboard for monitoring and managing runs.
- 🛠️ **Extensible:** Support for shell, file, HTTP request, LLM, and sub-workflow steps.
- 🔌 **MCP Support:** Integrated Model Context Protocol server.
- 🛡️ **Secret Redaction:** Automatically redacts environment variables and secrets from logs and outputs.
- 🧠 **Semantic Memory:** Store and retrieve step outputs using vector embeddings/RAG.
- 🎯 **Prompt Optimization:** Automatically optimize prompts using iterative evaluation (DSPy-style).

---

## 🚀 Installation

Ensure you have [Bun](https://bun.sh) installed.

### Global Install (Recommended)
```bash
bun install -g keystone-cli
```

### From Source
```bash
# Clone the repository
git clone https://github.com/mhingston/keystone-cli.git
cd keystone-cli

# Install dependencies
bun install

# Link CLI globally
bun link
```

### Shell Completion

To enable tab completion for your shell, add the following to your `.zshrc` or `.bashrc`:

**Zsh:**
```bash
source <(keystone completion zsh)
```

**Bash:**
```bash
source <(keystone completion bash)
```

---

## 🚦 Quick Start

### 1. Initialize a Project
```bash
keystone init
```
This creates the `.keystone/` directory for configuration and seeds `.keystone/workflows/` with default automation files and agents (like `scaffold-feature` and `keystone-architect`).

### 2. Configure your Environment
Add your API keys to the generated `.env` file:
```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```
Alternatively, you can use the built-in authentication management:
```bash
keystone auth login openai
keystone auth login anthropic
```

### 3. Run a Workflow
```bash
keystone run basic-shell
```
Keystone automatically looks in `.keystone/workflows/` (locally and in your home directory) for `.yaml` or `.yml` files.

### 4. Monitor with the Dashboard
```bash
keystone ui
```

---

## ⚙️ Configuration

Keystone uses a local configuration file at `.keystone/config.yaml` to manage model providers and model mappings.

```yaml
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

mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "your-github-pat" # Or omit if GITHUB_TOKEN is in your .env

storage:

  retention_days: 30
```

### Model & Provider Resolution

Keystone resolves which provider to use for a model in the following order:

1. **Explicit Provider:** Use the `provider` field in an agent or step definition.
2. **Provider Prefix:** Use the `provider:model` syntax (e.g., `model: copilot:gpt-4o`).
3. **Model Mappings:** Matches the model name against the `model_mappings` in your config (supports suffix `*` for prefix matching).
4. **Default Provider:** Falls back to the `default_provider` defined in your config.

#### Example: Explicit Provider in Agent
**`.keystone/workflows/agents/summarizer.md`**
```markdown
---
name: summarizer
provider: anthropic
model: claude-3-5-sonnet-latest
---
```

#### Example: Provider Prefix in Step
```yaml
- id: notify
  type: llm
  agent: summarizer
  model: copilot:gpt-4o
  prompt: ...
```

### OpenAI Compatible Providers
You can add any OpenAI-compatible provider (Groq, Together AI, Perplexity, Local Ollama, etc.) by setting the `type` to `openai` and providing the `base_url` and `api_key_env`.

### GitHub Copilot Support

Keystone supports using your GitHub Copilot subscription directly. To authenticate (using the GitHub Device Flow):

```bash
keystone auth login github
```

Then, you can use Copilot in your configuration:

```yaml
providers:
  copilot:
    type: copilot
    default_model: gpt-4o
```

Authentication tokens for Copilot are managed automatically after the initial login. 

### API Key Management

For other providers, you can either store API keys in a `.env` file in your project root:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Or use the `keystone auth login` command to securely store them in your local machine's configuration:
- `keystone auth login openai`
- `keystone auth login anthropic`

---

## 📝 Workflow Example

Workflows are defined in YAML. Dependencies are automatically resolved based on the `needs` field, and **Keystone also automatically detects implicit dependencies** from your `${{ }}` expressions.

```yaml
name: build-and-notify
description: Build the project and notify the team

inputs:
  branch:
    type: string
    default: main

steps:
  - id: checkout
    type: shell
    run: git checkout ${{ inputs.branch }}

  - id: install
    type: shell
    # Implicit dependency on 'checkout' detected from expression below
    if: ${{ steps.checkout.status == 'success' }}
    run: bun install

  - id: build
    type: shell
    needs: [install] # Explicit dependency
    run: bun run build
    retry:
      count: 3
      backoff: exponential

  - id: notify
    type: llm
    # Implicit dependency on 'build' detected from expression below
    agent: summarizer
    prompt: |
      The build for branch "${{ inputs.branch }}" was successful.
      Result: ${{ steps.build.output }}
      Please write a concise 1-sentence summary for Slack.

  - id: cleanup
    type: shell
    # Run whether previous steps succeeded or failed
    if: true
    run: rm -rf ./temp_build

finally:
  - id: final_cleanup
    type: shell
    run: echo "Workflow finished"

### Expression Syntax

Keystone uses `${{ }}` syntax for dynamic values. Expressions are evaluated using a safe AST parser.

- `${{ inputs.name }}`: Access workflow inputs.
- `${{ steps.id.output }}`: Access the raw output of a previous step.
- `${{ steps.id.outputs.field }}`: Access specific fields if the output is an object.
- `${{ steps.id.status }}`: Get the execution status of a step (`'success'`, `'failed'`, etc.).
- `${{ item }}`: Access the current item in a `foreach` loop.
- `${{ args.name }}`: Access tool arguments (available ONLY inside agent tool execution steps).
- `${{ secrets.NAME }}`: Access redacted secrets.
- `${{ env.NAME }}`: Access environment variables.

Standard JavaScript-like expressions are supported: `${{ steps.build.status == 'success' ? '🚀' : '❌' }}`.

---

outputs:
  slack_message: ${{ steps.notify.output }}
```

---

## 🏗️ Step Types

Keystone supports several specialized step types:

- `shell`: Run arbitrary shell commands.
- `llm`: Prompt an agent and get structured or unstructured responses. Supports `schema` (JSON Schema) for structured output.
  - `allowClarification`: Boolean (default `false`). If `true`, allows the LLM to ask clarifying questions back to the user or suspend the workflow if no human is available.
  - `maxIterations`: Number (default `10`). Maximum number of tool-calling loops allowed for the agent.
  - `allowInsecure`: Boolean (default `false`). Set `true` to allow risky tool execution.
  - `allowOutsideCwd`: Boolean (default `false`). Set `true` to allow tools to access files outside of the current working directory.
- `request`: Make HTTP requests (GET, POST, etc.).
- `file`: Read, write, or append to files.
  - `allowOutsideCwd`: Boolean (default `false`). Set `true` to allow reading/writing files outside of the current working directory.
- `human`: Pause execution for manual confirmation or text input.
  - `inputType: confirm`: Simple Enter-to-continue prompt.
  - `inputType: text`: Prompt for a string input, available via `${{ steps.id.output }}`.
- `workflow`: Trigger another workflow as a sub-step.
- `script`: Run arbitrary JavaScript in a sandbox. On Bun, uses `node:vm` (since `isolated-vm` requires V8).
  - ⚠️ **Security Note:** The `node:vm` sandbox is not secure against malicious code. Only run scripts from trusted sources.
- `sleep`: Pause execution for a specified duration.
- `memory`: Store or retrieve information from the semantic memory vector database.

All steps support common features like `needs` (dependencies), `if` (conditionals), `retry`, `timeout`, `foreach` (parallel iteration), `concurrency` (max parallel items for foreach), `transform` (post-process output using expressions), `learn` (auto-index for few-shot), and `reflexion` (self-correction loop).

Workflows also support a top-level `concurrency` field to limit how many steps can run in parallel across the entire workflow. This must be a positive integer.

### Self-Healing Steps
Steps can be configured to automatically recover from failures using an LLM agent.

```yaml
- id: build
  type: shell
  run: bun build
  auto_heal:
    agent: debugger_agent
    maxAttempts: 3
    model: gpt-4o # Optional override
```

When a step fails, the specified agent is invoked with the error details. The agent proposes a fix (e.g., a corrected command), and the step is automatically retried.

#### Example: Transform & Foreach Concurrency
```yaml
- id: list_files
  type: shell
  run: ls *.txt
  # Post-process stdout into an array of filenames
  transform: ${{ stdout.trim().split('\n') }}

- id: process_files
  type: shell
  foreach: ${{ steps.list_files.output }}
  concurrency: 5 # Process 5 files at a time (must be a positive integer)
  run: echo "Processing ${{ item }}"

#### Example: Script Step
```yaml
- id: calculate
  type: script
  allowInsecure: true
  run: |
    const data = context.steps.fetch_data.output;
    return data.map(i => i.value * 2).reduce((a, b) => a + b, 0);
```
```

---

## 🤖 Agent Definitions

Agents are defined in Markdown files with YAML frontmatter, making them easy to read and version control.

**`.keystone/workflows/agents/summarizer.md`**
```markdown
---
name: summarizer
provider: openai
model: gpt-4o
description: Summarizes technical logs into human-readable messages
---

You are a technical communications expert. Your goal is to take technical output 
(like build logs or test results) and provide a concise, professional summary.
```

### Agent Tools

Agents can be equipped with tools, which are essentially workflow steps they can choose to execute. You can define tools in the agent definition, or directly in an LLM step within a workflow.

Tool arguments are passed to the tool's execution step via the `args` variable.

**`.keystone/workflows/agents/developer.md`**
```markdown
---
name: developer
tools:
  - name: list_files
    description: List files in the current directory
    execution:
      id: list-files-tool
      type: shell
      run: ls -F
  - name: read_file
    description: Read a specific file
    parameters:
      type: object
      properties:
        path: { type: string }
      required: [path]
    execution:
      id: read-file-tool
      type: file
      op: read
      path: ${{ args.path }}
---
You are a software developer. You can use tools to explore the codebase.
```

### Keystone as an MCP Server

Keystone can itself act as an MCP server, allowing other agents (like Claude Desktop or GitHub Copilot) to discover and run your workflows as tools.

```bash
keystone mcp start
```

#### Sync vs Async Execution

The MCP server provides two modes for running workflows:

| Tool | Mode | Use Case |
|------|------|----------|
| `run_workflow` | **Sync** | Short workflows. Blocks until completion, returns outputs directly. |
| `start_workflow` | **Async** | Long workflows. Returns immediately with a `run_id`, use `get_run_status` to poll. |

**Example: Async execution pattern**
```
1. Agent calls start_workflow → { run_id: "abc", status: "running" }
2. Agent polls get_run_status → { status: "running" }
3. Agent polls get_run_status → { status: "completed", outputs: {...} }
```

The async pattern is ideal for LLM-heavy workflows that may take minutes to complete.

#### Global MCP Servers
Define shared MCP servers in `.keystone/config.yaml` to reuse them across different workflows. Keystone ensures that multiple steps using the same global server will share a single running process.

Keystone supports both local (stdio) and remote (SSE) MCP servers.

```yaml
mcp_servers:
  # Local server (stdio)
  filesystem:
    type: local # Default
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]

  # Remote server (via proxy)
  atlassian:
    type: local
    command: npx
    args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]
    timeout: 60000  # Optional connection timeout in ms
    oauth:
      scope: tools:read
```

#### Using MCP in Steps
You can use global servers, define local ones, or include all global servers at once.

```yaml
- id: analyze_code
  type: llm
  agent: developer
  # Option 1: Explicitly include global servers by name
  # Option 2: Define a local one-off server (standard object syntax)
  mcpServers:
    - filesystem 
    - name: custom-tool
      command: node
      args: ["./scripts/custom-mcp.js"]
  
  # Option 3: Automatically include ALL global servers
  useGlobalMcp: true 
  
  prompt: "Analyze the architecture of this project."
```

In these examples, the agent will have access to all tools provided by the MCP servers (like `list_directory`, `read_file`, etc.) in addition to any tools defined in the agent or the step itself.

---

## 🛠️ CLI Commands

| Command | Description |
| :--- | :--- |
| `init` | Initialize a new Keystone project |
| `run <workflow>` | Execute a workflow (use `-i key=val` for inputs, `--dry-run` to test, `--debug` for REPL) |
| `optimize <workflow>` | Optimize a specific step in a workflow (requires --target) |
| `resume <run_id>` | Resume a failed or paused workflow |
| `validate [path]` | Check workflow files for errors |
| `workflows` | List available workflows |
| `history` | Show recent workflow runs |
| `logs <run_id>` | View logs, outputs, and errors for a specific run (`-v` for full output) |
| `graph <workflow>` | Generate a Mermaid diagram of the workflow |
| `config` | Show current configuration and providers |
| `auth status [provider]` | Show authentication status |
| `auth login [provider]` | Login to an authentication provider (github, openai, anthropic) |
| `auth logout [provider]` | Logout and clear authentication tokens |
| `ui` | Open the interactive TUI dashboard |
| `mcp start` | Start the Keystone MCP server |
| `mcp login <server>` | Login to a remote MCP server |
| `completion [shell]` | Generate shell completion script (zsh, bash) |
| `maintenance [--days N]` | Perform database maintenance (prune old runs and vacuum) |

---
 
 ## 🛡️ Security
 
 ### Shell Execution
 By default, Keystone analyzes shell commands for potentially dangerous patterns (like shell injection, `rm -rf`, piped commands). If a risk is detected:
 - In interactive mode, the user is prompted for confirmation.
 - In non-interactive mode, the step is suspended or failed.
 
 You can bypass this check if you trust the command:
 ```yaml
 - id: deploy
   type: shell
   run: ./deploy.sh ${{ inputs.env }}
   allowInsecure: true
 ```
 
 ### Expression Safety
 Expressions `${{ }}` are evaluated using a safe AST parser (`jsep`) which:
 - Prevents arbitrary code execution (no `eval` or `Function`).
 - Whitelists safe global objects (`Math`, `JSON`, `Date`, etc.).
 - Blocks access to sensitive properties (`constructor`, `__proto__`).
 - Enforces a maximum template length to prevent ReDoS attacks.
 
 ### Script Sandboxing
 The `script` step uses Node.js `vm` module. While it provides isolation for variables, it is **not a security boundary** for malicious code. Only run scripts from trusted sources.
 
 ---
 
 ## 📂 Project Structure

- `src/db/`: SQLite persistence layer.
- `src/runner/`: The core execution engine, handles parallelization and retries.
- `src/parser/`: Zod-powered validation for workflows and agents.
- `src/expression/`: `${{ }}` expression evaluator.
- `src/ui/`: Ink-powered TUI dashboard.
- `src/utils/`: Shared utilities (auth, redaction, config loading).
- `.keystone/workflows/`: Your YAML workflow definitions.

---

## 📄 License

MIT
