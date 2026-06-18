'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { migrate, getVersion } = require('../src/migrate');
const { ensureProjectFiles } = require('../src/rubric');

let dirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
  dirs.push(d);
  return d;
}

function oldDb(dir) {
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      source    TEXT NOT NULL DEFAULT 'manual',
      message   TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO logs (timestamp, source, message) VALUES (?, ?, ?)").run(
    new Date().toISOString(), 'manual', 'test entry'
  );
  db.close();
  return dbPath;
}

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('migrate', () => {
  it('is no-op on new db (already has v0.2 schema)', () => {
    const dir = tmpDir();
    const db = new Database(path.join(dir, 'db.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
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
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.2');
    `);
    migrate(db);
    assert.strictEqual(getVersion(db), 0.6);
    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));
    assert(names.includes('topics'));
    // v0.3: migration is a no-op on a new DB (no signal entries to rename)
    const tierDefault = cols.find(c => c.name === 'tier');
    assert.strictEqual(tierDefault.dflt_value, "'detail'");
    db.close();
  });

  it('adds missing columns and normalizes source on old v0.1 db', () => {
    const dir = tmpDir();
    const dbPath = oldDb(dir);
    const db = new Database(dbPath);
    migrate(db);

    assert.strictEqual(getVersion(db), 0.6);

    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));
    assert(names.includes('topics'));
    assert(names.includes('relates_to'));
    assert(names.includes('corrects'));

    const categoryCol = cols.find(c => c.name === 'category');
    assert.strictEqual(categoryCol.dflt_value, "'uncategorized'");

    const tierCol = cols.find(c => c.name === 'tier');
    assert.strictEqual(tierCol.dflt_value, "'detail'");

    const row = db.prepare("SELECT category, tier, source FROM logs WHERE message = 'test entry'").get();
    assert.strictEqual(row.category, 'uncategorized');
    assert.strictEqual(row.tier, 'detail');
    assert.strictEqual(row.source, 'human');

    db.close();
  });

  it('is idempotent (running twice does not error)', () => {
    const dir = tmpDir();
    const dbPath = oldDb(dir);
    const db = new Database(dbPath);

    migrate(db);
    assert.strictEqual(getVersion(db), 0.6);

    assert.doesNotThrow(() => {
      migrate(db);
    });

    assert.strictEqual(getVersion(db), 0.6);

    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));

    db.close();
  });
});

describe('migrate v0.6 (rerank signals)', () => {
  const RERANK_COLS = ['importance', 'access_count', 'last_accessed'];

  // A db already at the v0.5 schema: logs has the bitemporal columns and meta
  // says 0.5. The v0.6 migration must add exactly the three rerank columns.
  function v05Db(dir) {
    const db = new Database(path.join(dir, 'db.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT    NOT NULL,
        source     TEXT    NOT NULL DEFAULT 'human',
        category   TEXT    NOT NULL DEFAULT 'uncategorized',
        tier       TEXT    NOT NULL DEFAULT 'detail',
        message    TEXT    NOT NULL,
        topics     TEXT,
        relates_to INTEGER,
        corrects   INTEGER,
        valid_from TEXT,
        valid_to   TEXT,
        invalidated_by INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.5');
    `);
    return db;
  }

  it('bumps to v0.6 and adds the three rerank columns on a fresh openDb db', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.pebbl'));
    const { openDb } = require('../src/db');
    const db = openDb(path.join(dir, '.pebbl'));
    assert.strictEqual(getVersion(db), 0.6);
    const names = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
    for (const c of RERANK_COLS) assert(names.includes(c), `missing column ${c}`);
    db.close();
  });

  it('adds the three rerank columns on a prior-version (v0.5) db, with sane defaults', () => {
    const dir = tmpDir();
    const db = v05Db(dir);
    db.prepare('INSERT INTO logs (timestamp, message) VALUES (?, ?)')
      .run('2026-01-01T00:00:00.000Z', 'an existing belief');
    migrate(db);
    assert.strictEqual(getVersion(db), 0.6);

    const cols = db.prepare('PRAGMA table_info(logs)').all();
    const names = cols.map(c => c.name);
    for (const c of RERANK_COLS) assert(names.includes(c), `missing column ${c}`);

    // defaults exist for the score to read against pre-v0.6 rows
    const importance = cols.find(c => c.name === 'importance');
    const accessCount = cols.find(c => c.name === 'access_count');
    assert.strictEqual(importance.type, 'REAL');
    assert.strictEqual(accessCount.type, 'INTEGER');

    const row = db.prepare('SELECT importance, access_count, last_accessed FROM logs WHERE message = ?')
      .get('an existing belief');
    assert.strictEqual(row.importance, 0);
    assert.strictEqual(row.access_count, 0);
    assert.strictEqual(row.last_accessed, null);
    db.close();
  });

  it('is idempotent: a second migrate does not error or change version', () => {
    const dir = tmpDir();
    const db = v05Db(dir);
    migrate(db);
    assert.strictEqual(getVersion(db), 0.6);
    assert.doesNotThrow(() => migrate(db));
    assert.strictEqual(getVersion(db), 0.6);
    db.close();
  });
});

describe('ensureProjectFiles', () => {
  let dir;

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates rubric.yml and config.yml if missing', () => {
    dir = tmpDir();
    ensureProjectFiles(dir);
    assert(fs.existsSync(path.join(dir, 'rubric.yml')));
    assert(fs.existsSync(path.join(dir, 'config.yml')));
  });

  it('does not overwrite existing rubric.yml, but applies migrations', () => {
    dir = tmpDir();
    const custom = 'rules:\n  - pattern: "custom"\n    category: quality\n    tier: component\n';
    fs.writeFileSync(path.join(dir, 'rubric.yml'), custom);
    ensureProjectFiles(dir);
    const content = fs.readFileSync(path.join(dir, 'rubric.yml'), 'utf8');
    assert(content.includes('custom'), 'custom rules preserved');
    assert(content.includes('^trace:'), 'trace rule migrated in');
  });
});
