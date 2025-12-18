import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { ExpressionEvaluator } from '../expression/evaluator.ts';
import { resolveAgentPath } from './agent-parser.ts';
import { type Workflow, WorkflowSchema } from './schema.ts';

export class WorkflowParser {
  /**
   * Load and validate a workflow from a YAML file
   */
  static loadWorkflow(path: string): Workflow {
    try {
      const content = readFileSync(path, 'utf-8');
      const raw = yaml.load(content);
      const workflow = WorkflowSchema.parse(raw);

      // Resolve implicit dependencies from expressions
      WorkflowParser.resolveImplicitDependencies(workflow);

      // Validate DAG (no circular dependencies)
      WorkflowParser.validateDAG(workflow);

      // Validate agents exist
      WorkflowParser.validateAgents(workflow);

      // Validate finally block
      WorkflowParser.validateFinally(workflow);

      return workflow;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues
          .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
          .join('\n');
        throw new Error(`Invalid workflow schema at ${path}:\n${issues}`);
      }
      if (error instanceof Error) {
        throw new Error(`Failed to parse workflow at ${path}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Automatically detect step dependencies from expressions
   */
  private static resolveImplicitDependencies(workflow: Workflow): void {
    const allSteps = [...workflow.steps, ...(workflow.finally || [])];
    for (const step of allSteps) {
      const detected = new Set<string>();

      // Helper to scan any value for dependencies
      const scan = (value: unknown) => {
        if (typeof value === 'string') {
          for (const dep of ExpressionEvaluator.findStepDependencies(value)) {
            detected.add(dep);
          }
        } else if (Array.isArray(value)) {
          for (const item of value) {
            scan(item);
          }
        } else if (value && typeof value === 'object') {
          for (const val of Object.values(value)) {
            scan(val);
          }
        }
      };

      // Scan all step properties
      scan(step);

      // Add detected dependencies to step.needs
      for (const depId of detected) {
        // Step cannot depend on itself
        if (depId !== step.id && !step.needs.includes(depId)) {
          step.needs.push(depId);
        }
      }
    }
  }

  /**
   * Validate that the workflow forms a valid DAG (no cycles)
   */
  private static validateDAG(workflow: Workflow): void {
    const stepMap = new Map(workflow.steps.map((step) => [step.id, step.needs]));
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (stepId: string): boolean => {
      if (!visited.has(stepId)) {
        visited.add(stepId);
        recursionStack.add(stepId);

        const dependencies = stepMap.get(stepId) || [];
        for (const dep of dependencies) {
          if (!stepMap.has(dep)) {
            throw new Error(`Step "${stepId}" depends on non-existent step "${dep}"`);
          }
          if (!visited.has(dep) && hasCycle(dep)) {
            return true;
          }
          if (recursionStack.has(dep)) {
            return true;
          }
        }
      }
      recursionStack.delete(stepId);
      return false;
    };

    for (const step of workflow.steps) {
      if (hasCycle(step.id)) {
        throw new Error(`Circular dependency detected involving step "${step.id}"`);
      }
    }
  }

  /**
   * Validate that all agents referenced in LLM steps exist
   */
  private static validateAgents(workflow: Workflow): void {
    const allSteps = [...workflow.steps, ...(workflow.finally || [])];
    for (const step of allSteps) {
      if (step.type === 'llm') {
        try {
          resolveAgentPath(step.agent);
        } catch (error) {
          throw new Error(`Agent "${step.agent}" referenced in step "${step.id}" not found.`);
        }
      }
    }
  }

  /**
   * Validate finally block
   */
  private static validateFinally(workflow: Workflow): void {
    if (!workflow.finally) return;

    const mainStepIds = new Set(workflow.steps.map((s) => s.id));
    const finallyStepIds = new Set<string>();

    for (const step of workflow.finally) {
      if (mainStepIds.has(step.id)) {
        throw new Error(`Step ID "${step.id}" in finally block conflicts with main steps`);
      }
      if (finallyStepIds.has(step.id)) {
        throw new Error(`Duplicate Step ID "${step.id}" in finally block`);
      }
      finallyStepIds.add(step.id);

      // Finally steps can only depend on main steps or previous finally steps
      for (const dep of step.needs) {
        if (!mainStepIds.has(dep) && !finallyStepIds.has(dep)) {
          throw new Error(
            `Finally step "${step.id}" depends on non-existent step "${dep}". Finally steps can only depend on main steps or previous finally steps.`
          );
        }
      }
    }
  }

  /**
   * Perform topological sort on steps
   * Returns steps in execution order
   */
  static topologicalSort(workflow: Workflow): string[] {
    const stepMap = new Map(workflow.steps.map((step) => [step.id, step.needs]));
    const inDegree = new Map<string, number>();

    // Validate all dependencies exist before sorting
    for (const step of workflow.steps) {
      for (const dep of step.needs) {
        if (!stepMap.has(dep)) {
          throw new Error(`Step "${step.id}" depends on non-existent step "${dep}"`);
        }
      }
    }

    // Calculate in-degree
    // In-degree = number of dependencies a step has
    for (const step of workflow.steps) {
      inDegree.set(step.id, step.needs.length);
    }

    // Kahn's algorithm
    const queue: string[] = [];
    const result: string[] = [];

    // Add all nodes with in-degree 0
    for (const [stepId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(stepId);
      }
    }

    while (queue.length > 0) {
      const stepId = queue.shift();
      if (!stepId) continue;
      result.push(stepId);

      // Find all steps that depend on this step
      for (const step of workflow.steps) {
        if (step.needs.includes(stepId)) {
          const newDegree = (inDegree.get(step.id) || 0) - 1;
          inDegree.set(step.id, newDegree);
          if (newDegree === 0) {
            queue.push(step.id);
          }
        }
      }
    }

    if (result.length !== workflow.steps.length) {
      throw new Error('Topological sort failed - circular dependency detected');
    }

    return result;
  }
}
