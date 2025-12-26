import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import './sqlite-setup.ts';

export interface MemoryEntry {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  distance?: number;
}

export class MemoryDb {
  private db: Database;
  // Cache connections by path to avoid reloading extensions
  private static connectionCache = new Map<string, { db: Database; refCount: number }>();
  static readonly EMBEDDING_DIMENSION = 384;

  constructor(public readonly dbPath = '.keystone/memory.db') {
    const cached = MemoryDb.connectionCache.get(dbPath);
    if (cached) {
      cached.refCount++;
      this.db = cached.db;
    } else {
      const { Database } = require('bun:sqlite');
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath, { create: true });

      // Load sqlite-vec extension
      const extensionPath = sqliteVec.getLoadablePath();
      this.db.loadExtension(extensionPath);

      this.initSchema();

      MemoryDb.connectionCache.set(dbPath, { db: this.db, refCount: 1 });
    }
  }

  private initSchema(): void {
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${MemoryDb.EMBEDDING_DIMENSION}]
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

  private static assertEmbeddingDimension(embedding: number[]): void {
    if (embedding.length !== MemoryDb.EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimension mismatch: expected ${MemoryDb.EMBEDDING_DIMENSION}, got ${embedding.length}`
      );
    }
  }

  /**
   * Store an embedding and its associated text/metadata.
   *
   * Note: The async signature provides interface compatibility with potentially
   * async backends (e.g., remote vector DBs). The current implementation uses
   * synchronous bun:sqlite operations internally.
   *
   * @param text - The text content to store
   * @param embedding - The embedding vector (384 dimensions)
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
    MemoryDb.assertEmbeddingDimension(embedding);

    // bun:sqlite transaction wrapper ensures atomicity synchronously
    const insertTransaction = this.db.transaction(() => {
      this.db.run('INSERT INTO vec_memory(id, embedding) VALUES (?, ?)', [
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
   * Note: The async signature provides interface compatibility with potentially
   * async backends (e.g., remote vector DBs). The current implementation uses
   * synchronous bun:sqlite operations internally.
   *
   * @param embedding - The query embedding vector
   * @param limit - Maximum number of results to return (default: 5)
   * @returns Array of matching entries with distance scores
   */
  async search(embedding: number[], limit = 5): Promise<MemoryEntry[]> {
    MemoryDb.assertEmbeddingDimension(embedding);
    const query = `
      SELECT 
        v.id, 
        v.distance,
        m.text,
        m.metadata
      FROM vec_memory v
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

  close(): void {
    const cached = MemoryDb.connectionCache.get(this.dbPath);
    if (cached) {
      cached.refCount--;
      if (cached.refCount <= 0) {
        cached.db.close();
        MemoryDb.connectionCache.delete(this.dbPath);
      }
    } else {
      // Fallback if not in cache for some reason
      this.db.close();
    }
  }
}
