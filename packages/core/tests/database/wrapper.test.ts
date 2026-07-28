import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs from 'sql.js';
import { SqlJsWrapper } from '../../src/database/init.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let wrapper: SqlJsWrapper;
let dbPath: string;

beforeEach(async () => {
  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database();
  dbPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  wrapper = new SqlJsWrapper(sqlDb, dbPath);
});

afterEach(() => {
  try { wrapper.close(); } catch { /* already closed */ }
  try { fs.unlinkSync(dbPath); } catch { /* may not exist */ }
});

describe('SqlJsWrapper', () => {
  describe('exec', () => {
    it('should execute DDL statements', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      // If no error thrown, table was created
      const row = wrapper.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'test') as any;
      expect(row.name).toBe('test');
    });
  });

  describe('pragma', () => {
    it('should execute PRAGMA statements', () => {
      const result = wrapper.pragma('journal_mode = WAL');
      // sql.js is in-memory so journal_mode may stay as 'memory', but no error
      expect(result).toBeDefined();
    });
  });

  describe('prepare().run()', () => {
    it('should insert rows and return changes', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const result = wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      expect(result.changes).toBe(1);
    });

    it('should handle multiple params', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
      const result = wrapper.prepare('INSERT INTO test (a, b) VALUES (?, ?)').run('x', 'y');
      expect(result.changes).toBe(1);
      const row = wrapper.prepare('SELECT a, b FROM test WHERE id = 1').get() as any;
      expect(row.a).toBe('x');
      expect(row.b).toBe('y');
    });
  });

  describe('prepare().get()', () => {
    it('should return a single row as object', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      const row = wrapper.prepare('SELECT id, name FROM test WHERE name = ?').get('alice') as any;
      expect(row).toBeDefined();
      expect(row.name).toBe('alice');
      expect(row.id).toBe(1);
    });

    it('should return undefined when no rows match', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const row = wrapper.prepare('SELECT * FROM test WHERE name = ?').get('nobody');
      expect(row).toBeUndefined();
    });

    it('should work with no params', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      const row = wrapper.prepare('SELECT COUNT(*) as cnt FROM test').get() as any;
      expect(row.cnt).toBe(1);
    });
  });

  describe('prepare().all()', () => {
    it('should return all matching rows', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('bob');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('charlie');
      const rows = wrapper.prepare('SELECT name FROM test ORDER BY id').all() as any[];
      expect(rows).toHaveLength(3);
      expect(rows[0].name).toBe('alice');
      expect(rows[2].name).toBe('charlie');
    });

    it('should return empty array when no matches', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const rows = wrapper.prepare('SELECT * FROM test').all();
      expect(rows).toEqual([]);
    });

    it('should accept params', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('bob');
      const rows = wrapper.prepare('SELECT name FROM test WHERE name = ?').all('alice') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('alice');
    });
  });

  describe('transaction', () => {
    it('should commit on success', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const insertMany = wrapper.transaction((names: string[]) => {
        for (const name of names) {
          wrapper.prepare('INSERT INTO test (name) VALUES (?)').run(name);
        }
      });
      insertMany(['alice', 'bob', 'charlie']);
      const rows = wrapper.prepare('SELECT name FROM test').all();
      expect(rows).toHaveLength(3);
    });

    it('should rollback on error', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const insertMany = wrapper.transaction((names: (string | null)[]) => {
        for (const name of names) {
          wrapper.prepare('INSERT INTO test (name) VALUES (?)').run(name);
        }
      });

      expect(() => insertMany(['alice', null])).toThrow();

      const rows = wrapper.prepare('SELECT name FROM test').all();
      expect(rows).toHaveLength(0); // rolled back
    });

    it('should pass arguments through to the wrapped function', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
      const insert = wrapper.transaction((a: string, b: string) => {
        wrapper.prepare('INSERT INTO test (val) VALUES (?)').run(a);
        wrapper.prepare('INSERT INTO test (val) VALUES (?)').run(b);
      });
      insert('x', 'y');
      const rows = wrapper.prepare('SELECT val FROM test ORDER BY id').all() as any[];
      expect(rows[0].val).toBe('x');
      expect(rows[1].val).toBe('y');
    });
  });

  describe('SQLITE_CONSTRAINT error compat', () => {
    it('should set error.code to SQLITE_CONSTRAINT on unique violation', () => {
      wrapper.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');
      wrapper.prepare('INSERT INTO test (id) VALUES (?)').run('dup');
      try {
        wrapper.prepare('INSERT INTO test (id) VALUES (?)').run('dup');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('SQLITE_CONSTRAINT');
      }
    });
  });

  describe('persistence', () => {
    it('should save to disk and reload', async () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('persisted');

      // Force flush
      wrapper.close();

      // Verify file exists
      expect(fs.existsSync(dbPath)).toBe(true);

      // Reload from file
      const SQL = await initSqlJs();
      const fileBuffer = fs.readFileSync(dbPath);
      const sqlDb = new SQL.Database(fileBuffer);
      const wrapper2 = new SqlJsWrapper(sqlDb, dbPath);

      const row = wrapper2.prepare('SELECT name FROM test WHERE id = 1').get() as any;
      expect(row.name).toBe('persisted');
      wrapper2.close();
    });
  });

  describe('close', () => {
    it('should flush pending saves on close', () => {
      wrapper.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      wrapper.prepare('INSERT INTO test (name) VALUES (?)').run('flushed');
      wrapper.close();
      expect(fs.existsSync(dbPath)).toBe(true);
      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);
    });
  });
});
