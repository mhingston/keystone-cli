import { Database } from 'bun:sqlite';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'suspended';

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

export class WorkflowDb {
  private db: Database;

  constructor(public readonly dbPath = '.keystone/state.db') {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;'); // Write-ahead logging
    this.db.exec('PRAGMA foreign_keys = ON;'); // Enable foreign key enforcement
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
  private async withRetry<T>(operation: () => T, maxRetries = 5): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        // Check if this is a SQLITE_BUSY error
        if (this.isSQLiteBusyError(error)) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Exponential backoff: 10ms, 20ms, 40ms, 80ms, 160ms
          const delayMs = 10 * 2 ** attempt;
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
        status === 'completed' || status === 'failed' ? new Date().toISOString() : null;
      stmt.run(status, outputs ? JSON.stringify(outputs) : null, error || null, completedAt, id);
    });
  }

  getRun(id: string): WorkflowRun | null {
    const stmt = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?');
    return stmt.get(id) as WorkflowRun | null;
  }

  listRuns(limit = 50): WorkflowRun[] {
    const stmt = this.db.prepare(`
      SELECT * FROM workflow_runs
      ORDER BY started_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as WorkflowRun[];
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
        output ? JSON.stringify(output) : null,
        error || null,
        new Date().toISOString(),
        usage ? JSON.stringify(usage) : null,
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

  getStepByIteration(runId: string, stepId: string, iterationIndex: number): StepExecution | null {
    const stmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ? AND step_id = ? AND iteration_index = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    return stmt.get(runId, stepId, iterationIndex) as StepExecution | null;
  }

  getStepsByRun(runId: string): StepExecution[] {
    const stmt = this.db.prepare(`
      SELECT * FROM step_executions
      WHERE run_id = ?
      ORDER BY started_at ASC, iteration_index ASC, rowid ASC
    `);
    return stmt.all(runId) as StepExecution[];
  }

  close(): void {
    this.db.close();
  }
}
