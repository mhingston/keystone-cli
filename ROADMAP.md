# Keystone CLI Roadmap

This roadmap focuses on additions beyond current README features (structured outputs, dry-run, concurrency limits, MCP server, TUI dashboard, retries/timeouts, etc.). Priorities are ordered by user value, risk reduction, and leverage across the platform.

## Cross-cutting considerations

### Dependencies and sequencing
Goal: Keep ordering explicit when later work depends on earlier contracts or APIs.
Notes:
1. Typed schemas and input enums should land before blueprint enforcement and sub-workflow output contracts.
2. Idempotency and allowFailure should precede triggers and engine handoffs to keep retries safe.
3. Plugin API should precede curated plugin registry and remote blueprints for compatibility guarantees.
4. LLM caching should land before cached-token telemetry and evaluation reports that depend on it.

### Security and trust defaults
Goal: Add guardrails for features that run external code or fetch remote content.
Notes:
1. Engine steps and triggers should require explicit allowlists and clear prompt-based consent.
2. Remote registries, plugins, and blueprints should support signature or checksum verification.
3. DevMode and compile should emit a manifest of embedded assets and permissions.
4. Default to sandboxed execution unless the workflow opts into `allowInsecure`.

### P0 acceptance criteria
Goal: Define completion gates for foundation features.
Notes:
1. Typed schemas: validation errors include path/line, `keystone validate --strict` updated, tests added.
2. Idempotency: dedup is persisted and observable in logs, resume-safe, tests cover collisions.
3. Structured repair: re-ask path is logged, failures surfaced with schema diff, tests added.
4. Error messages: snippet + suggestion shown for YAML/expression failures, docs updated.
5. Global errors: recovery runs only after retries/auto_heal and before `finally`, run stays failed, `last_failed_step` exposed, tests added.
6. AllowFailure: exit status captured, workflow continues, interaction with retries defined.
7. Input enums/secrets: enum validation enforced, redaction verified in logs/UI, secrets redacted at rest by default.
8. Interrupt support: SIGINT cancels cleanly, run marked canceled, no DB corruption.

### P1 acceptance criteria
Goal: Define completion gates for developer experience and orchestration upgrades.
Notes:
1. Durable timers resume across restarts; scheduler tested with long sleeps/human waits.
2. Subflows have enforced output contracts; compensation paths are documented and exercised in examples.
3. Backpressure pools expose queue depth and utilization; defaults are configurable and validated.
4. Engine steps stream logs, return summaries, and are gated by allowlists and idempotency.
5. Blueprint enforcement includes schema validation and is consumed across plan/generate steps.
6. XDG paths are supported with a migration helper and clear precedence rules.
7. VS Code schema support, remote blueprints, testing, debug bundles, and caching ship with docs and smoke tests.

### P2 acceptance criteria
Goal: Define completion gates for observability, ecosystem, and scale.
Notes:
1. Routing/failover is policy-driven, logged, and tested under simulated outages.
2. Evaluation framework supports datasets, metrics, and baseline comparison reports.
3. OTel/Prom exports are configurable and verified against a reference stack.
4. TUI topology view renders live DAGs with stable performance on large runs.
5. Retention/archival/replay provide deterministic replay with pinned versions.
6. Plugin API is versioned with compatibility checks and at least one reference plugin.
7. Import/export and triggers are usable end-to-end with security guidance.
8. Embedded binaries and remote runners have a documented workflow and a working demo.

## P0 - Foundation reliability (next 1-2 releases)

### Typed step input/output schemas with runtime validation
Goal: Provide strong guarantees about step inputs and outputs so failures are caught early and surfaced with precise context. This should cover all step types, not just LLM steps, and integrate with expression evaluation.
Tasks:
1. [x] Extend workflow schema to allow optional `inputSchema` and `outputSchema` per step (JSON Schema only).
2. [x] Validate step inputs at scheduling time and outputs at completion time with path-level error details.
3. [x] `keystone validate --strict` updated.
4. [x] Propagate typed outputs into the expression engine.
5. [x] Document examples and migration guidance for existing workflows.

