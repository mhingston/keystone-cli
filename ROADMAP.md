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
1. [x] Add AbortController/Signal to `WorkflowRunner` and step executors.
2. [x] Handle SIGINT/SIGTERM to request cancellation and persist run state.
3. [x] Ensure foreach cancellation drains in-flight steps and blocks new scheduling.
4. [x] Add tests for cancellation, resume, and idempotency interactions.

## P1 - Developer experience and safe orchestration (next 2-4 releases)

### [x] Durable timers for long-running workflows
Goal: Allow sleeps and human waits to persist across restarts and pause for hours or days without losing state.
Tasks:
1. [x] Persist sleep and human wait states with wake-up timestamps in the DB.
2. [x] Add a lightweight scheduler to resume runs at the right time.
3. [x] Ensure timeouts and retries are consistent across restarts.
4. [x] Document semantics and edge cases (clock skew, daylight changes).

### [x] Dynamic subflows with fan-out/fan-in and compensations
Goal: Support complex orchestration patterns with safe rollbacks for side effects.
Notes:
1. Fan-out branches should be addressable for join conditions (all/any/quorum/count) with timeouts and partial results.
2. Compensations should run in reverse completion order within a scope (step, subflow, workflow) and be idempotent.
3. Rollbacks should be triggered on error, cancel, or explicit `rollback` while preserving original failure context.
Tasks:
1. [x] Add a fan-out/fan-in join step with explicit join conditions, timeouts, and partial-result behavior.
2. [x] Introduce `compensate` blocks for steps, sub-workflows, and top-level workflows.
3. [x] Define rollback scope, ordering, and escalation rules (what happens when compensation fails).
4. [x] Persist compensation queues/state in the DB for resume-safe execution.
5. [x] Expose join/compensation status in logs and run metadata.
6. [x] Ship example workflows that demonstrate fan-out/fan-in and compensation patterns.

### [x] Sub-workflow output contracts and mapping
Goal: Make sub-workflow outputs predictable, namespaced, and easy to consume.
Notes:
1. Output contracts should be declared at the sub-workflow level and be versionable.
2. Mapping should be explicit (select/rename) with no implicit flattening.
3. Missing outputs should fail by default, with opt-in defaults or allow-missing.
Tasks:
1. [x] Add a workflow-level output contract schema and validation on subflow completion.
2. [x] Namespace sub-workflow outputs under `steps.<id>.outputs.outputs` with optional alias mapping.
3. [x] Support output mapping (select/rename/defaults) on `type: workflow` steps.
4. [x] Add validation for missing outputs and type mismatches with path-level errors.
5. [x] Document patterns for contract-first subflows and migration guidance.

### [x] Concurrency limits and backpressure management
Goal: Avoid overload by introducing global and per-resource concurrency pools with fair scheduling.
Notes:
1. Pools should be global by default with per-workflow overrides.
2. Queueing should be fair and cancel-aware to avoid starvation.
3. Backpressure should interact cleanly with timeouts and retries.
Tasks:
1. [x] Add resource pools by step type and optional tags (e.g., `llm`, `http`, `shell`).
2. [x] Implement queueing with priority, fairness, and cancel-aware removal.
3. [x] Expose queue depth, wait time, and utilization metrics per pool.
4. [x] Add config for defaults and per-workflow overrides, including caps per run.
5. [x] Add tests for fairness, starvation prevention, and timeout interactions.

### Engine step for external autonomous tools
Goal: Allow workflows to hand off tasks to autonomous CLIs as first-class steps and capture their structured summary.
Notes:
1. Engines should be allowlisted and version-pinned; env and cwd must be explicit.
2. Structured summaries should be schema-validated to enable safe chaining.
3. Engine steps should respect idempotency, redaction, and timeouts.
4. Example template lives at `src/templates/engine-example.yaml`.
Tasks:
1. [x] Add `engine` step type and schema (command, args, input, env, timeout, cwd, outputSchema).
2. [x] Define an engine allowlist with pinned versions and enforce it at runtime.
3. [x] Implement an executor that spawns the external CLI, streams logs, and captures stdout/stderr and exit status.
4. [x] Parse a structured summary (JSON/YAML or file output), validate it, and store it as an artifact.
5. [x] Add optional `handoff` support so `llm` steps can delegate to an engine with structured inputs.
6. [x] Add safety controls (allowlists/denylists, idempotencyKey, redaction) with defaults.
7. [x] Provide examples and docs for engine handoffs and summaries.

