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

describe('nested transactions (bug-hunt regression)', () => {
  it('an inner rollback does not destroy the outer transaction', async () => {
    // A plain BEGIN inside a transaction fails, and the inner ROLLBACK then
    // unwound the OUTER one — so the caller got an error naming neither
    // problem and the outer transaction's work silently vanished.
    const db = wrapper;
    db.exec('CREATE TABLE IF NOT EXISTS nest_test (name TEXT)');
    db.prepare('DELETE FROM nest_test').run();

    const outer = db.transaction(() => {
      db.prepare('INSERT INTO nest_test (name) VALUES (?)').run('outer-work');
      const inner = db.transaction(() => {
        db.prepare('INSERT INTO nest_test (name) VALUES (?)').run('inner-work');
        throw new Error('inner failed');
      });
      try { inner(); } catch { /* the outer transaction handles it */ }
      db.prepare('INSERT INTO nest_test (name) VALUES (?)').run('outer-after');
    });

    expect(() => outer()).not.toThrow();
    const rows = db.prepare('SELECT name FROM nest_test').all() as Array<{ name: string }>;
    expect(rows.map(r => r.name)).toEqual(['outer-work', 'outer-after']); // inner rolled back, outer kept
  });

  it('a successful nested transaction commits with its parent', () => {
    const db = wrapper;
    db.exec('CREATE TABLE IF NOT EXISTS nest_ok (name TEXT)');
    db.prepare('DELETE FROM nest_ok').run();

    db.transaction(() => {
      db.prepare('INSERT INTO nest_ok (name) VALUES (?)').run('a');
      db.transaction(() => {
        db.prepare('INSERT INTO nest_ok (name) VALUES (?)').run('b');
      })();
    })();

    const rows = db.prepare('SELECT name FROM nest_ok').all() as Array<{ name: string }>;
    expect(rows.map(r => r.name)).toEqual(['a', 'b']);
  });

  it('an outer rollback discards nested work too', () => {
    const db = wrapper;
    db.exec('CREATE TABLE IF NOT EXISTS nest_undo (name TEXT)');
    db.prepare('DELETE FROM nest_undo').run();

    const outer = db.transaction(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO nest_undo (name) VALUES (?)').run('inner');
      })();
      throw new Error('outer failed');
    });

    expect(() => outer()).toThrow('outer failed');
    expect(db.prepare('SELECT name FROM nest_undo').all()).toEqual([]);
  });
});

describe('better-sqlite3 parity (bug-hunt regression)', () => {
  it('run() reports lastInsertRowid', () => {
    wrapper.exec('CREATE TABLE rowid_test (id INTEGER PRIMARY KEY, name TEXT)');
    const first = wrapper.prepare('INSERT INTO rowid_test (name) VALUES (?)').run('a');
    const second = wrapper.prepare('INSERT INTO rowid_test (name) VALUES (?)').run('b');
    expect(first.lastInsertRowid).toBe(1);
    expect(second.lastInsertRowid).toBe(2);
  });

  it('booleans bind as 0/1', () => {
    wrapper.exec('CREATE TABLE bool_test (flag INTEGER)');
    wrapper.prepare('INSERT INTO bool_test (flag) VALUES (?)').run(true as any);
    wrapper.prepare('INSERT INTO bool_test (flag) VALUES (?)').run(false as any);
    const rows = wrapper.prepare('SELECT flag FROM bool_test').all() as Array<{ flag: number }>;
    expect(rows.map(r => r.flag)).toEqual([1, 0]);
  });

  it('refuses values SQLite cannot round-trip', () => {
    wrapper.exec('CREATE TABLE reject_test (v REAL)');
    const insert = wrapper.prepare('INSERT INTO reject_test (v) VALUES (?)');
    // Each of these was silently accepted and stored as something the reader
    // could not recognise: NaN became NULL, Infinity read back as null, an
    // array became a BLOB, and a large BigInt degraded to a lossy REAL.
    expect(() => insert.run(NaN as any)).toThrow(/NaN/);
    expect(() => insert.run(Infinity as any)).toThrow(/Infinity/);
    expect(() => insert.run(new Date() as any)).toThrow(/Date/);
    expect(() => insert.run(12345678901234567890n as any)).toThrow(/precision/);
    // The array FORM is `.run([v])`; an array as a VALUE is `.run([[1, 2]])`.
    expect(() => insert.run([[1, 2]] as any)).toThrow(/array/);
  });

  it('accepts a BigInt inside the safe range', () => {
    wrapper.exec('CREATE TABLE bigint_test (v INTEGER)');
    wrapper.prepare('INSERT INTO bigint_test (v) VALUES (?)').run(42n as any);
    expect((wrapper.prepare('SELECT v FROM bigint_test').get() as any).v).toBe(42);
  });

  describe('connection pragmas survive a save', () => {
    // sql.js's export() CLOSES and REOPENS the connection, resetting every
    // connection-scoped pragma. `foreign_keys = ON`, set once at open, was off
    // again before the first checkpoint landed — so the schema's declared
    // foreign keys were never actually enforced. Nothing changed except the
    // appearance of enforcement.
    it('keeps foreign_keys ON after flush()', () => {
      wrapper._applyConnectionPragmas();
      expect(wrapper.pragma('foreign_keys')).toBe(1);
      wrapper.flush();
      expect(wrapper.pragma('foreign_keys')).toBe(1);
    });

    it('actually rejects an orphan row after a flush', () => {
      wrapper._applyConnectionPragmas();
      wrapper.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
      wrapper.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
      wrapper.flush();
      expect(() =>
        wrapper.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'no-such-parent'),
      ).toThrow();
    });
  });
});
