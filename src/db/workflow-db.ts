import { Database, Statement } from 'bun:sqlite';
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
import { PathResolver } from '../utils/paths';
import { DB } from '../utils/constants';

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

export class WorkflowDb {
  private db: Database;

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

  constructor(public readonly dbPath = PathResolver.resolveDbPath()) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;'); // Write-ahead logging
    this.db.exec('PRAGMA foreign_keys = ON;'); // Enable foreign key enforcement
    this.db.exec('PRAGMA busy_timeout = 5000;'); // Retry busy signals for up to 5s
    this.runMigrations();
    this.initStatements();
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
    this.clearIdempotencyRecordsStmt = this.db.prepare('DELETE FROM idempotency_records WHERE run_id = ?');
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
      const result = this.insertIdempotencyRecordIfAbsentStmt.run(key, runId, stepId, status, expiresAt);
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
        return this.db
          .prepare(
            `
          SELECT * FROM idempotency_records
          WHERE run_id = ?
          ORDER BY created_at DESC
        `
          )
          .all(runId) as IdempotencyRecord[];
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
      this.completeTimerStmt.run(id);
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

  close(): void {
    this.db.close();
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
      this.storeStepCacheStmt.run(
        key,
        workflowName,
        stepId,
        JSON.stringify(output),
        expiresAt
      );
    });
  }

  async clearStepCache(workflowName?: string): Promise<number> {
    return await this.withRetry(() => {
      if (workflowName) {
        const stmt = this.db.prepare('DELETE FROM step_cache WHERE workflow_name = ?');
        const result = stmt.run(workflowName);
        return result.changes;
      }
      const stmt = this.db.prepare('DELETE FROM step_cache');
      const result = stmt.run();
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
      this.createThoughtStmt.run(
        randomUUID(),
        runId,
        workflowName,
        stepId,
        content,
        source
      );
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