### Blueprint -> Plan -> Engineer workflow specialization
Goal: Produce a system blueprint artifact before planning and generation to ensure consistency across parallel work.
Notes:
1. The blueprint should be persisted with a version and hash and treated as immutable per run.
2. Plan and generation steps must reference the blueprint and enforce per-file constraints.
3. Drift between the blueprint and outputs should be detectable and reported.
Tasks:
1. Define a blueprint schema (JSON Schema) covering APIs, files, dependencies, and constraints.
2. Update scaffold workflows to require a blueprint creation step and artifact.
3. Validate blueprint and persist it with hash/version; reject unvalidated artifacts.
4. Make plan and generation steps consume the blueprint and enforce constraints per file/task.
5. Add tooling to diff blueprint vs outputs and report drift.
6. Add examples and migration notes for existing scaffold workflows.

### [x] XDG compliance and workspace isolation
Goal: Support global config and shared memory in XDG paths while keeping project state in the CWD.
Notes:
1. Respect XDG base dir env vars with safe fallbacks.
2. Migrations should be previewable and reversible.
3. Project isolation should remain the default.
Tasks:
1. [x] Add config discovery in XDG paths with clear precedence rules (env, project, user, default).
2. [x] Store global data in `~/.local/share/keystone/` and keep project runs in `.keystone/`.
3. [x] Add config flags for global memory vs project memory and explicit overrides.
4. [x] Add tests for path resolution and precedence.

### VS Code integration for schema validation and autocomplete (Descoped)
Goal: Improve authoring by providing validation, autocomplete, and inline diagnostics for workflows and agents.
Notes:
1. Ship the extension with bundled schemas for offline use.
2. Use file associations and `$schema` hints for YAML.
3. Keep schema and extension versions aligned with CLI releases.
Tasks:
1. Publish JSON schemas for workflows and agents with versioned URLs.
2. Add schema association for file globs and `$schema` hints in templates.
3. Build a VS Code extension with validation, autocomplete, and hover docs.
4. Add release automation to keep schema versions aligned with CLI releases.
5. Add smoke tests for schema validation and autocomplete in example workflows.
6. Document installation and compatibility.

### Workflow blueprints and remote registry (Descoped)
Goal: Provide a searchable library of community workflows and agents with one-command install.
Notes:
1. Registry entries should include metadata and compatibility constraints.
2. Support pinned refs and signature verification.
3. Maintain a local cache with provenance.
Tasks:
1. Add `keystone blueprints` / `keystone get <name>` commands with local caching.
2. Extend the workflow registry to support remote GitHub sources and local paths.
3. Add version pinning and signature/verification options with checksums.
4. Define publish/update metadata (name, tags, compatibility, entrypoints).
5. Add smoke tests for remote blueprint install/update flows.
6. Document publishing, discovery, and security.

### Workflow testing framework with fixtures and snapshots
Goal: Enable deterministic workflow testing with fixtures, snapshots, and mocks for LLMs and external calls.
Notes:
1. Deterministic execution should include fixed time and seeded randomness.
2. Mocks should cover LLM, HTTP, shell, and file steps.
3. Snapshot diffs must be readable and reviewable.
Tasks:
1. Add `keystone test` to run workflows in a test harness with fixture inputs.
2. Provide snapshot outputs with an update/accept workflow.
3. Add deterministic LLM mocks, HTTP stubs, and time control utilities.
4. Support per-test config (env, secrets, idempotency, retries).
5. Add smoke tests for the test harness and snapshot update flow.
6. Document recommended test patterns and add sample tests.

