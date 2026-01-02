/**
 * Dynamic State Manager
 *
 * Manages persistence for dynamic workflow steps, enabling resumability
 * of LLM-orchestrated workflows.
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  DynamicPlan,
  DynamicStepExecution,
  DynamicStepState,
  GeneratedStep,
} from '../runner/executors/dynamic-types.ts';

export type { DynamicPlan, DynamicStepExecution, DynamicStepState, GeneratedStep };
import type { WorkflowDb } from './workflow-db.ts';

/**
 * Raw row from dynamic_workflow_state table
 */
interface DynamicStateRow {
  id: string;
  run_id: string;
  step_id: string;
  workflow_id: string | null;
  status: string;
  generated_plan: string;
  current_step_index: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  metadata: string | null;
  replan_count: number;
}

/**
 * Raw row from dynamic_step_executions table
 */
interface DynamicExecRow {
  id: string;
  state_id: string;
  step_id: string;
  step_name: string;
  step_type: string;
  step_definition: string;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  execution_order: number;
}

/**
 * Manages persistence for dynamic workflow steps
 */
export class DynamicStateManager {
  constructor(private db: WorkflowDb) {}

  /**
   * Access the underlying database for direct queries
   */
  private getDatabase(): Database {
    return this.db.getDatabase();
  }

  /**
   * Create a new dynamic state record
   */
  async create(params: {
    runId: string;
    stepId: string;
    workflowId?: string;
  }): Promise<DynamicStepState> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const state: DynamicStepState = {
      id,
      runId: params.runId,
      stepId: params.stepId,
      workflowId: params.workflowId || params.runId, // Fallback to runId if workflowId not provided
      status: 'planning',
      generatedPlan: { steps: [] },
      currentStepIndex: 0,
      stepResults: new Map(),
      startedAt: now,
      replanCount: 0,
    };

