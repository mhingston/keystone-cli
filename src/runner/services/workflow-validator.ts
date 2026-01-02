import type { Workflow, WorkflowInput } from '../../parser/schema.ts';
import { Redactor } from '../../utils/redactor.ts';
import { validateJsonSchema } from '../../utils/schema-validator.ts';
import { SecretManager } from './secret-manager.ts';

/**
 * Service for validating workflow inputs and applying defaults.
 */
export class WorkflowValidator {
  public static readonly REDACTED_PLACEHOLDER = Redactor.REDACTED_PLACEHOLDER;

  constructor(
    private workflow: Workflow,
    private inputs: Record<string, unknown>
  ) {}

  /**
   * Apply workflow defaults to inputs and validate types.
   * Returns the set of secret values found in the inputs.
   */
  public applyDefaultsAndValidate(): { secretValues: string[] } {
    if (!this.workflow.inputs) return { secretValues: [] };

    const secretValues = new Set<string>();

    for (const [key, config] of Object.entries(this.workflow.inputs)) {
      const inputConfig = config as WorkflowInput;

      // Apply default if missing
      if (this.inputs[key] === undefined && inputConfig.default !== undefined) {
        this.inputs[key] = inputConfig.default;
      }

      if (inputConfig.secret) {
        if (this.inputs[key] === WorkflowValidator.REDACTED_PLACEHOLDER) {
          throw new Error(
            `Secret input "${key}" was redacted at rest. Please provide it again to resume this run.`
          );
        }
      }

      // Validate required inputs
      if (this.inputs[key] === undefined) {
        throw new Error(`Missing required input: ${key}`);
      }

      // Basic type validation
      const value = this.inputs[key];
      const type = inputConfig.type.toLowerCase();

      if (type === 'string' && typeof value !== 'string') {
        throw new Error(`Input "${key}" must be a string, got ${typeof value}`);
      }
      if (type === 'number' && typeof value !== 'number') {
        throw new Error(`Input "${key}" must be a number, got ${typeof value}`);
      }
      if (type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Input "${key}" must be a boolean, got ${typeof value}`);
      }
      if (type === 'array' && !Array.isArray(value)) {
        throw new Error(`Input "${key}" must be an array, got ${typeof value}`);
      }
      if (
        type === 'object' &&
        (typeof value !== 'object' || value === null || Array.isArray(value))
      ) {
        throw new Error(`Input "${key}" must be an object, got ${typeof value}`);
      }

      if (inputConfig.values) {
        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
          throw new Error(`Input "${key}" cannot use enum values with type "${type}"`);
        }
        for (const allowed of inputConfig.values) {
          const matchesType =
            (type === 'string' && typeof allowed === 'string') ||
            (type === 'number' && typeof allowed === 'number') ||
            (type === 'boolean' && typeof allowed === 'boolean');
          if (!matchesType) {
            throw new Error(
              `Input "${key}" enum value ${JSON.stringify(allowed)} must be a ${type}`
            );
          }
        }
        if (!inputConfig.values.includes(value as string | number | boolean)) {
          throw new Error(
            `Input "${key}" must be one of: ${inputConfig.values.map((v) => JSON.stringify(v)).join(', ')}`
          );
        }
      }

      if (
        inputConfig.secret &&
        value !== undefined &&
        value !== WorkflowValidator.REDACTED_PLACEHOLDER
      ) {
        SecretManager.collectSecretValues(value, secretValues, new WeakSet());
      }
    }

    return { secretValues: Array.from(secretValues) };
  }

  /**
   * Validate data against a JSON schema.
   */
  public validateSchema(
    kind: 'input' | 'output',
    schema: unknown,
    data: unknown,
    stepId: string
  ): void {
    try {
      const result = validateJsonSchema(schema, data);
      if (result.valid) return;
      const details = result.errors.map((line: string) => `  - ${line}`).join('\n');
      throw new Error(
        `${kind === 'input' ? 'Input' : 'Output'} schema validation failed for step "${stepId}":\n${details}`
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('schema validation failed for step')) {
          throw error;
        }
        throw new Error(
          `${kind === 'input' ? 'Input' : 'Output'} schema error for step "${stepId}": ${error.message}`
        );
      }
      throw error;
    }
  }
}
