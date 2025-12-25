import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import './sqlite-setup.ts';
import { PathResolver } from '../utils/paths';
import {
  StepStatus as StepStatusConst,
  type StepStatusType,
  WorkflowStatus as WorkflowStatusConst,
  type WorkflowStatusType,
} from '../types/status';

export type RunStatus = WorkflowStatusType | 'pending';
export type StepStatus = StepStatusType;

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  status: RunStatus;
  inputs: string; // JSON
  outputs: string | null; // JSON
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StepExecution {
  id: string;
  run_id: string;
  step_id: string;
  iteration_index: number | null;
  status: StepStatus;
  output: string | null; // JSON
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  usage: string | null; // JSON
}

export interface IdempotencyRecord {
  idempotency_key: string;
  run_id: string;
  step_id: string;
  status: StepStatus;
  output: string | null; // JSON
  error: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface DurableTimer {
  id: string;
  run_id: string;
  step_id: string;
  timer_type: 'sleep' | 'human';
  wake_at: string | null; // ISO datetime - null for human-triggered timers
  created_at: string;
  completed_at: string | null;
}

export interface CompensationRecord {
  id: string;
  run_id: string;
  step_id: string;
  compensation_step_id: string; // The ID of the compensation step definition (usually randomUUID)
  definition: string; // JSON definition of the compensation step
  status: StepStatus;
  output: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export class WorkflowDb {
  private db: Database;

  constructor(public readonly dbPath = PathResolver.resolveDbPath()) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;'); // Write-ahead logging
    this.db.exec('PRAGMA foreign_keys = ON;'); // Enable foreign key enforcement
    this.db.exec('PRAGMA busy_timeout = 5000;'); // Retry busy signals for up to 5s
    this.initSchema();
  }

  /**
   * Type guard to check if an error is a SQLite busy error
   */
  private isSQLiteBusyError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      const err = error as { code?: string | number; message?: string };
      return (
        err.code === 'SQLITE_BUSY' ||
        err.code === 5 ||
        (typeof err.message === 'string' &&
          (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked')))
      );
    }
    return false;
  }