### Idempotency keys and automatic deduplication
Goal: Make retries safe for side-effecting steps (HTTP, shell, file, LLM) and for resume scenarios by reusing prior outputs when a unique key matches.
Tasks:
1. [x] Add optional `idempotencyKey` on steps and a per-run dedup scope with TTL (default scope: run).
2. [x] Persist idempotency records in the DB with status, outputs, and hashes.
3. [x] Implement de-dup behavior for retries/resume, including "in-flight" detection.
4. [x] Add CLI controls for clearing dedup entries and toggling behavior.

### Structured output validation with auto retry/repair
Goal: Close the loop on LLM structured outputs by automatically re-asking or repairing when schema validation fails.
Tasks:
1. [x] Add per-step config for `outputRetries` and `repairStrategy` (re-ask, repair-only, or hybrid) when `outputSchema` validation fails.
2. [x] Implement automatic re-ask with validation error context and a compact repair prompt.
3. [x] Record repair attempts and final validation failures in logs and run metadata.
4. [x] Document recommended schemas and best practices for stable output.

### Better error messages with context and suggested fixes
Goal: Make workflow failures actionable by adding context (line, expression, step inputs) and likely fixes for common issues.
Tasks:
1. [x] Build an error renderer for YAML and expression errors with line/column and source snippets.
2. [x] Add suggestions for common cases (unknown step id, missing inputs, schema mismatch).
3. [x] Attach resolved inputs, attempt count, and step metadata to failure logs.
4. [x] Add a `--explain` mode to print expanded diagnostics.

### Global `errors` block for workflow-level recovery
Goal: Provide a top-level recovery path that runs when a step exhausts retries, enabling overseer-style analysis.
Tasks:
1. [x] Add `errors` blocks to the workflow schema with access to `last_failed_step`.
2. [x] Ensure `errors` steps run after retries/auto_heal are exhausted and before `finally`.
3. [x] Add output contracts so recovery steps can annotate the run summary without flipping status.
4. [x] Document patterns for agentic self-reflection and escalation.

### Task-level `allowFailure` for fail-forward steps
Goal: Allow steps to fail without stopping the workflow, while preserving error context for downstream logic.
Tasks:
1. [x] Add `allowFailure: boolean` to step schema and execution logic.
2. [x] Record exit status and error output while marking the step `success`.
3. [x] Ensure `allowFailure` interacts cleanly with `retry`, `auto_heal`, and `errors` blocks.
4. [x] Document patterns for agentic exploration steps.

### Input enums and secret-typed inputs
Goal: Strengthen guardrails by restricting input values and pre-declaring redaction.
Tasks:
1. [x] Extend `InputSchema` with `values` (enum) and `secret` flags.
2. [x] Enforce enum validation at parse time and in `keystone validate` (runtime validation now enforced).
3. [x] Integrate `secret` inputs with the redactor for logs/UI and redact at rest by default (config toggle).
4. [x] Add examples and migration notes.

### Interrupt support and safe cancellation (AbortSignal)
Goal: Allow users to stop large parallel loops without corrupting the SQLite state and mark runs as canceled cleanly.
Tasks:
1. Add AbortController/Signal to `WorkflowRunner` and step executors.
2. Handle SIGINT/SIGTERM to request cancellation and persist run state.
3. Ensure foreach cancellation drains in-flight steps and blocks new scheduling.
4. Add tests for cancellation, resume, and idempotency interactions.

## P1 - Developer experience and safe orchestration (next 2-4 releases)

### Durable timers for long-running workflows
Goal: Allow sleeps and human waits to persist across restarts and pause for hours or days without losing state.
Tasks:
1. Persist sleep and human wait states with wake-up timestamps in the DB.
2. Add a lightweight scheduler to resume runs at the right time.
3. Ensure timeouts and retries are consistent across restarts.
4. Document semantics and edge cases (clock skew, daylight changes).

### Dynamic subflows with fan-out/fan-in and compensations
Goal: Support complex orchestration patterns with safe rollbacks for side effects.
Tasks:
1. Add a fan-out/fan-in join step with explicit join conditions and timeouts.
2. Introduce `compensate` blocks for steps and sub-workflows.
3. Provide rollback semantics and ordering guarantees.
4. Ship example workflows that demonstrate compensation patterns.