### Debug bundles for sharing workflow state and logs (Descoped)
Goal: Provide a one-command way to package the data needed for support and reproduction.
Notes:
1. Bundles should include a manifest with CLI version and run metadata.
2. Redaction should be configurable and auditable.
3. Bundle loading should be safe and read-only by default.
Tasks:
1. Add `keystone debug bundle <run_id>` to capture logs, config, workflow files, and artifacts.
2. Redact secrets automatically and include a redaction report and rules.
3. Package as a single archive with manifest, metadata, and checksums.
4. Add `keystone debug load <bundle>` to inspect or replay safely.
5. Add smoke tests for bundle creation and inspection.
6. Document how to create, share, and consume bundles.

### LLM caching with offline replay mode (Descoped)
Goal: Reduce cost and enable reproducible runs by caching LLM calls and replaying responses.
Notes:
1. Cache keys should include model, prompt, tool context, system inputs, and parameters.
2. Replay mode should be explicit and read-only.
3. Support per-project or global cache locations.
Tasks:
1. Add a cache layer keyed by model, prompt, tool context, system inputs, and parameters.
2. Persist cache in SQLite with TTL and size limits; expose cache stats.
3. Add `cached_tokens` in usage tracking and surface savings in logs/UI/metrics.
4. Add cache location config with per-project and global overrides.
5. Implement `--replay` mode (read-only) with cache hit rate and storage usage stats.
6. Add redaction and opt-out controls with per-project overrides.
7. Add smoke tests for cache hits and replay mode.

## P2 - Observability, AI evaluation, and ecosystem (later)

### Multi-provider routing with failover
Goal: Improve reliability and cost control with policy-driven provider selection and automatic failover.
Notes:
1. Policies should support deterministic ordering and optional weights.
2. Failover should preserve original error context and record decisions.
3. Allow per-workflow and per-step overrides.
Tasks:
1. Add routing policies by priority, latency, cost, region, and weights.
2. Support per-workflow and per-step overrides with a default policy.
3. Implement failover on rate limits and timeouts with backoff and circuit breakers.
4. Expose provider choice, fallback events, and policy decisions in logs and metrics.
5. Add config examples, migration notes, and tests with simulated outages.

### Built-in evaluation framework for workflows
Goal: Measure workflow quality against datasets and track metrics over time.
Notes:
1. Dataset runs should be deterministic and resumable.
2. Metrics should be extensible to support custom evaluators.
3. Store evaluation artifacts for audit and comparison.
Tasks:
1. Add a dataset runner for JSONL/CSV inputs and golden outputs with deterministic ordering.
2. Record metrics (pass/fail, scores, latency, cost) per run and per dataset.
3. Provide comparison reports between baselines and candidates with diffs.
4. Support custom metric hooks and evaluator prompts.
5. Document evaluation workflows, metrics definitions, and report formats.

### OpenTelemetry tracing and Prometheus-style metrics
Goal: Provide standard observability signals for runs, steps, and resource usage.
Notes:
1. Use standard semantic conventions and include run_id/step_id.
2. Exporters should be configurable with low overhead.
3. Provide reference dashboards for common stacks.
Tasks:
1. Instrument runs and steps with tracing spans and attributes.
2. Export metrics for durations, retries, queues, and token usage (including cached tokens).
3. Add configuration for exporters (OTLP, Prom) and sampling.
4. Provide deployment guides and reference dashboards for common stacks.
5. Add tests for instrumentation toggles and no-op mode.

### Enhanced terminal UI with live DAG and resource usage
Goal: Improve operational visibility with live graphs and capacity signals.
Notes:
1. UI should degrade gracefully based on terminal capabilities.
2. Update frequency should be configurable to avoid high CPU.
3. Large DAGs must remain responsive.
Tasks:
1. Add a live topology view with active node highlighting and step timing.
2. Add a compact ASCII/box-drawing DAG view derived from mermaid utilities.
3. Add toast notifications for success/failure/auto-heal events.
4. Add a side pane for tool-call loop events and step log drill-down.
5. Add a resource usage panel (queue depth, utilization, memory).
6. Add a configurable refresh interval with sensible defaults.
7. Keep the UI performant and detect terminal capabilities (color, background).

