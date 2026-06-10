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
    assert.strictEqual(getVersion(db), 0.4);
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

    assert.strictEqual(getVersion(db), 0.4);

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
    assert.strictEqual(getVersion(db), 0.4);

    assert.doesNotThrow(() => {
      migrate(db);
    });

    assert.strictEqual(getVersion(db), 0.4);

    const cols = db.prepare("PRAGMA table_info(logs)").all();
    const names = cols.map(c => c.name);
    assert(names.includes('category'));
    assert(names.includes('tier'));

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
