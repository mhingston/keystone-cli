import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { ConsoleLogger } from '../utils/logger';
import { setupSqlite } from './sqlite-setup.ts';

export interface MemoryEntry {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  distance?: number;
}

const SQLITE_VEC_EXTENSION =
  process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
const SQLITE_VEC_FILENAME = `vec0.${SQLITE_VEC_EXTENSION}`;

function getRuntimeDir(): string {
  return process.env.KEYSTONE_RUNTIME_DIR || join(dirname(process.execPath), 'keystone-runtime');
}

function resolveSqliteVecPath(): string {
  const overridePath = process.env.KEYSTONE_SQLITE_VEC_PATH;
  if (overridePath && existsSync(overridePath)) {
    return overridePath;
  }

  try {
    const loadablePath = sqliteVec.getLoadablePath();
    if (existsSync(loadablePath)) {
      return loadablePath;
    }
  } catch {
    // Fall through to additional lookup paths.
  }

  const osName = process.platform === 'win32' ? 'windows' : process.platform;
  const runtimeDir = getRuntimeDir();
  const candidatePaths = [
    join(runtimeDir, 'node_modules', `sqlite-vec-${osName}-${process.arch}`, SQLITE_VEC_FILENAME),
    join(
      process.cwd(),
      'node_modules',
      `sqlite-vec-${osName}-${process.arch}`,
      SQLITE_VEC_FILENAME
    ),
    join(dirname(process.execPath), SQLITE_VEC_FILENAME),
    join(dirname(process.execPath), 'lib', SQLITE_VEC_FILENAME),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Loadable extension for sqlite-vec not found. Set KEYSTONE_SQLITE_VEC_PATH or install sqlite-vec-${osName}-${process.arch}.`
  );
}

export class MemoryDb {
  private db: Database;
  // Cache connections by path to avoid reloading extensions
  private static connectionCache = new Map<string, { db: Database; refCount: number }>();
  private tableName: string;

  /**
   * Acquire a MemoryDb instance. This handles reference counting automatically.
   */
  static acquire(dbPath = '.keystone/memory.db', embeddingDimension = 384): MemoryDb {
    const cached = MemoryDb.connectionCache.get(dbPath);
    if (cached) {
      cached.refCount++;
      // We return a new instance but it shares the underlying DB connection
      return new MemoryDb(dbPath, embeddingDimension, cached.db);
    }

    // Create new connection
    const instance = new MemoryDb(dbPath, embeddingDimension);
    MemoryDb.connectionCache.set(dbPath, { db: instance.db, refCount: 1 });
    return instance;
  }

  constructor(
    public readonly dbPath = '.keystone/memory.db',
    private readonly embeddingDimension = 384,
    existingDb?: Database
  ) {
    // Ensure SQLite is set up with custom library on macOS (idempotent)
    setupSqlite();

    this.tableName = `vec_memory_${embeddingDimension}`;

    if (existingDb) {
      this.db = existingDb;
    } else {
      // Check cache again in case direct constructor usage overlaps with cache
      const cached = MemoryDb.connectionCache.get(dbPath);
      if (cached) {
        // This path shouldn't typically be hit if users use acquire(), but for safety:
        cached.refCount++;
        this.db = cached.db;
      } else {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath, { create: true });

        // Load sqlite-vec extension
        const extensionPath = resolveSqliteVecPath();
        this.db.loadExtension(extensionPath);

        this.initSchema();

        // Seed cache
        MemoryDb.connectionCache.set(dbPath, { db: this.db, refCount: 1 });
      }
    }
  }

  /**
   * Manually increment reference count.
   * Useful when passing an instance to another component that should also own it.
   */
  retain(): void {
    const cached = MemoryDb.connectionCache.get(this.dbPath);
    if (cached) {
      cached.refCount++;
    }
  }

  private initSchema(): void {
    // Check if the legacy 'vec_memory' table exists and what its dimension is
    const legacyTable = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memory'")
      .get() as { sql: string } | undefined;

    if (legacyTable) {
      const match = legacyTable.sql.match(/FLOAT\[(\d+)\]/i);
      if (match && Number.parseInt(match[1], 10) === this.embeddingDimension) {
        // Legacy table exists and matches our dimension, reuse it
        this.tableName = 'vec_memory';
      } else {
        // Mismatch or couldn't parse. We will use the specific table name `vec_memory_{dim}`.
        // We log a warning to stdout since we don't have a logger instance here,
        // but only if we haven't already created the specific table (to avoid spamming on every init).
        const specificTableExists = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${this.tableName}'`)
          .get();
        if (!specificTableExists) {
          new ConsoleLogger().warn(
            `\n⚠️  Vector DB: Found legacy table 'vec_memory' with dimension mismatch (expected ${this.embeddingDimension}).\n` +
              `Using new table '${this.tableName}' instead. Old data is preserved in 'vec_memory'.\n`
          );
        }
      }
    }

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${this.embeddingDimension}]
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_metadata (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private assertEmbeddingDimension(embedding: number[]): void {
    if (embedding.length !== this.embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.embeddingDimension}, got ${embedding.length}`
      );
    }
  }

  /**
   * Store an embedding and its associated text/metadata.
   *
   * @param text - The text content to store
   * @param embedding - The embedding vector
   * @param metadata - Optional metadata to associate with the entry
   * @returns The generated entry ID
   */
  async store(
    text: string,
    embedding: number[],
    metadata: Record<string, unknown> = {}
  ): Promise<string> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.assertEmbeddingDimension(embedding);

    // bun:sqlite transaction wrapper ensures atomicity synchronously
    const insertTransaction = this.db.transaction(() => {
      this.db.run(`INSERT INTO ${this.tableName}(id, embedding) VALUES (?, ?)`, [
        id,
        new Float32Array(embedding),
      ]);

      this.db.run(
        'INSERT INTO memory_metadata(id, text, metadata, created_at) VALUES (?, ?, ?, ?)',
        [id, text, JSON.stringify(metadata), createdAt]
      );
    });

    insertTransaction();
    return id;
  }

  /**
   * Search for similar embeddings using vector similarity.
   *
   * @param embedding - The query embedding vector
   * @param limit - Maximum number of results to return (default: 5)
   * @returns Array of matching entries with distance scores
   */
  async search(embedding: number[], limit = 5): Promise<MemoryEntry[]> {
    this.assertEmbeddingDimension(embedding);
    const query = `
      SELECT 
        v.id, 
        v.distance,
        m.text,
        m.metadata
      FROM ${this.tableName} v
      JOIN memory_metadata m ON v.id = m.id
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `;

    // bun:sqlite is synchronous
    const rows = this.db.prepare(query).all(new Float32Array(embedding), limit) as {
      id: string;
      distance: number;
      text: string;
      metadata: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      distance: row.distance,
      text: row.text,
      metadata: JSON.parse(row.metadata),
    }));
  }

  /**
   * Release the connection. Decrements ref count and closes DB if 0.
   * Alias for close() for backward compatibility.
   */
  release(): void {
    this.close();
  }

  close(): void {
    const cached = MemoryDb.connectionCache.get(this.dbPath);
    if (cached) {
      cached.refCount--;
      if (cached.refCount <= 0) {
        cached.db.close();
        MemoryDb.connectionCache.delete(this.dbPath);
      }
    } else {
      // Fallback if not in cache for some reason or already closed
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
  }
}
