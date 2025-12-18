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
This creates the `.keystone/` directory for configuration and `.keystone/workflows/` for your automation files.

### 2. Configure your Environment
Add your API keys to the generated `.env` file:
```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
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
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"

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
Keystone supports using your GitHub Copilot subscription directly. To authenticate:
```bash
keystone auth login
```
Then, you can use Copilot in your configuration:
```yaml
providers:
  copilot:
    type: copilot
    default_model: gpt-4o
```
API keys are handled automatically after login.

API keys should be stored in a `.env` file in your project root:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

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

outputs:
  slack_message: ${{ steps.notify.output }}
```

---

## 🏗️ Step Types

Keystone supports several specialized step types:

- `shell`: Run arbitrary shell commands.
- `llm`: Prompt an agent and get structured or unstructured responses. Supports `schema` (JSON Schema) for structured output.
- `request`: Make HTTP requests (GET, POST, etc.).
- `file`: Read, write, or append to files.
- `human`: Pause execution for manual confirmation or text input.
  - `inputType: confirm`: Simple Enter-to-continue prompt.
  - `inputType: text`: Prompt for a string input, available via `${{ steps.id.output }}`.
- `workflow`: Trigger another workflow as a sub-step.
- `sleep`: Pause execution for a specified duration.

All steps support common features like `needs` (dependencies), `if` (conditionals), `retry`, `timeout`, `foreach` (parallel iteration), and `transform` (post-process output using expressions).

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
---
You are a software developer. You can use tools to explore the codebase.
```

### Model Context Protocol (MCP)

Keystone supports connecting to external MCP servers to give agents access to a wide range of pre-built tools and resources. You can configure MCP servers globally or directly in an LLM step.

#### Global MCP Servers
Define shared MCP servers in `.keystone/config.yaml` to reuse them across different workflows. Keystone ensures that multiple steps using the same global server will share a single running process.

```yaml
mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
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
| `run <workflow>` | Execute a workflow by name or path |
| `resume <run_id>` | Resume a failed or paused workflow |
| `validate [path]` | Check workflow files (defaults to `.keystone/workflows/` or matches a workflow name) |
| `workflows` | List available workflows |
| `history` | Show recent workflow runs |
| `logs <run_id>` | View logs and step status for a specific run |
| `graph <workflow>` | Generate a Mermaid diagram of the workflow by name or path |
| `config` | Show current configuration and provider settings |
| `auth <login/status/logout>` | Manage GitHub Copilot authentication |
| `ui` | Open the interactive TUI dashboard |
| `mcp` | Start the Model Context Protocol server |
| `completion [shell]` | Generate shell completion script (zsh, bash) |
| `prune` | Cleanup old run data from the database (also automated via `storage.retention_days`) |

---

## 📂 Project Structure

- `src/db/`: SQLite persistence layer.
- `src/runner/`: The core execution engine, handles parallelization and retries.
- `src/parser/`: Zod-powered validation for workflows and agents.
- `src/expression/`: `${{ }}` expression evaluator.
- `src/ui/`: Ink-powered TUI dashboard.
- `.keystone/workflows/`: Your YAML workflow definitions.

---

## 📄 License

MIT