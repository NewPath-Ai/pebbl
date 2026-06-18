'use strict';
// Bi-temporal supersession (v0.5): a correction STAMPS when a belief stopped
// being true (valid_to) instead of HIDING the superseded row, so the timeline
// survives. These tests cover the acceptance scenarios from the traveler:
//   - migration bumps to v0.5 and adds the 3 columns idempotently, on a fresh
//     db and on a prior-version (v0.4) db, and retro-stamps existing corrects.
//   - the current-belief read predicate (valid_to IS NULL) shows only the new
//     belief after a correction; the as-of predicate returns the superseded one
//     at a date before the correction.
//   - log --history prints the supersession chain.
//   - a 3-link chain A<-B<-C leaves A's ORIGINAL valid_to intact (write guard).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { migrate, getVersion } = require('../src/migrate');
const { openDb, notCorrected, validAsOf } = require('../src/db');
const { printHistory } = require('../src/log');

let dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-bitemporal-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// A db at the v0.4 schema (logs has corrects but none of the v0.5 columns),
// matching what a real prior-version install looks like on disk.
function v04Db(dir, seed) {
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(`
    CREATE TABLE logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT    NOT NULL,
      source     TEXT    NOT NULL DEFAULT 'human',
      category   TEXT    NOT NULL DEFAULT 'uncategorized',
      tier       TEXT    NOT NULL DEFAULT 'detail',
      message    TEXT    NOT NULL,
      topics     TEXT,
      relates_to INTEGER,
      corrects   INTEGER
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '0.4');
  `);
  if (seed) seed(db);
  return db;
}