### Sub-workflow output contracts and mapping
Goal: Make sub-workflow outputs predictable, namespaced, and easy to consume.
Tasks:
1. Enforce an outputs contract for `type: workflow` steps.
2. Namespace sub-workflow outputs under `steps.<id>.outputs`.
3. Add validation for missing outputs and type mismatches.
4. Document patterns for contract-first subflows.

### Concurrency limits and backpressure management
Goal: Avoid overload by introducing global and per-resource concurrency pools with fair scheduling.
Tasks:
1. Add resource pools by step type and optional tags (e.g., `llm`, `http`, `shell`).
2. Implement queueing with priority and fair scheduling.
3. Expose queue depth, wait time, and utilization metrics.
4. Add config for defaults and per-workflow overrides.

### Engine step for external autonomous tools
Goal: Allow workflows to hand off tasks to autonomous CLIs as first-class steps and capture their structured summary.
Tasks:
1. Add `engine` step type and schema (command, args, input, env, timeout, cwd).
2. Implement an executor that spawns the external CLI, streams logs, and captures a final summary output.
3. Add optional `handoff` support so `llm` steps can delegate to an engine with structured inputs.
4. Provide examples and safety controls (allowInsecure, idempotencyKey, redaction).

### Blueprint -> Plan -> Engineer workflow specialization
Goal: Produce a system blueprint artifact before planning and generation to ensure consistency across parallel work.
Tasks:
1. Update scaffold workflows to require a `blueprint` artifact (JSON/YAML) describing schema, APIs, and file tree.
2. Validate blueprint against a schema and persist it as a run artifact.
3. Make plan and generation steps consume the blueprint and enforce constraints per file/task.
4. Add examples and migration notes for existing scaffold workflows.

### XDG compliance and workspace isolation
Goal: Support global config and shared memory in XDG paths while keeping project state in the CWD.
Tasks:
1. Add config discovery in `~/.config/keystone/` with clear precedence rules.
2. Store global data in `~/.local/share/keystone/` and keep project runs in `.keystone/`.
3. Add config flags for global memory vs project memory and explicit overrides.
4. Provide migration docs and a `keystone config migrate` helper.

### VS Code integration for schema validation and autocomplete
Goal: Improve authoring by providing validation, autocomplete, and inline diagnostics for workflows and agents.
Tasks:
1. Publish JSON schemas for workflows and agents.
2. Build a VS Code extension with validation and autocomplete.
3. Add hover docs for fields and examples.
4. Keep schema versions aligned with CLI releases.

### Workflow blueprints and remote registry
Goal: Provide a searchable library of community workflows and agents with one-command install.
Tasks:
1. Add `keystone blueprints` / `keystone get <name>` commands.
2. Extend the workflow registry to support remote GitHub sources.
3. Add version pinning and signature/verification options.
4. Document publishing and update workflows.

### Workflow testing framework with fixtures and snapshots
Goal: Enable deterministic workflow testing with fixtures, snapshots, and mocks for LLMs and external calls.
Tasks:
1. Add `keystone test` to run workflows in a test harness with fixture inputs.
2. Provide snapshot outputs with update workflow.
3. Add deterministic LLM mocks and time control utilities.
4. Document recommended test patterns.

### Debug bundles for sharing workflow state and logs
Goal: Provide a one-command way to package the data needed for support and reproduction.
Tasks:
1. Add `keystone debug bundle <run_id>` to capture logs, config, and workflow files.
2. Redact secrets automatically and include a redaction report.
3. Package as a single archive with manifest and metadata.
4. Document how to load a bundle for replay.

### LLM caching with offline replay mode
Goal: Reduce cost and enable reproducible runs by caching LLM calls and replaying responses.
Tasks:
1. Add a cache layer keyed by model, prompt, tool context, and system inputs.
2. Persist cache in SQLite with TTL and size limits.
3. Add `cached_tokens` in usage tracking and surface savings in logs/UI/metrics.
4. Implement `--replay` mode with cache hit rate and storage usage stats.

