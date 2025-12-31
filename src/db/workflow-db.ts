import { Database, type Statement } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import './sqlite-setup.ts';
import {
  StepStatus as StepStatusConst,
  type StepStatusType,
  WorkflowStatus as WorkflowStatusConst,
  type WorkflowStatusType,
} from '../types/status';
import { DB, LIMITS } from '../utils/constants';
import { PathResolver } from '../utils/paths';

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

export interface ThoughtEvent {
  id: string;
  run_id: string;
  workflow_name: string;
  step_id: string;
  content: string;
  source: 'thinking' | 'reasoning';
  created_at: string;
}

/**
 * Base error class for database operations
 */
export class DatabaseError extends Error {
  constructor(
    public override message: string,
    public code?: string | number,
    public retryable = false
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class WorkflowDb {
  private db: Database;

  /**
   * Access the underlying database instance.
   * This is intended for internal extensions like DynamicStateManager.
   */
  public getDatabase(): Database {
    return this.db;
  }

  private createRunStmt!: Statement;
  private updateRunStatusStmt!: Statement;
  private getRunStmt!: Statement;
  private listRunsStmt!: Statement;
  private pruneRunsStmt!: Statement;
  private createStepStmt!: Statement;
  private startStepStmt!: Statement;
  private completeStepStmt!: Statement;
  private incrementRetryStmt!: Statement;
  private getStepByIterationStmt!: Statement;
  private getMainStepStmt!: Statement;
  private getStepIterationsStmt!: Statement;
  private getStepsByRunStmt!: Statement;
  private getSuccessfulRunsStmt!: Statement;
  private getLastRunStmt!: Statement;
  private getIdempotencyRecordStmt!: Statement;
  private clearExpiredIdempotencyRecordStmt!: Statement;
  private insertIdempotencyRecordIfAbsentStmt!: Statement;
  private markIdempotencyRecordRunningStmt!: Statement;
  private storeIdempotencyRecordStmt!: Statement;
  private pruneIdempotencyRecordsStmt!: Statement;
  private clearIdempotencyRecordsStmt!: Statement;
  private listIdempotencyRecordsStmt!: Statement;
  private clearAllIdempotencyRecordsStmt!: Statement;
  private createTimerStmt!: Statement;
  private getTimerStmt!: Statement;
  private getTimerByStepStmt!: Statement;
  private completeTimerStmt!: Statement;
  private registerCompensationStmt!: Statement;
  private updateCompensationStatusStmt!: Statement;
  private getPendingCompensationsStmt!: Statement;
  private getAllCompensationsStmt!: Statement;
  private getStepCacheStmt!: Statement;
  private storeStepCacheStmt!: Statement;
  private getEventStmt!: Statement;
  private storeEventStmt!: Statement;
  private deleteEventStmt!: Statement;
  private createThoughtStmt!: Statement;
  private listThoughtEventsStmt!: Statement;
  private listThoughtEventsByRunStmt!: Statement;
  private listIdempotencyRecordsByRunStmt!: Statement;
  private getStepCacheByWorkflowStmt!: Statement;
  private clearStepCacheByWorkflowStmt!: Statement;
  private getPendingTimersStmt!: Statement;
  private getPendingTimersByTypeStmt!: Statement;
  private listTimersByRunStmt!: Statement;
  private listTimersStmt!: Statement;
  private clearTimersByRunStmt!: Statement;
  private clearAllTimersStmt!: Statement;
  private clearAllStepCacheStmt!: Statement;
  private isClosed = false;

  constructor(public readonly dbPath = PathResolver.resolveDbPath()) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;'); // Write-ahead logging
    this.db.exec('PRAGMA foreign_keys = ON;'); // Enable foreign key enforcement
    this.db.exec('PRAGMA busy_timeout = 5000;'); // Retry busy signals for up to 5s

    // Wrap initialization in try-catch to ensure db is closed on error
    try {
      this.runMigrations();
      this.initStatements();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initStatements(): void {
    this.createRunStmt = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_name, status, inputs, started_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.updateRunStatusStmt = this.db.prepare(`
      UPDATE workflow_runs
      SET status = ?, outputs = ?, error = ?, completed_at = ?
      WHERE id = ?
    `);
    this.getRunStmt = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?');
    this.listRunsStmt = this.db.prepare(`
      SELECT * FROM workflow_runs
      ORDER BY started_at DESC
      LIMIT ?
    `);
    this.pruneRunsStmt = this.db.prepare('DELETE FROM workflow_runs WHERE started_at < ?');
    this.createStepStmt = this.db.prepare(`
      INSERT INTO step_executions (id, run_id, step_id, iteration_index, status, retry_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.startStepStmt = this.db.prepare(`
      UPDATE step_executions
      SET status = ?, started_at = ?
      WHERE id = ?
    `);
    this.completeStepStmt = this.db.prepare(`
      UPDATE step_executions
      SET status = ?, output = ?, error = ?, completed_at = ?, usage = ?
      WHERE id = ?
    `);
    this.incrementRetryStmt = this.db.prepare(`
      UPDATE step_executions
      SET retry_count = retry_count + 1
      WHERE id = ?
    `);
    this.getStepByIterationStmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ? AND step_id = ? AND iteration_index = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    this.getMainStepStmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ? AND step_id = ? AND iteration_index IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `);
    this.getStepIterationsStmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ? AND step_id = ? AND iteration_index IS NOT NULL
      ORDER BY iteration_index ASC
    `);
    this.getStepsByRunStmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ?
      ORDER BY started_at ASC, iteration_index ASC, rowid ASC
      LIMIT ? OFFSET ?
    `);
    this.getSuccessfulRunsStmt = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE workflow_name = ? AND status = 'success'
      ORDER BY started_at DESC
      LIMIT ?
    `);
    this.getLastRunStmt = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE workflow_name = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    this.getIdempotencyRecordStmt = this.db.prepare(`
      SELECT * FROM idempotency_records
      WHERE idempotency_key = ?
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    `);
    this.clearExpiredIdempotencyRecordStmt = this.db.prepare(`
      DELETE FROM idempotency_records
      WHERE idempotency_key = ?
      AND expires_at IS NOT NULL
      AND datetime(expires_at) < datetime('now')
    `);
    this.insertIdempotencyRecordIfAbsentStmt = this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_records
      (idempotency_key, run_id, step_id, status, output, error, created_at, expires_at)
      VALUES (?, ?, ?, ?, NULL, NULL, datetime('now'), ?)
    `);
    this.markIdempotencyRecordRunningStmt = this.db.prepare(`
      UPDATE idempotency_records
      SET status = ?, run_id = ?, step_id = ?, output = NULL, error = NULL, created_at = datetime('now'), expires_at = ?
      WHERE idempotency_key = ?
      AND status NOT IN (?, ?)
    `);
    this.storeIdempotencyRecordStmt = this.db.prepare(`
      INSERT OR REPLACE INTO idempotency_records
      (idempotency_key, run_id, step_id, status, output, error, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `);
    this.pruneIdempotencyRecordsStmt = this.db.prepare(`
      DELETE FROM idempotency_records
      WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
    `);
    this.clearIdempotencyRecordsStmt = this.db.prepare(
      'DELETE FROM idempotency_records WHERE run_id = ?'
    );
    this.listIdempotencyRecordsStmt = this.db.prepare(`
      SELECT * FROM idempotency_records
      ORDER BY created_at DESC
      LIMIT 100
    `);
    this.clearAllIdempotencyRecordsStmt = this.db.prepare('DELETE FROM idempotency_records');
    this.createTimerStmt = this.db.prepare(`
      INSERT INTO durable_timers (id, run_id, step_id, timer_type, wake_at, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    this.getTimerStmt = this.db.prepare('SELECT * FROM durable_timers WHERE id = ?');
    this.getTimerByStepStmt = this.db.prepare(`
      SELECT * FROM durable_timers
      WHERE run_id = ? AND step_id = ? AND completed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);
    this.completeTimerStmt = this.db.prepare(`
      UPDATE durable_timers
      SET completed_at = datetime('now')
      WHERE id = ?
    `);
    this.registerCompensationStmt = this.db.prepare(`
      INSERT INTO compensations (id, run_id, step_id, compensation_step_id, definition, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
    `);
    this.updateCompensationStatusStmt = this.db.prepare(`
      UPDATE compensations
      SET status = ?, output = ?, error = ?, completed_at = ?
      WHERE id = ?
    `);
    this.getPendingCompensationsStmt = this.db.prepare(`
      SELECT * FROM compensations
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at DESC, rowid DESC
    `);
    this.getAllCompensationsStmt = this.db.prepare(`
      SELECT * FROM compensations
      WHERE run_id = ?
      ORDER BY created_at DESC, rowid DESC
    `);
    this.getStepCacheStmt = this.db.prepare(`
      SELECT * FROM step_cache
      WHERE cache_key = ?
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    `);
    this.storeStepCacheStmt = this.db.prepare(`
      INSERT OR REPLACE INTO step_cache
      (cache_key, workflow_name, step_id, output, created_at, expires_at)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `);
    this.getEventStmt = this.db.prepare('SELECT * FROM events WHERE name = ?');
    this.storeEventStmt = this.db.prepare(`
      INSERT OR REPLACE INTO events (name, data, created_at)
      VALUES (?, ?, datetime('now'))
    `);
    this.deleteEventStmt = this.db.prepare('DELETE FROM events WHERE name = ?');
    this.createThoughtStmt = this.db.prepare(`
      INSERT INTO thought_events (id, run_id, workflow_name, step_id, content, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this.listThoughtEventsStmt = this.db.prepare(`
      SELECT * FROM thought_events
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.listThoughtEventsByRunStmt = this.db.prepare(`
      SELECT * FROM thought_events
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.listIdempotencyRecordsByRunStmt = this.db.prepare(`
      SELECT * FROM idempotency_records
      WHERE run_id = ?
      ORDER BY created_at DESC
    `);
    this.getStepCacheByWorkflowStmt = this.db.prepare(`
      SELECT * FROM step_cache
      WHERE workflow_name = ?
      ORDER BY created_at DESC
    `);
    this.clearStepCacheByWorkflowStmt = this.db.prepare(
      'DELETE FROM step_cache WHERE workflow_name = ?'
    );
    this.getPendingTimersStmt = this.db.prepare(`
      SELECT * FROM durable_timers
      WHERE completed_at IS NULL
      AND (wake_at IS NULL OR wake_at <= ?)
      ORDER BY wake_at ASC
    `);
    this.getPendingTimersByTypeStmt = this.db.prepare(`
      SELECT * FROM durable_timers
      WHERE completed_at IS NULL
      AND (wake_at IS NULL OR wake_at <= ?)
      AND timer_type = ?
      ORDER BY wake_at ASC
    `);
    this.listTimersByRunStmt = this.db.prepare(`
      SELECT * FROM durable_timers
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.listTimersStmt = this.db.prepare(`
      SELECT * FROM durable_timers
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.clearTimersByRunStmt = this.db.prepare('DELETE FROM durable_timers WHERE run_id = ?');
    this.clearAllTimersStmt = this.db.prepare('DELETE FROM durable_timers');
    this.clearAllStepCacheStmt = this.db.prepare('DELETE FROM step_cache');
  }

  /**
   * Execute multiple operations in a single transaction.
   * Since bun:sqlite transactions are synchronous, this blocks the event loop
   * and should be used with care for fast-running operations.
   */
  public withTransaction<T>(operation: (db: Database) => T): T {
    return this.db.transaction(operation)(this.db);
  }

  /**
   * Batch create multiple step executions in a single transaction.
   */
  public async batchCreateSteps(
    steps: Array<{ id: string; runId: string; stepId: string; iterationIndex: number | null }>
  ): Promise<void> {
    if (steps.length === 0) return;
    await this.withRetry(() => {
      this.db.transaction(() => {
        for (const s of steps) {
          this.createStepStmt.run(s.id, s.runId, s.stepId, s.iterationIndex, 'pending', 0);
        }
      })();
    });
  }

  /**
   * Type guard to check if an error is a SQLite busy error
   */
  private isSQLiteBusyError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      const err = error as { code?: string | number; message?: string };
      return (
        err.code === 'SQLITE_BUSY' ||
        err.code === DB.SQLITE_BUSY ||
        (typeof err.message === 'string' &&
          (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked')))
      );
    }
    return false;
  }

  /**
   * Retry wrapper for SQLite operations that may encounter SQLITE_BUSY errors
   * during high concurrency scenarios (e.g., foreach loops)
   *
   * Uses exponential backoff with jitter to reduce contention.
   */
  private async withRetry<T>(operation: () => T, maxRetries = LIMITS.MAX_DB_RETRIES): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        // Check if this is a SQLITE_BUSY error
        if (this.isSQLiteBusyError(error)) {
          lastError = error;

          // Log warning after threshold to help diagnose contention issues
          if (attempt === DB.RETRY_WARN_THRESHOLD) {
            console.warn(
              `[WorkflowDb] SQLite busy after ${DB.RETRY_WARN_THRESHOLD} retries. High contention detected - consider reducing concurrency.`
            );
          }

          // Exponential backoff with jitter
          const delayMs = Math.min(
            DB.RETRY_MAX_DELAY_MS,
            DB.RETRY_BASE_DELAY_MS * DB.RETRY_BACKOFF_MULTIPLIER ** attempt +
              Math.random() * DB.RETRY_JITTER_MS
          );
          await Bun.sleep(delayMs);
          continue;
        }

        // Wrap non-busy errors in DatabaseError
        const msg = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string | number })?.code;
        throw new DatabaseError(msg, code, false);
      }
    }

    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    const code = (lastError as { code?: string | number })?.code;
    throw new DatabaseError(
      `SQLite operation failed after ${maxRetries} retries: ${msg}`,
      code,
      true
    );
  }

  private formatExpiresAt(ttlSeconds?: number): string | null {
    if (!ttlSeconds || ttlSeconds <= 0) return null;
    const date = new Date(Date.now() + ttlSeconds * 1000);
    return date
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '')
      .replace(/\.\d{3}$/, '');
  }

  private runMigrations(): void {
    const currentVersion = this.db.query('PRAGMA user_version').get() as { user_version: number };
    const version = currentVersion?.user_version || 0;

    if (version === 0) {
      this.initSchema();
      this.db.exec('PRAGMA user_version = 1');
    }

    // Version 2: Add step_cache table
    if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS step_cache (
          cache_key TEXT PRIMARY KEY,
          workflow_name TEXT NOT NULL,
          step_id TEXT NOT NULL,
          output TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_step_cache_workflow ON step_cache(workflow_name);
        CREATE INDEX IF NOT EXISTS idx_step_cache_expires ON step_cache(expires_at);
        PRAGMA user_version = 2;
      `);
    }

    // Version 3: Add events table
    if (version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          name TEXT PRIMARY KEY,
          data TEXT,
          created_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
      `);
    }

    // Version 4: Add thought events table
    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS thought_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          step_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_thoughts_run ON thought_events(run_id);
        CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thought_events(created_at);
        PRAGMA user_version = 4;
      `);
    }

    // Version 5: Add dynamic workflow state tables
    if (version < 5) {
      this.db.exec(`
        -- Table for tracking dynamic step execution state
        CREATE TABLE IF NOT EXISTS dynamic_workflow_state (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          workflow_id TEXT,
          status TEXT NOT NULL DEFAULT 'planning',
          generated_plan TEXT NOT NULL DEFAULT '{"steps":[]}',
          current_step_index INTEGER DEFAULT 0,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
          UNIQUE (run_id, step_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dynamic_state_run ON dynamic_workflow_state(run_id);
        CREATE INDEX IF NOT EXISTS idx_dynamic_state_status ON dynamic_workflow_state(status);

        -- Table for individual generated step executions
        CREATE TABLE IF NOT EXISTS dynamic_step_executions (
          id TEXT PRIMARY KEY,
          state_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          step_name TEXT NOT NULL,
          step_type TEXT NOT NULL,
          step_definition TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          output TEXT,
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          execution_order INTEGER NOT NULL,
          FOREIGN KEY (state_id) REFERENCES dynamic_workflow_state(id) ON DELETE CASCADE,
          UNIQUE (state_id, step_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dynamic_exec_state ON dynamic_step_executions(state_id);
        CREATE INDEX IF NOT EXISTS idx_dynamic_exec_order ON dynamic_step_executions(state_id, execution_order);
        
        PRAGMA user_version = 5;
      `);
    }

    // Version 6: Add replan_count to dynamic_workflow_state
    if (version < 6) {
      this.db.exec(`
        ALTER TABLE dynamic_workflow_state ADD COLUMN replan_count INTEGER DEFAULT 0;
        PRAGMA user_version = 6;
      `);
    }
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

      CREATE TABLE IF NOT EXISTS thought_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        step_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thoughts_run ON thought_events(run_id);
      CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thought_events(created_at);
    `);
  }

  // ===== Workflow Runs =====

  async createRun(
    id: string,
    workflowName: string,
    inputs: Record<string, unknown>
  ): Promise<void> {
    await this.withRetry(() => {
      this.createRunStmt.run(
        id,
        workflowName,
        'pending',
        JSON.stringify(inputs),
        new Date().toISOString()
      );
    });
  }

  async updateRunStatus(
    id: string,
    status: RunStatus,
    outputs?: Record<string, unknown>,
    error?: string
  ): Promise<void> {
    await this.withRetry(() => {
      const completedAt =
        status === 'success' || status === 'failed' ? new Date().toISOString() : null;
      this.updateRunStatusStmt.run(
        status,
        outputs ? JSON.stringify(outputs) : null,
        error || null,
        completedAt,
        id
      );
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
      return this.getRunStmt.get(id) as WorkflowRun | null;
    });
  }

  /**
   * List recent workflow runs
   * @note Synchronous method - wrapped in sync retry logic
   */
  async listRuns(limit = 50): Promise<WorkflowRun[]> {
    return this.withRetry(() => {
      return this.listRunsStmt.all(limit) as WorkflowRun[];
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

      const result = this.pruneRunsStmt.run(cutoffIso);

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
      this.createStepStmt.run(id, runId, stepId, iterationIndex, 'pending', 0);
    });
  }

  async startStep(id: string): Promise<void> {
    await this.withRetry(() => {
      this.startStepStmt.run('running', new Date().toISOString(), id);
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
      this.completeStepStmt.run(
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
      this.incrementRetryStmt.run(id);
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
      return this.getStepByIterationStmt.get(runId, stepId, iterationIndex) as StepExecution | null;
    });
  }

  /**
   * Get the main execution (non-iteration) of a step
   */
  public async getMainStep(runId: string, stepId: string): Promise<StepExecution | null> {
    return this.withRetry(() => {
      return this.getMainStepStmt.get(runId, stepId) as StepExecution | null;
    });
  }

  /**
   * Get all iterations for a step
   */
  public async getStepIterations(runId: string, stepId: string): Promise<StepExecution[]> {
    return this.withRetry(() => {
      return this.getStepIterationsStmt.all(runId, stepId) as StepExecution[];
    });
  }

  /**
   * Get all step executions for a workflow run
   * @note Synchronous method - wrapped in sync retry logic
   */
  async getStepsByRun(runId: string, limit = -1, offset = 0): Promise<StepExecution[]> {
    return this.withRetry(() => {
      return this.getStepsByRunStmt.all(runId, limit, offset) as StepExecution[];
    });
  }

  async getStepsByRuns(runIds: string[]): Promise<StepExecution[]> {
    if (runIds.length === 0) return [];
    return this.withRetry(() => {
      const placeholders = runIds.map(() => '?').join(', ');
      const stmt = this.db.prepare(`
        SELECT * FROM step_executions
        WHERE run_id IN (${placeholders})
        ORDER BY started_at ASC, iteration_index ASC, rowid ASC
      `);
      return stmt.all(...runIds) as StepExecution[];
    });
  }

  async clearStepExecutions(runId: string, stepIds: string[]): Promise<number> {
    if (stepIds.length === 0) return 0;
    return this.withRetry(() => {
      const placeholders = stepIds.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM step_executions WHERE run_id = ? AND step_id IN (${placeholders})`
      );
      const result = stmt.run(runId, ...stepIds);
      return result.changes;
    });
  }

  async getSuccessfulRuns(workflowName: string, limit = 3): Promise<WorkflowRun[]> {
    return await this.withRetry(() => {
      return this.getSuccessfulRunsStmt.all(workflowName, limit) as WorkflowRun[];
    });
  }

  /**
   * Get the most recent run for a specific workflow
   */
  async getLastRun(workflowName: string): Promise<WorkflowRun | null> {
    return this.withRetry(() => {
      return this.getLastRunStmt.get(workflowName) as WorkflowRun | null;
    });
  }
  // ===== Idempotency Records =====

  /**
   * Get an idempotency record by key
   * Returns null if not found or expired
   */
  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    return this.withRetry(() => {
      return this.getIdempotencyRecordStmt.get(key) as IdempotencyRecord | null;
    });
  }

  /**
   * Remove an expired idempotency record by key
   */
  async clearExpiredIdempotencyRecord(key: string): Promise<number> {
    return await this.withRetry(() => {
      const result = this.clearExpiredIdempotencyRecordStmt.run(key);
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
      const expiresAt = this.formatExpiresAt(ttlSeconds);
      const result = this.insertIdempotencyRecordIfAbsentStmt.run(
        key,
        runId,
        stepId,
        status,
        expiresAt
      );
      return result.changes > 0;
    });
  }

  /**
   * Mark an idempotency record as running if it's not already running or successful.
   *
   * This operation is atomic within SQLite - the UPDATE only succeeds if the
   * status condition is met, preventing race conditions where multiple processes
   * try to claim the same key simultaneously.
   */
  async markIdempotencyRecordRunning(
    key: string,
    runId: string,
    stepId: string,
    ttlSeconds?: number
  ): Promise<boolean> {
    return await this.withRetry(() => {
      const expiresAt = this.formatExpiresAt(ttlSeconds);
      const result = this.markIdempotencyRecordRunningStmt.run(
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
   * Atomically claim an idempotency key.
   *
   * This combines the check-and-claim into a single atomic operation:
   * 1. If no record exists, creates one with 'running' status
   * 2. If a record exists but is not running/successful, updates it to 'running'
   * 3. Returns the current record state for decision making
   *
   * This prevents race conditions where two processes might both think
   * they successfully claimed the same key.
   */
  async atomicClaimIdempotencyKey(
    key: string,
    runId: string,
    stepId: string,
    ttlSeconds?: number
  ): Promise<
    | { status: 'claimed' }
    | { status: 'already-running'; record: IdempotencyRecord }
    | { status: 'completed'; record: IdempotencyRecord }
  > {
    return await this.withRetry(() => {
      return this.db.transaction(() => {
        // Check current state
        const existing = this.getIdempotencyRecordStmt.get(key) as IdempotencyRecord | null;

        if (!existing) {
          // No record exists - claim it
          const expiresAt = this.formatExpiresAt(ttlSeconds);
          const insertResult = this.insertIdempotencyRecordIfAbsentStmt.run(
            key,
            runId,
            stepId,
            StepStatusConst.RUNNING,
            expiresAt
          );

          // Verify the insert actually succeeded (INSERT OR IGNORE returns changes=0 on conflict)
          if (insertResult.changes > 0) {
            return { status: 'claimed' as const };
          }

          // Someone else inserted between our check and insert - re-check current state
          const conflictRecord = this.getIdempotencyRecordStmt.get(key) as IdempotencyRecord;
          if (conflictRecord.status === StepStatusConst.SUCCESS) {
            return { status: 'completed' as const, record: conflictRecord };
          }
          return { status: 'already-running' as const, record: conflictRecord };
        }

        if (existing.status === StepStatusConst.RUNNING) {
          return { status: 'already-running' as const, record: existing };
        }

        if (existing.status === StepStatusConst.SUCCESS) {
          return { status: 'completed' as const, record: existing };
        }

        // Record exists but is in a claimable state (failed, pending, etc.)
        // Try to claim it
        const expiresAt = this.formatExpiresAt(ttlSeconds);
        const result = this.markIdempotencyRecordRunningStmt.run(
          StepStatusConst.RUNNING,
          runId,
          stepId,
          expiresAt,
          key,
          StepStatusConst.RUNNING,
          StepStatusConst.SUCCESS
        );

        if (result.changes > 0) {
          return { status: 'claimed' as const };
        }

        // Someone else claimed it between our check and update
        const updated = this.getIdempotencyRecordStmt.get(key) as IdempotencyRecord;
        if (updated.status === StepStatusConst.SUCCESS) {
          return { status: 'completed' as const, record: updated };
        }
        return { status: 'already-running' as const, record: updated };
      })();
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
      const expiresAt = this.formatExpiresAt(ttlSeconds);
      this.storeIdempotencyRecordStmt.run(
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
      const result = this.pruneIdempotencyRecordsStmt.run();
      return result.changes;
    });
  }

  /**
   * Clear idempotency records for a specific run
   */
  async clearIdempotencyRecords(runId: string): Promise<number> {
    return await this.withRetry(() => {
      const result = this.clearIdempotencyRecordsStmt.run(runId);
      return result.changes;
    });
  }

  async clearIdempotencyRecordsForSteps(runId: string, stepIds: string[]): Promise<number> {
    if (stepIds.length === 0) return 0;
    return await this.withRetry(() => {
      const placeholders = stepIds.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM idempotency_records WHERE run_id = ? AND step_id IN (${placeholders})`
      );
      const result = stmt.run(runId, ...stepIds);
      return result.changes;
    });
  }

  /**
   * List idempotency records, optionally filtered by run ID
   */
  async listIdempotencyRecords(runId?: string): Promise<IdempotencyRecord[]> {
    return this.withRetry(() => {
      if (runId) {
        return this.listIdempotencyRecordsByRunStmt.all(runId) as IdempotencyRecord[];
      }
      return this.listIdempotencyRecordsStmt.all() as IdempotencyRecord[];
    });
  }

  /**
   * Clear all idempotency records
   */
  async clearAllIdempotencyRecords(): Promise<number> {
    return await this.withRetry(() => {
      const result = this.clearAllIdempotencyRecordsStmt.run();
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
      this.createTimerStmt.run(id, runId, stepId, timerType, wakeAt || null);
    });
  }

  /**
   * Get a durable timer by ID
   */
  async getTimer(id: string): Promise<DurableTimer | null> {
    return this.withRetry(() => {
      return this.getTimerStmt.get(id) as DurableTimer | null;
    });
  }

  /**
   * Get a durable timer by run ID and step ID
   */
  async getTimerByStep(runId: string, stepId: string): Promise<DurableTimer | null> {
    return this.withRetry(() => {
      return this.getTimerByStepStmt.get(runId, stepId) as DurableTimer | null;
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
      if (timerType === 'all') {
        return this.getPendingTimersStmt.all(cutoff) as DurableTimer[];
      }
      return this.getPendingTimersByTypeStmt.all(cutoff, timerType) as DurableTimer[];
    });
  }

  /**
   * Complete a durable timer
   */
  async completeTimer(id: string): Promise<void> {
    await this.withRetry(() => {
      this.completeTimerStmt.run(id);
    });
  }

  /**
   * List all timers, optionally filtered by run ID
   */
  async listTimers(runId?: string, limit = 50): Promise<DurableTimer[]> {
    return this.withRetry(() => {
      if (runId) {
        return this.listTimersByRunStmt.all(runId, limit) as DurableTimer[];
      }
      return this.listTimersStmt.all(limit) as DurableTimer[];
    });
  }

  /**
   * Clear timers for a specific run or all timers
   */
  async clearTimers(runId?: string): Promise<number> {
    return await this.withRetry(() => {
      if (runId) {
        const result = this.clearTimersByRunStmt.run(runId);
        return result.changes;
      }
      const result = this.clearAllTimersStmt.run();
      return result.changes;
    });
  }

  async clearTimersForSteps(runId: string, stepIds: string[]): Promise<number> {
    if (stepIds.length === 0) return 0;
    return await this.withRetry(() => {
      const placeholders = stepIds.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM durable_timers WHERE run_id = ? AND step_id IN (${placeholders})`
      );
      const result = stmt.run(runId, ...stepIds);
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
      this.registerCompensationStmt.run(id, runId, stepId, compensationStepId, definition);
    });
  }

  async updateCompensationStatus(
    id: string,
    status: StepStatus,
    output?: unknown,
    error?: string
  ): Promise<void> {
    await this.withRetry(() => {
      const completedAt =
        status === 'success' || status === 'failed' ? new Date().toISOString() : null;
      this.updateCompensationStatusStmt.run(
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
      return this.getPendingCompensationsStmt.all(runId) as CompensationRecord[];
    });
  }

  async getAllCompensations(runId: string): Promise<CompensationRecord[]> {
    return this.withRetry(() => {
      return this.getAllCompensationsStmt.all(runId) as CompensationRecord[];
    });
  }

  async clearCompensationsForSteps(runId: string, stepIds: string[]): Promise<number> {
    if (stepIds.length === 0) return 0;
    return this.withRetry(() => {
      const placeholders = stepIds.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM compensations WHERE run_id = ? AND step_id IN (${placeholders})`
      );
      const result = stmt.run(runId, ...stepIds);
      return result.changes;
    });
  }

  /**
   * Close the database connection and finalize all prepared statements.
   * Call this when the database is no longer needed to free resources.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    // Finalize all prepared statements
    const stmts = [
      this.createRunStmt,
      this.updateRunStatusStmt,
      this.getRunStmt,
      this.listRunsStmt,
      this.pruneRunsStmt,
      this.createStepStmt,
      this.startStepStmt,
      this.completeStepStmt,
      this.incrementRetryStmt,
      this.getStepByIterationStmt,
      this.getMainStepStmt,
      this.getStepsByRunStmt,
      this.getSuccessfulRunsStmt,
      this.getLastRunStmt,
      this.getIdempotencyRecordStmt,
      this.clearExpiredIdempotencyRecordStmt,
      this.insertIdempotencyRecordIfAbsentStmt,
      this.markIdempotencyRecordRunningStmt,
      this.storeIdempotencyRecordStmt,
      this.pruneIdempotencyRecordsStmt,
      this.clearIdempotencyRecordsStmt,
      this.listIdempotencyRecordsStmt,
      this.clearAllIdempotencyRecordsStmt,
      this.createTimerStmt,
      this.getTimerStmt,
      this.getTimerByStepStmt,
      this.completeTimerStmt,
      this.registerCompensationStmt,
      this.updateCompensationStatusStmt,
      this.getPendingCompensationsStmt,
      this.getAllCompensationsStmt,
      this.getStepCacheStmt,
      this.storeStepCacheStmt,
      this.getEventStmt,
      this.storeEventStmt,
      this.deleteEventStmt,
      this.createThoughtStmt,
      this.listThoughtEventsStmt,
      this.listThoughtEventsByRunStmt,
      this.listIdempotencyRecordsByRunStmt,
      this.getStepCacheByWorkflowStmt,
      this.clearStepCacheByWorkflowStmt,
      this.getPendingTimersStmt,
      this.getPendingTimersByTypeStmt,
      this.listTimersByRunStmt,
      this.listTimersStmt,
      this.clearTimersByRunStmt,
      this.clearAllTimersStmt,
      this.clearAllStepCacheStmt,
    ];

    for (const stmt of stmts) {
      if (stmt) {
        try {
          stmt.finalize();
        } catch (e) {
          // Ignore finalization errors
        }
      }
    }

    // Close the database connection
    try {
      this.db.close();
    } catch (e) {
      // Ignore close errors
    }
  }

  // ===== Step Cache =====

  async getStepCache(key: string): Promise<{ output: string } | null> {
    return this.withRetry(() => {
      return this.getStepCacheStmt.get(key) as { output: string } | null;
    });
  }

  async storeStepCache(
    key: string,
    workflowName: string,
    stepId: string,
    output: unknown,
    ttlSeconds?: number
  ): Promise<void> {
    await this.withRetry(() => {
      const expiresAt = this.formatExpiresAt(ttlSeconds);
      this.storeStepCacheStmt.run(key, workflowName, stepId, JSON.stringify(output), expiresAt);
    });
  }

  async clearStepCache(workflowName?: string): Promise<number> {
    return await this.withRetry(() => {
      if (workflowName) {
        const result = this.clearStepCacheByWorkflowStmt.run(workflowName);
        return result.changes;
      }
      const result = this.clearAllStepCacheStmt.run();
      return result.changes;
    });
  }

  // ===== Events =====

  async getEvent(name: string): Promise<{ data: string | null } | null> {
    return this.withRetry(() => {
      return this.getEventStmt.get(name) as { data: string | null } | null;
    });
  }

  async storeEvent(name: string, data?: unknown): Promise<void> {
    await this.withRetry(() => {
      this.storeEventStmt.run(name, data === undefined ? null : JSON.stringify(data));
    });
  }

  async deleteEvent(name: string): Promise<number> {
    return await this.withRetry(() => {
      const result = this.deleteEventStmt.run(name);
      return result.changes;
    });
  }

  async clearEvents(): Promise<number> {
    return await this.withRetry(() => {
      const stmt = this.db.prepare('DELETE FROM events');
      const result = stmt.run();
      return result.changes;
    });
  }

  // ===== Thought Events =====

  async storeThoughtEvent(
    runId: string,
    workflowName: string,
    stepId: string,
    content: string,
    source: 'thinking' | 'reasoning'
  ): Promise<void> {
    await this.withRetry(() => {
      this.createThoughtStmt.run(randomUUID(), runId, workflowName, stepId, content, source);
    });
  }

  async listThoughtEvents(limit = 20, runId?: string): Promise<ThoughtEvent[]> {
    return await this.withRetry(() => {
      if (runId) {
        return this.listThoughtEventsByRunStmt.all(runId, limit) as ThoughtEvent[];
      }
      return this.listThoughtEventsStmt.all(limit) as ThoughtEvent[];
    });
  }
}
