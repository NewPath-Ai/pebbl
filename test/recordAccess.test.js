'use strict';

// recordAccess — the usage-signal WRITE (db.js), gated to INTENTIONAL lookups
// (FIX 1). These tests prove:
//   - it increments access_count and stamps last_accessed on the ids it is given
//   - it is a no-op under the test guard (NODE_TEST_CONTEXT set), so the suite's
//     access_count stays stable across runs (the determinism gate)
//   - it dedups ids, so an entry shown twice in one lookup counts once
//   - END TO END: `pebbl context --topic <x>` (the intentional lookup) increments,
//     but the plain `pebbl context` dump and `--full` do NOT (the print-frequency
//     feedback loop FIX 1 kills).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { recordAccess } = require('../src/db');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// A minimal logs table with the rerank signal columns. We seed access_count=0 and
// last_accessed=NULL so any change is unambiguously from recordAccess.
function seededDb() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-recordaccess-'));
  dirs.push(d);
  const db = new Database(path.join(d, 'db.sqlite'));
  db.exec(`
    CREATE TABLE logs (
      id            INTEGER PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      tier          TEXT,
      message       TEXT NOT NULL,
      topics        TEXT,
      valid_to      TEXT,
      importance    REAL DEFAULT 0,
      access_count  INTEGER DEFAULT 0,
      last_accessed TEXT DEFAULT NULL
    );
  `);
  const ins = db.prepare('INSERT INTO logs (id, timestamp, tier, message, topics) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, '2026-01-01T00:00:00.000Z', 'foundation', 'a', 'x');
  ins.run(2, '2026-01-02T00:00:00.000Z', 'component', 'b', 'x');
  ins.run(3, '2026-01-03T00:00:00.000Z', 'detail', 'c', 'x');
  return db;
}

function rows(db) {
  return db.prepare('SELECT id, access_count, last_accessed FROM logs ORDER BY id').all();
}

describe('recordAccess (usage-signal write, FIX 1)', () => {
  // The suite runs with NODE_TEST_CONTEXT set, so the guard is active by default.
  // We toggle it explicitly per case so each is self-describing.

  it('is a NO-OP under the test guard (NODE_TEST_CONTEXT set)', () => {
    const prev = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = '1';
    try {
      const db = seededDb();
      recordAccess(db, [1, 2, 3], { now: '2026-06-01T00:00:00.000Z' });
      for (const r of rows(db)) {
        assert.strictEqual(r.access_count, 0, `id ${r.id} must not increment under the guard`);
        assert.strictEqual(r.last_accessed, null, `id ${r.id} last_accessed must stay null under the guard`);
      }
      db.close();
    } finally {
      if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prev;
    }
  });

  it('increments access_count and stamps last_accessed on exactly the given ids', () => {
    const prev = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT; // simulate a real CLI invocation
    try {
      const db = seededDb();
      recordAccess(db, [1, 3], { now: '2026-06-01T00:00:00.000Z' });
      const byId = Object.fromEntries(rows(db).map(r => [r.id, r]));
      assert.strictEqual(byId[1].access_count, 1);
      assert.strictEqual(byId[1].last_accessed, '2026-06-01T00:00:00.000Z');
      assert.strictEqual(byId[3].access_count, 1);
      assert.strictEqual(byId[3].last_accessed, '2026-06-01T00:00:00.000Z');
      // id 2 was not in the lookup — untouched.
      assert.strictEqual(byId[2].access_count, 0);
      assert.strictEqual(byId[2].last_accessed, null);
      db.close();
    } finally {
      if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prev;
    }
  });

  it('dedups ids: an entry shown twice in one lookup counts once', () => {
    const prev = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      const db = seededDb();
      recordAccess(db, [1, 1, 1, 2], { now: '2026-06-01T00:00:00.000Z' });
      const byId = Object.fromEntries(rows(db).map(r => [r.id, r]));
      assert.strictEqual(byId[1].access_count, 1, 'duplicate id 1 must count once');
      assert.strictEqual(byId[2].access_count, 1);
      db.close();
    } finally {
      if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prev;
    }
  });

  it('ignores null/undefined ids and an empty list', () => {
    const prev = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      const db = seededDb();
      recordAccess(db, [], { now: '2026-06-01T00:00:00.000Z' });
      recordAccess(db, [null, undefined], { now: '2026-06-01T00:00:00.000Z' });
      recordAccess(db, [null, 2], { now: '2026-06-01T00:00:00.000Z' });
      const byId = Object.fromEntries(rows(db).map(r => [r.id, r]));
      assert.strictEqual(byId[2].access_count, 1, 'only the real id 2 increments');
      assert.strictEqual(byId[1].access_count, 0);
      db.close();
    } finally {
      if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prev;
    }
  });
});

// END TO END: which CLI read paths fire recordAccess (FIX 1). Subprocesses run
// with NODE_TEST_CONTEXT explicitly cleared so the production write path is live;
// we read access_count straight out of the store after each command.
describe('recordAccess wiring: only intentional lookups count (FIX 1, e2e)', () => {
  function project() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-access-e2e-'));
    dirs.push(d);
    // Just the .pebbl dir — openDb/ensureProjectFiles create the schema and config
    // on first command. We skip `pebbl init` on purpose: it is far slower here and
    // we only need a discoverable store, not git hooks.
    fs.mkdirSync(path.join(d, '.pebbl'));
    run(d, ['log', 'the project uses sqlite for storage because it is simple',
            '--cat', 'decision', '--topic', 'db', '--importance', '4']);
    return d;
  }
  function run(cwd, args) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // exercise the real (counting) path
    return spawnSync('node', [BIN, ...args], { cwd, env, encoding: 'utf8' });
  }
  function accessCount(dir, id) {
    const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
    const row = db.prepare('SELECT access_count, last_accessed FROM logs WHERE id = ?').get(id);
    db.close();
    return row;
  }

  it('context --topic INCREMENTS (the intentional lookup) and stamps last_accessed', () => {
    const dir = project();
    assert.strictEqual(accessCount(dir, 1).access_count, 0, 'starts at 0');
    run(dir, ['context', '--topic', 'db']);
    const after = accessCount(dir, 1);
    assert.strictEqual(after.access_count, 1, 'targeted retrieval must count');
    assert.ok(after.last_accessed, 'last_accessed stamped on the lookup');
  });

  it('the plain `context` dump does NOT increment (no print-frequency loop)', () => {
    const dir = project();
    run(dir, ['context']);
    assert.strictEqual(accessCount(dir, 1).access_count, 0, 'default dump must not count');
  });

  it('`context --full` does NOT increment (broad dump, not a lookup)', () => {
    const dir = project();
    run(dir, ['context', '--full']);
    assert.strictEqual(accessCount(dir, 1).access_count, 0, '--full dump must not count');
  });
});
