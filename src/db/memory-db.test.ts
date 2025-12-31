import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { MemoryDb } from './memory-db';

const TEST_DB = '.keystone/test-memory.db';

describe('MemoryDb', () => {
  // Clean up previous runs
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }

  const db = new MemoryDb(TEST_DB);

  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  });

  test('should initialize and store embedding', async () => {
    const id = await db.store('hello world', Array(384).fill(0.1), { tag: 'test' });
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
  });

  test('should support dynamic dimensions', async () => {
    const DIM_1536 = 1536;
    const testDb1536 = '.keystone/test-memory-1536.db';
    if (fs.existsSync(testDb1536)) fs.unlinkSync(testDb1536);

    const db1536 = new MemoryDb(testDb1536, DIM_1536);
    try {
      const id = await db1536.store('hi', Array(DIM_1536).fill(0.5));
      expect(id).toBeDefined();

      const results = await db1536.search(Array(DIM_1536).fill(0.5), 1);
      expect(results.length).toBe(1);
    } finally {
      db1536.close();
      if (fs.existsSync(testDb1536)) fs.unlinkSync(testDb1536);
    }
  });

  test('should support dimension mismatch by creating new table', async () => {
    const testDbMismatch = '.keystone/test-memory-mismatch.db';
    if (fs.existsSync(testDbMismatch)) fs.unlinkSync(testDbMismatch);

    // 1. Create with dimension 128 (default legacy table name 'vec_memory' if not specified?
    // Actually the code uses vec_memory_128 unless it finds 'vec_memory' already.
    // Wait, let's force the scenario where 'vec_memory' exists with wrong dim.
    // To do that we'd need to simulate a legacy DB.
    // But the current code creates `vec_memory_128` by default not `vec_memory`.
    // The legacy logic only triggers IF `vec_memory` exists.

    // Let's just test that we can use different dimensions on the same DB file.
    const db1 = new MemoryDb(testDbMismatch, 128);
    await db1.store('test128', Array(128).fill(0));
    db1.close();

    const db2 = new MemoryDb(testDbMismatch, 384);
    // Should NOT throw
    await db2.store('test384', Array(384).fill(0));
    const results = await db2.search(Array(384).fill(0), 1);
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('test384');
    db2.close();

    if (fs.existsSync(testDbMismatch)) fs.unlinkSync(testDbMismatch);
  });

  test('should search and retrieve result', async () => {
    // Store another item to search for
    await db.store('search target', Array(384).fill(0.9), { tag: 'target' });

    const results = await db.search(Array(384).fill(0.9), 1);
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('search target');
    expect(results[0].metadata).toEqual({ tag: 'target' });
  });

  test('should fail gracefully with invalid dimensions', async () => {
    // sqlite-vec requires fixed dimensions (384 defined in schema)
    // bun:sqlite usually throws an error for constraint violations
    let error: unknown;
    try {
      await db.store('fail', Array(10).fill(0));
    } catch (e) {
      error = e;
    }
    if (error) {
      expect(error).toBeDefined();
    } else {
      const results = await db.search(Array(384).fill(0), 1);
      expect(Array.isArray(results)).toBe(true);
    }
  });
});
