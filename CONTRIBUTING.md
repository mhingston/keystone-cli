# Contributing to Keystone CLI

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Run `bun lint` to check and `bun lint --write` to auto-fix.

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `workflow-runner.ts` |
| Classes | PascalCase | `WorkflowRunner` |
| Interfaces | PascalCase | `StepResult` |
| Functions | camelCase | `executeStep` |
| Variables | camelCase | `stepResult` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_RETRIES` |
| Type aliases | PascalCase | `StepType` |

### Database/Schema Fields

Database columns and YAML schema fields use `snake_case` to match common conventions:
- `workflow_name`, `step_id`, `created_at`

### Magic Numbers

Extract magic numbers to named constants:

```typescript
// ❌ Bad
const timeout = options.timeout ?? 5000;

// ✅ Good
const DEFAULT_TIMEOUT_MS = 5000;
const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
```

### JSDoc

Add JSDoc to all public classes and methods:

```typescript
/**
 * Execute a workflow step.
 *
 * @param step - The step configuration
 * @param context - Expression evaluation context
 * @returns The step execution result
 */
export async function executeStep(step: Step, context: Context): Promise<StepResult>
```

## Testing

- Tests are co-located with source files (`foo.ts` → `foo.test.ts`)
- Naming conventions:
  - `*.test.ts` for unit tests
  - `*-integration.test.ts` for integration tests
  - `*-audit.test.ts` for security/compliance tests
- Use `bun test` to run tests
- Mock external dependencies (LLM providers, MCP servers, etc.)

## Error Handling

- Use `LLMProviderError` for LLM-related errors
- Include actionable suggestions in error messages
- Log errors with context (step ID, attempt count, etc.)