    const db = this.getDatabase();
    db.prepare(`
      INSERT INTO dynamic_workflow_state 
      (id, run_id, step_id, workflow_id, status, generated_plan, current_step_index, started_at, replan_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.runId,
      params.stepId,
      params.workflowId || null,
      'planning',
      JSON.stringify(state.generatedPlan),
      0,
      now,
      0
    );

    return state;
  }

  /**
   * Load existing state for resume
   */
  async load(runId: string, stepId: string): Promise<DynamicStepState | null> {
    const db = this.getDatabase();
    const row = db
      .prepare(`
      SELECT * FROM dynamic_workflow_state
      WHERE run_id = ? AND step_id = ?
    `)
      .get(runId, stepId) as DynamicStateRow | null;

    if (!row) return null;

    return this.rowToState(row);
  }

  /**
   * Load state by ID
   */
  async loadById(id: string): Promise<DynamicStepState | null> {
    const db = this.getDatabase();
    const row = db
      .prepare(`
      SELECT * FROM dynamic_workflow_state WHERE id = ?
    `)
      .get(id) as DynamicStateRow | null;

    if (!row) return null;

    return this.rowToState(row);
  }

  /**
   * Convert a database row to DynamicStepState
   */
  private rowToState(row: DynamicStateRow): DynamicStepState {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      workflowId: row.workflow_id || row.run_id,
      status: row.status as DynamicStepState['status'],
      generatedPlan: JSON.parse(row.generated_plan),
      currentStepIndex: row.current_step_index,
      stepResults: new Map(),
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      error: row.error || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      replanCount: row.replan_count || 0,
    };
  }

  /**
   * Update state after plan generation
   */
  async setPlan(
    stateId: string,
    plan: DynamicPlan,
    status: DynamicStepState['status'] = 'executing'
  ): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    // Use atomic SQL update to increment replan_count and set new plan
    const result = db
      .prepare(`
      UPDATE dynamic_workflow_state
      SET generated_plan = ?, status = ?, updated_at = ?, replan_count = replan_count + 1
      WHERE id = ?
      RETURNING replan_count
    `)
      .get(JSON.stringify(plan), status, now, stateId) as { replan_count: number } | undefined;

    if (!result) {
      throw new Error(`Failed to update dynamic state: ${stateId}`);
    }
    const replanCount = result.replan_count;

    // Delete previous execution records IF this is a re-plan (optional, but cleaner)
    if (replanCount > 0) {
      db.prepare('DELETE FROM dynamic_step_executions WHERE state_id = ?').run(stateId);
    }

    // Create execution records for each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      db.prepare(`
        INSERT INTO dynamic_step_executions
        (id, state_id, step_id, step_name, step_type, step_definition, status, execution_order)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(randomUUID(), stateId, step.id, step.name, step.type, JSON.stringify(step), i);
    }
  }

  /**
   * Update status and optionally replan count
   */
  async updateStatus(
    stateId: string,
    status: DynamicStepState['status'],
    replanCount?: number
  ): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    if (replanCount !== undefined) {
      db.prepare(`
        UPDATE dynamic_workflow_state
        SET status = ?, replan_count = ?, updated_at = ?
        WHERE id = ?
      `).run(status, replanCount, now, stateId);
    } else {
      db.prepare(`
        UPDATE dynamic_workflow_state
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, now, stateId);
    }
  }

  /**
   * Mark plan as confirmed and ready for execution
   */
  async confirmPlan(stateId: string): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE dynamic_workflow_state
      SET status = 'executing', updated_at = ?
      WHERE id = ?
    `).run(now, stateId);
  }

  /**
   * Update current step index (for resume)
   */
  async updateProgress(stateId: string, stepIndex: number): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE dynamic_workflow_state
      SET current_step_index = ?, updated_at = ?
      WHERE id = ?
    `).run(stepIndex, now, stateId);
  }

  /**
   * Record step execution start
   */
  async startStep(stateId: string, stepId: string): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE dynamic_step_executions
      SET status = 'running', started_at = ?
      WHERE state_id = ? AND step_id = ?
    `).run(now, stateId, stepId);
  }

  /**
   * Record step completion
   */
  async completeStep(
    stateId: string,
    stepId: string,
    result: { status: string; output?: unknown; error?: string }
  ): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    // Map result.status to our status enum
    let status: string;
    switch (result.status) {
      case 'success':
        status = 'success';
        break;
      case 'failed':
        status = 'failed';
        break;
      case 'skipped':
        status = 'skipped';
        break;
      default:
        status = 'failed';
    }

    db.prepare(`
      UPDATE dynamic_step_executions
      SET status = ?, output = ?, error = ?, completed_at = ?
      WHERE state_id = ? AND step_id = ?
    `).run(
      status,
      result.output !== undefined ? JSON.stringify(result.output) : null,
      result.error || null,
      now,
      stateId,
      stepId
    );
  }

  /**
   * Mark workflow as completed or failed
   */
  async finish(stateId: string, status: 'completed' | 'failed', error?: string): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE dynamic_workflow_state
      SET status = ?, error = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, error || null, now, now, stateId);
  }

  /**
   * Get all step executions for a dynamic state
   */
  async getStepExecutions(stateId: string): Promise<DynamicStepExecution[]> {
    const db = this.getDatabase();
    const rows = db
      .prepare(`
      SELECT * FROM dynamic_step_executions
      WHERE state_id = ?
      ORDER BY execution_order ASC
    `)
      .all(stateId) as DynamicExecRow[];

    return rows.map((row) => ({
      id: row.id,
      stateId: row.state_id,
      stepId: row.step_id,
      stepName: row.step_name,
      stepType: row.step_type,
      stepDefinition: JSON.parse(row.step_definition),
      status: row.status as DynamicStepExecution['status'],
      output: row.output ? JSON.parse(row.output) : undefined,
      error: row.error || undefined,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      executionOrder: row.execution_order,
    }));
  }

  /**
   * Get step results as a Map (for executor integration)
   */
  async getStepResultsMap(
    stateId: string
  ): Promise<Map<string, { output: unknown; status: string; error?: string }>> {
    const executions = await this.getStepExecutions(stateId);
    const map = new Map<string, { output: unknown; status: string; error?: string }>();

    for (const exec of executions) {
      if (exec.status !== 'pending') {
        map.set(exec.stepId, {
          output: exec.output,
          status: exec.status,
          error: exec.error,
        });
      }
    }

    return map;
  }

  /**
   * List all active (non-completed) dynamic states
   */
  async listActive(): Promise<DynamicStepState[]> {
    const db = this.getDatabase();
    const rows = db
      .prepare(`
      SELECT * FROM dynamic_workflow_state
      WHERE status IN ('planning', 'executing')
      ORDER BY started_at DESC
    `)
      .all() as DynamicStateRow[];

    return rows.map((row) => this.rowToState(row));
  }

  /**
   * List dynamic states by run ID
   */
  async listByRun(runId: string): Promise<DynamicStepState[]> {
    const db = this.getDatabase();
    const rows = db
      .prepare(`
      SELECT * FROM dynamic_workflow_state
      WHERE run_id = ?
      ORDER BY started_at ASC
    `)
      .all(runId) as DynamicStateRow[];

    return rows.map((row) => this.rowToState(row));
  }
}