### Configurable retention, archival, and one-click replay
Goal: Make historical runs easy to retain, share, and replay consistently.
Notes:
1. Retention policies should be global with per-workflow overrides.
2. Archival should start with local storage and be extensible.
3. Replay should pin versions and inputs for determinism.
Tasks:
1. Add retention policies per workflow and run tagging.
2. Add archival storage and metadata indexing (local disk first).
3. Implement `keystone replay <run_id>` with pinned versions and configs.
4. Add UI hooks for replay and archive management.
5. Document retention, archival, and replay workflows.

### Plugin system and curated plugin library
Goal: Make providers, tools, and step types extensible via a stable plugin API.
Notes:
1. The plugin API should be versioned with a manifest and capabilities.
2. Plugins should run in isolation with explicit permissions.
3. The curated registry should enforce linting and tests.
Tasks:
1. Define a plugin API with versioning, manifest, and compatibility checks.
2. Add discovery, loading, and isolation for plugins (sandbox/permissions).
3. Provide a curated plugin registry with linting, tests, and docs.
4. Add CLI commands for install/update/disable and listing.
5. Build at least one reference plugin for the curated registry.
6. Document plugin authoring and distribution.

### Import/export bridges for external workflow formats
Goal: Ease migration and interoperability with popular orchestrators.
Notes:
1. Provide mapping docs for unsupported features and lossy conversions.
2. Round-trip conversions should be tested with fixtures.
3. Prefer explicit mapping hints over silent drops.
Tasks:
1. Build converters to and from GitHub Actions and Kestra.
2. Add validation and manual mapping hints for unsupported features.
3. Provide docs and examples for round-trip conversion.
4. Add CLI commands for import/export with dry-run.
5. Add tests with sample workflows.

### Event triggers for scheduled and webhook-driven runs
Goal: Enable event-driven workflows while keeping local-first defaults.
Notes:
1. Triggers should be off by default and opt-in per workflow.
2. Webhooks should require secrets/signatures and allowlists.
3. Scheduler should reuse durable timers where possible.
Tasks:
1. Add a `triggers` block with schedule and webhook triggers.
2. Implement a lightweight daemon mode for background execution.
3. Reuse the durable timer scheduler for trigger persistence and wake-ups.
4. Add CLI controls for enabling/disabling triggers per workflow.
5. Add webhook verification, secrets, and rate limits.
6. Document security considerations and local network usage.

### Embedded resources and standalone binaries
Goal: Allow users to compile a project into a single executable that bundles workflows and agents.
Notes:
1. Builds should be reproducible and embed a manifest with metadata.
2. Provide clear override precedence between embedded assets and local files.
3. Support versioned updates and cache busting.
Tasks:
1. Add `keystone compile` to bundle `.keystone` assets into an executable.
2. Use `bun build --compile` with embedded asset lookup at runtime.
3. Support override precedence between embedded assets and local files.
4. Embed manifest metadata (version, checksum, build time).
5. Document distribution and update workflows for compiled binaries.

### Self-bootstrapping DevMode workflow
Goal: Dogfood Keystone by enabling it to modify its own codebase safely.
Notes:
1. DevMode should be opt-in and read-only by default.
2. Approvals and file scope should be explicit and auditable.
3. Provide a summary of changes for human review.
Tasks:
1. Add a built-in DevMode workflow with tools to read files, run tests, and write patches.
2. Add guardrails for sandboxing, approvals, and file scope (allowlists).
3. Provide templates for common maintenance tasks (new step type, schema update, tests).
4. Add audit logs and summary of changes for human review.
5. Document recommended human-in-the-loop checks.

### Lightweight distributed mode with remote runners
Goal: Support scaling beyond a single machine while keeping local-first defaults.
Notes:
1. The remote runner protocol should be versioned with compatibility checks.
2. Artifact sync should be resumable and secure.
3. Provide a minimal, documented deployment story.
Tasks:
1. Define a remote runner protocol and worker registration flow.
2. Add run sharding with artifact sync and checkpointing.
3. Implement auth and permission boundaries for remote execution.
4. Add worker health checks and scaling controls.
5. Provide a local-to-remote migration guide and example deployment.