  /**
   * Retry wrapper for SQLite operations that may encounter SQLITE_BUSY errors
   * during high concurrency scenarios (e.g., foreach loops)
   */
  private async withRetry<T>(operation: () => T, maxRetries = 10): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        // Check if this is a SQLITE_BUSY error
        if (this.isSQLiteBusyError(error)) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Exponential backoff with jitter: 20ms base
          const delayMs = 20 * 1.5 ** attempt + Math.random() * 20;
          await Bun.sleep(delayMs);
          continue;
        }
        // If it's not a SQLITE_BUSY error, throw immediately
        throw error;
      }
    }

    throw lastError || new Error('SQLite operation failed after retries');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        inputs TEXT NOT NULL,
        outputs TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS step_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        iteration_index INTEGER,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        retry_count INTEGER DEFAULT 0,
        usage TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_name);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON workflow_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_steps_run ON step_executions(run_id);
      CREATE INDEX IF NOT EXISTS idx_steps_status ON step_executions(status);
      CREATE INDEX IF NOT EXISTS idx_steps_iteration ON step_executions(run_id, step_id, iteration_index);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_run ON idempotency_records(run_id);
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_records(expires_at);

      CREATE TABLE IF NOT EXISTS durable_timers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        timer_type TEXT NOT NULL,
        wake_at TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_timers_wake ON durable_timers(wake_at);
      CREATE INDEX IF NOT EXISTS idx_timers_run ON durable_timers(run_id);
      CREATE INDEX IF NOT EXISTS idx_timers_pending ON durable_timers(wake_at, completed_at);

      CREATE TABLE IF NOT EXISTS compensations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        compensation_step_id TEXT NOT NULL,
        definition TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_compensations_run ON compensations(run_id);
      CREATE INDEX IF NOT EXISTS idx_compensations_status ON compensations(status);
    `);
  }

  // ===== Workflow Runs =====

  async createRun(
    id: string,
    workflowName: string,
    inputs: Record<string, unknown>
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT INTO workflow_runs (id, workflow_name, status, inputs, started_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(id, workflowName, 'pending', JSON.stringify(inputs), new Date().toISOString());
    });
  }

  async updateRunStatus(
    id: string,
    status: RunStatus,
    outputs?: Record<string, unknown>,
    error?: string
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE workflow_runs
        SET status = ?, outputs = ?, error = ?, completed_at = ?
        WHERE id = ?
      `);
      const completedAt =
        status === 'success' || status === 'failed' ? new Date().toISOString() : null;
      stmt.run(status, outputs ? JSON.stringify(outputs) : null, error || null, completedAt, id);
    });
  }

  /**
   * Helper for synchronous retries on SQLITE_BUSY
   * Since bun:sqlite is synchronous, we use a busy-wait loop with sleep
   */

  /**
   * Get a workflow run by ID
   * @note Synchronous method - wrapped in sync retry logic
   */
  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?');
      return stmt.get(id) as WorkflowRun | null;
    });
  }

  /**
   * List recent workflow runs
   * @note Synchronous method - wrapped in sync retry logic
   */
  async listRuns(limit = 50): Promise<WorkflowRun[]> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM workflow_runs
        ORDER BY started_at DESC
        LIMIT ?
      `);
      return stmt.all(limit) as WorkflowRun[];
    });
  }

  /**
   * Delete workflow runs older than the specified number of days
   * Associated step executions are automatically deleted via CASCADE
   */
  async pruneRuns(days: number): Promise<number> {
    return await this.withRetry(() => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffIso = cutoffDate.toISOString();

      const stmt = this.db.prepare('DELETE FROM workflow_runs WHERE started_at < ?');
      const result = stmt.run(cutoffIso);

      return result.changes;
    });
  }

  async vacuum(): Promise<void> {
    await this.withRetry(() => {
      this.db.exec('VACUUM;');
    });
  }

  // ===== Step Executions =====

  async createStep(
    id: string,
    runId: string,
    stepId: string,
    iterationIndex: number | null = null
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT INTO step_executions (id, run_id, step_id, iteration_index, status, retry_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, runId, stepId, iterationIndex, 'pending', 0);
    });
  }

  async startStep(id: string): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE step_executions
        SET status = ?, started_at = ?
        WHERE id = ?
      `);
      stmt.run('running', new Date().toISOString(), id);
    });
  }

  async completeStep(
    id: string,
    status: StepStatus,
    output?: unknown,
    error?: string,
    usage?: unknown
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE step_executions
        SET status = ?, output = ?, error = ?, completed_at = ?, usage = ?
        WHERE id = ?
      `);
      stmt.run(
        status,
        output === undefined ? null : JSON.stringify(output),
        error || null,
        new Date().toISOString(),
        usage === undefined ? null : JSON.stringify(usage),
        id
      );
    });
  }

  async incrementRetry(id: string): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE step_executions
        SET retry_count = retry_count + 1
        WHERE id = ?
      `);
      stmt.run(id);
    });
  }

  /**
   * Get a step execution by run ID, step ID, and iteration index
   * @note Synchronous method - wrapped in sync retry logic
   */
  async getStepByIteration(
    runId: string,
    stepId: string,
    iterationIndex: number
  ): Promise<StepExecution | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM step_executions
        WHERE run_id = ? AND step_id = ? AND iteration_index = ?
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get(runId, stepId, iterationIndex) as StepExecution | null;
    });
  }

  /**
   * Get the main execution (non-iteration) of a step
   */
  public async getMainStep(runId: string, stepId: string): Promise<StepExecution | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM step_executions
        WHERE run_id = ? AND step_id = ? AND iteration_index IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get(runId, stepId) as StepExecution | null;
    });
  }

  /**
   * Get all step executions for a workflow run
   * @note Synchronous method - wrapped in sync retry logic
   */
  async getStepsByRun(runId: string, limit = -1, offset = 0): Promise<StepExecution[]> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM step_executions
        WHERE run_id = ?
        ORDER BY started_at ASC, iteration_index ASC, rowid ASC
        LIMIT ? OFFSET ?
      `);
      return stmt.all(runId, limit, offset) as StepExecution[];
    });
  }

  async getSuccessfulRuns(workflowName: string, limit = 3): Promise<WorkflowRun[]> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM workflow_runs
        WHERE workflow_name = ? AND status = 'success'
        ORDER BY started_at DESC
        LIMIT ?
      `);
      return stmt.all(workflowName, limit) as WorkflowRun[];
    });
  }

  /**
   * Get the most recent run for a specific workflow
   */
  async getLastRun(workflowName: string): Promise<WorkflowRun | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM workflow_runs
        WHERE workflow_name = ?
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get(workflowName) as WorkflowRun | null;
    });
  }
  // ===== Idempotency Records =====

  /**
   * Get an idempotency record by key
   * Returns null if not found or expired
   */
  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM idempotency_records
        WHERE idempotency_key = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      `);
      return stmt.get(key) as IdempotencyRecord | null;
    });
  }

  /**
   * Remove an expired idempotency record by key
   */
  async clearExpiredIdempotencyRecord(key: string): Promise<number> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare(`
        DELETE FROM idempotency_records
        WHERE idempotency_key = ?
        AND expires_at IS NOT NULL
        AND expires_at < datetime('now')
      `);
      const result = stmt.run(key);
      return result.changes;
    });
  }

  /**
   * Insert an idempotency record only if it doesn't exist
   */
  async insertIdempotencyRecordIfAbsent(
    key: string,
    runId: string,
    stepId: string,
    status: StepStatus,
    ttlSeconds?: number
  ): Promise<boolean> {
    return await this.withRetry(() => {
      const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO idempotency_records
        (idempotency_key, run_id, step_id, status, output, error, created_at, expires_at)
        VALUES (?, ?, ?, ?, NULL, NULL, datetime('now'), ?)
      `);
      const result = stmt.run(key, runId, stepId, status, expiresAt);
      return result.changes > 0;
    });
  }

  /**
   * Mark an idempotency record as running if it's not already running or successful
   */
  async markIdempotencyRecordRunning(
    key: string,
    runId: string,
    stepId: string,
    ttlSeconds?: number
  ): Promise<boolean> {
    return await this.withRetry(() => {
      const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
      const stmt = this.db.prepare(`
        UPDATE idempotency_records
        SET status = ?, run_id = ?, step_id = ?, output = NULL, error = NULL, created_at = datetime('now'), expires_at = ?
        WHERE idempotency_key = ?
        AND status NOT IN (?, ?)
      `);
      const result = stmt.run(
        StepStatusConst.RUNNING,
        runId,
        stepId,
        expiresAt,
        key,
        StepStatusConst.RUNNING,
        StepStatusConst.SUCCESS
      );
      return result.changes > 0;
    });
  }

  /**
   * Store an idempotency record
   * If a record with the same key exists, it will be replaced
   */
  async storeIdempotencyRecord(
    key: string,
    runId: string,
    stepId: string,
    status: StepStatus,
    output?: unknown,
    error?: string,
    ttlSeconds?: number
  ): Promise<void> {
    await this.withRetry(() => {
      const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO idempotency_records
        (idempotency_key, run_id, step_id, status, output, error, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `);
      stmt.run(
        key,
        runId,
        stepId,
        status,
        output === undefined ? null : JSON.stringify(output),
        error || null,
        expiresAt
      );
    });
  }

  /**
   * Remove expired idempotency records
   */
  async pruneIdempotencyRecords(): Promise<number> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare(`
        DELETE FROM idempotency_records
        WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
      `);
      const result = stmt.run();
      return result.changes;
    });
  }

  /**
   * Clear idempotency records for a specific run
   */
  async clearIdempotencyRecords(runId: string): Promise<number> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare('DELETE FROM idempotency_records WHERE run_id = ?');
      const result = stmt.run(runId);
      return result.changes;
    });
  }

  /**
   * List idempotency records, optionally filtered by run ID
   */
  async listIdempotencyRecords(runId?: string): Promise<IdempotencyRecord[]> {
    return this.withRetry(() => {
      if (runId) {
        const stmt = this.db.prepare(`
          SELECT * FROM idempotency_records
          WHERE run_id = ?
          ORDER BY created_at DESC
        `);
        return stmt.all(runId) as IdempotencyRecord[];
      }
      const stmt = this.db.prepare(`
        SELECT * FROM idempotency_records
        ORDER BY created_at DESC
        LIMIT 100
      `);
      return stmt.all() as IdempotencyRecord[];
    });
  }

  /**
   * Clear all idempotency records
   */
  async clearAllIdempotencyRecords(): Promise<number> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare('DELETE FROM idempotency_records');
      const result = stmt.run();
      return result.changes;
    });
  }

  // ===== Durable Timers =====

  /**
   * Create a durable timer for a step
   */
  async createTimer(
    id: string,
    runId: string,
    stepId: string,
    timerType: 'sleep' | 'human',
    wakeAt?: string
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT INTO durable_timers (id, run_id, step_id, timer_type, wake_at, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      stmt.run(id, runId, stepId, timerType, wakeAt || null);
    });
  }

  /**
   * Get a durable timer by ID
   */
  async getTimer(id: string): Promise<DurableTimer | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare('SELECT * FROM durable_timers WHERE id = ?');
      return stmt.get(id) as DurableTimer | null;
    });
  }

  /**
   * Get a durable timer by run ID and step ID
   */
  async getTimerByStep(runId: string, stepId: string): Promise<DurableTimer | null> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM durable_timers
        WHERE run_id = ? AND step_id = ? AND completed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `);
      return stmt.get(runId, stepId) as DurableTimer | null;
    });
  }

  /**
   * Get pending timers that are ready to fire
   * @param before Optional cutoff time (defaults to now)
   */
  async getPendingTimers(
    before?: Date,
    timerType: 'sleep' | 'human' | 'all' = 'sleep'
  ): Promise<DurableTimer[]> {
    return this.withRetry(() => {
      const cutoff = (before || new Date()).toISOString();
      const filterType = timerType !== 'all';
      const stmt = this.db.prepare(`
        SELECT * FROM durable_timers
        WHERE completed_at IS NULL
        AND (wake_at IS NULL OR wake_at <= ?)
        ${filterType ? 'AND timer_type = ?' : ''}
        ORDER BY wake_at ASC
      `);
      return (filterType ? stmt.all(cutoff, timerType) : stmt.all(cutoff)) as DurableTimer[];
    });
  }

  /**
   * Complete a durable timer
   */
  async completeTimer(id: string): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE durable_timers
        SET completed_at = datetime('now')
        WHERE id = ?
      `);
      stmt.run(id);
    });
  }

  /**
   * List all timers, optionally filtered by run ID
   */
  async listTimers(runId?: string, limit = 50): Promise<DurableTimer[]> {
    return this.withRetry(() => {
      if (runId) {
        const stmt = this.db.prepare(`
          SELECT * FROM durable_timers
          WHERE run_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `);
        return stmt.all(runId, limit) as DurableTimer[];
      }
      const stmt = this.db.prepare(`
        SELECT * FROM durable_timers
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(limit) as DurableTimer[];
    });
  }

  /**
   * Clear timers for a specific run or all timers
   */
  async clearTimers(runId?: string): Promise<number> {
    return await this.withRetry(() => {
      if (runId) {
        const stmt = this.db.prepare('DELETE FROM durable_timers WHERE run_id = ?');
        const result = stmt.run(runId);
        return result.changes;
      }
      const stmt = this.db.prepare('DELETE FROM durable_timers');
      const result = stmt.run();
      return result.changes;
    });
  }

  // ===== Compensations =====

  async registerCompensation(
    id: string,
    runId: string,
    stepId: string,
    compensationStepId: string,
    definition: string
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT INTO compensations (id, run_id, step_id, compensation_step_id, definition, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
      `);
      stmt.run(id, runId, stepId, compensationStepId, definition);
    });
  }

  async updateCompensationStatus(
    id: string,
    status: StepStatus,
    output?: unknown,
    error?: string
  ): Promise<void> {
    await this.withRetry(() => {
      const stmt = this.db.prepare(`
        UPDATE compensations
        SET status = ?, output = ?, error = ?, completed_at = ?
        WHERE id = ?
      `);
      const completedAt =
        status === 'success' || status === 'failed' ? new Date().toISOString() : null;
      stmt.run(
        status,
        output === undefined ? null : JSON.stringify(output),
        error || null,
        completedAt,
        id
      );
    });
  }

  async getPendingCompensations(runId: string): Promise<CompensationRecord[]> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM compensations
        WHERE run_id = ? AND status = 'pending'
        ORDER BY created_at DESC, rowid DESC
      `);
      return stmt.all(runId) as CompensationRecord[];
    });
  }

  async getAllCompensations(runId: string): Promise<CompensationRecord[]> {
    return this.withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT * FROM compensations
        WHERE run_id = ?
        ORDER BY created_at DESC, rowid DESC
      `);
      return stmt.all(runId) as CompensationRecord[];
    });
  }

  close(): void {
    this.db.close();
  }
}