// Mirror the production write path's --corrects stamp (src/log.js): set the
// target's valid_to/invalidated_by, guarded by AND valid_to IS NULL so an
// already-superseded row is not re-stamped.
function correct(db, { ts, message, correctsId }) {
  const info = db.prepare(
    'INSERT INTO logs (timestamp, category, tier, message, corrects, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).run(ts, 'decision', 'component', message, correctsId, ts);
  const newId = Number(info.lastInsertRowid);
  db.prepare('UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL')
    .run(ts, newId, correctsId);
  return newId;
}

function capture(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

describe('bitemporal migration (v0.5)', () => {
  it('bumps to v0.5 and adds the three columns on a fresh openDb db', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.pebbl'));
    const db = openDb(path.join(dir, '.pebbl'));
    assert.strictEqual(getVersion(db), 0.5);
    const names = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
    assert.ok(names.includes('valid_from'));
    assert.ok(names.includes('valid_to'));
    assert.ok(names.includes('invalidated_by'));
    db.close();
  });

  it('adds the columns and backfills valid_from on a prior-version (v0.4) db', () => {
    const dir = tmpDir();
    const db = v04Db(dir, (d) => {
      d.prepare('INSERT INTO logs (timestamp, message) VALUES (?, ?)')
        .run('2026-01-01T00:00:00.000Z', 'an old belief');
    });
    migrate(db);
    assert.strictEqual(getVersion(db), 0.5);
    const names = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
    assert.ok(names.includes('valid_from') && names.includes('valid_to') && names.includes('invalidated_by'));
    const row = db.prepare('SELECT valid_from, valid_to FROM logs WHERE message = ?').get('an old belief');
    assert.strictEqual(row.valid_from, '2026-01-01T00:00:00.000Z'); // backfilled from timestamp
    assert.strictEqual(row.valid_to, null);                          // still currently believed
    db.close();
  });

  it('retro-stamps an existing corrects link so old hide-behavior is preserved', () => {
    const dir = tmpDir();
    const db = v04Db(dir, (d) => {
      const ins = d.prepare('INSERT INTO logs (timestamp, message, corrects) VALUES (?, ?, ?)');
      ins.run('2026-01-01T00:00:00.000Z', 'old: sessions', null);      // id 1
      ins.run('2026-03-01T00:00:00.000Z', 'new: JWT', 1);              // id 2 corrects 1
    });
    migrate(db);
    const old = db.prepare('SELECT valid_to, invalidated_by FROM logs WHERE id = 1').get();
    const cur = db.prepare('SELECT valid_to FROM logs WHERE id = 2').get();
    assert.strictEqual(old.valid_to, '2026-03-01T00:00:00.000Z'); // stamped at correction time
    assert.strictEqual(old.invalidated_by, 2);                     // by the correcting entry
    assert.strictEqual(cur.valid_to, null);                        // current belief stays open
    db.close();
  });

  it('is idempotent: running migrate twice does not error or change version', () => {
    const dir = tmpDir();
    const db = v04Db(dir);
    migrate(db);
    assert.strictEqual(getVersion(db), 0.5);
    assert.doesNotThrow(() => migrate(db));
    assert.strictEqual(getVersion(db), 0.5);
    db.close();
  });
});

describe('bitemporal read predicates', () => {
  function setup() {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.pebbl'));
    const db = openDb(path.join(dir, '.pebbl'));
    return db;
  }

  it('context (valid_to IS NULL) shows only the new belief, but --as-of returns the superseded one', () => {
    const db = setup();
    // A belief, then a correction three months later.
    db.prepare('INSERT INTO logs (timestamp, category, tier, message, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('2026-01-01T00:00:00.000Z', 'decision', 'component', 'use sessions', '2026-01-01T00:00:00.000Z');
    correct(db, { ts: '2026-03-01T00:00:00.000Z', message: 'use JWT', correctsId: 1 });

    // Current belief: valid_to IS NULL → only the new one.
    const current = db.prepare(`SELECT message FROM logs WHERE ${notCorrected()} ORDER BY id`).all();
    assert.deepStrictEqual(current.map(r => r.message), ['use JWT']);

    // As of a date BEFORE the correction → the superseded belief reappears.
    const before = '2026-02-01T00:00:00.000Z';
    const asOfBefore = db.prepare(`SELECT message FROM logs WHERE ${validAsOf()} ORDER BY id`).all(before, before);
    assert.deepStrictEqual(asOfBefore.map(r => r.message), ['use sessions']);

    // As of a date AFTER the correction → the new belief.
    const after = '2026-04-01T00:00:00.000Z';
    const asOfAfter = db.prepare(`SELECT message FROM logs WHERE ${validAsOf()} ORDER BY id`).all(after, after);
    assert.deepStrictEqual(asOfAfter.map(r => r.message), ['use JWT']);
    db.close();
  });

  it('a 3-link chain A<-B<-C leaves A original valid_to intact (write guard does not re-stamp)', () => {
    const db = setup();
    db.prepare('INSERT INTO logs (timestamp, category, tier, message, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('2026-01-01T00:00:00.000Z', 'decision', 'component', 'A', '2026-01-01T00:00:00.000Z'); // id 1
    const bTs = '2026-02-01T00:00:00.000Z';
    const bId = correct(db, { ts: bTs, message: 'B', correctsId: 1 }); // stamps A.valid_to = bTs
    // C corrects B. A is already superseded; correcting it again must NOT touch A.
    correct(db, { ts: '2026-03-01T00:00:00.000Z', message: 'C', correctsId: bId });

    const a = db.prepare('SELECT valid_to, invalidated_by FROM logs WHERE id = 1').get();
    assert.strictEqual(a.valid_to, bTs);       // A still stamped at B's time, not C's
    assert.strictEqual(a.invalidated_by, bId); // still attributed to B

    // Sanity: the guard also means re-correcting A directly is a no-op on the stamp.
    const reStamp = db.prepare('UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL')
      .run('2026-09-09T00:00:00.000Z', 999, 1);
    assert.strictEqual(reStamp.changes, 0);

    // Only C is the current belief.
    const current = db.prepare(`SELECT message FROM logs WHERE ${notCorrected()} ORDER BY id`).all();
    assert.deepStrictEqual(current.map(r => r.message), ['C']);
    db.close();
  });
});

describe('log --history', () => {
  it('prints the supersession chain root → current for an entry', () => {
    const dir = tmpDir();
    const pebblDir = path.join(dir, '.pebbl');
    fs.mkdirSync(pebblDir);
    const db = openDb(pebblDir);
    db.prepare('INSERT INTO logs (timestamp, category, tier, message, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('2026-01-01T00:00:00.000Z', 'decision', 'component', 'A sessions', '2026-01-01T00:00:00.000Z');
    const bId = correct(db, { ts: '2026-02-01T00:00:00.000Z', message: 'B JWT', correctsId: 1 });
    correct(db, { ts: '2026-03-01T00:00:00.000Z', message: 'C refresh rotation', correctsId: bId });
    db.close();

    // Ask history from the MIDDLE link; it should still print the whole chain.
    const origCwd = process.cwd();
    process.chdir(dir);
    let out;
    try { out = capture(() => printHistory(pebblDir, bId)); }
    finally { process.chdir(origCwd); }

    assert.match(out, /HISTORY: #2/);
    assert.match(out, /A sessions/);
    assert.match(out, /B JWT/);
    assert.match(out, /C refresh rotation/);
    assert.match(out, /current/);            // the tail of the chain is current
    assert.match(out, /superseded/);         // earlier links are stamped superseded
    assert.match(out, /3 links/);            // root → current, linear
  });
});