## P2 - Observability, AI evaluation, and ecosystem (later)

### Multi-provider routing with failover
Goal: Improve reliability and cost control with policy-driven provider selection and automatic failover.
Tasks:
1. Add routing policies by priority, latency, cost, and region.
2. Implement failover on rate limits and timeouts with backoff.
3. Expose provider choice and fallback events in logs and metrics.
4. Add config examples and migration notes.

### Built-in evaluation framework for workflows
Goal: Measure workflow quality against datasets and track metrics over time.
Tasks:
1. Add a dataset runner for JSONL/CSV inputs and golden outputs.
2. Record metrics (pass/fail, scores, latency, cost) per run.
3. Provide comparison reports between baselines and candidates.
4. Document evaluation workflows and metrics definitions.

### OpenTelemetry tracing and Prometheus-style metrics
Goal: Provide standard observability signals for runs, steps, and resource usage.
Tasks:
1. Instrument runs and steps with tracing spans and attributes.
2. Export metrics for durations, retries, queues, and token usage (including cached tokens).
3. Add configuration for exporters and sampling.
4. Provide deployment guides for common stacks.

### Enhanced terminal UI with live DAG and resource usage
Goal: Improve operational visibility with live graphs and capacity signals.
Tasks:
1. Add a live topology view with active node highlighting and step timing.
2. Add a compact ASCII/box-drawing DAG view derived from mermaid utilities.
3. Add toast notifications for success/failure/auto-heal events.
4. Add a side pane for tool-call loop events and step log drill-down.
5. Keep the UI performant and detect terminal capabilities (color, background).

### Configurable retention, archival, and one-click replay
Goal: Make historical runs easy to retain, share, and replay consistently.
Tasks:
1. Add retention policies per workflow and run tagging.
2. Add archival storage and metadata indexing.
3. Implement `keystone replay <run_id>` with pinned versions.
4. Add UI hooks for replay and archive management.

### Plugin system and curated plugin library
Goal: Make providers, tools, and step types extensible via a stable plugin API.
Tasks:
1. Define a plugin API with versioning and compatibility checks.
2. Add discovery, loading, and isolation for plugins.
3. Provide a curated plugin registry with linting and docs.
4. Document plugin authoring and distribution.

### Import/export bridges for external workflow formats
Goal: Ease migration and interoperability with popular orchestrators.
Tasks:
1. Build converters to and from GitHub Actions and Kestra.
2. Add validation and manual mapping hints for unsupported features.
3. Provide docs and examples for round-trip conversion.
4. Add CLI commands for import/export.

### Event triggers for scheduled and webhook-driven runs
Goal: Enable event-driven workflows while keeping local-first defaults.
Tasks:
1. Add a `triggers` block with schedule and webhook triggers.
2. Implement a lightweight daemon mode for background execution.
3. Add CLI controls for enabling/disabling triggers per workflow.
4. Document security considerations and local network usage.

### Embedded resources and standalone binaries
Goal: Allow users to compile a project into a single executable that bundles workflows and agents.
Tasks:
1. Add `keystone compile` to bundle `.keystone` assets into an executable.
2. Use `bun build --compile` with embedded asset lookup at runtime.
3. Support override precedence between embedded assets and local files.
4. Document distribution and update workflows for compiled binaries.

### Self-bootstrapping DevMode workflow
Goal: Dogfood Keystone by enabling it to modify its own codebase safely.
Tasks:
1. Add a built-in DevMode workflow with tools to read files, run tests, and write patches.
2. Add guardrails for sandboxing, approvals, and file scope.
3. Provide templates for common maintenance tasks (new step type, schema update, tests).
4. Document recommended human-in-the-loop checks.

### Lightweight distributed mode with remote runners
Goal: Support scaling beyond a single machine while keeping local-first defaults.
Tasks:
1. Define a remote runner protocol and worker registration flow.
2. Add run sharding with artifact sync and checkpointing.
3. Implement auth and permission boundaries for remote execution.
4. Provide a local-to-remote migration guide.
