'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
}

function setupDb(dir) {
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
  `);
  return db;
}

describe('compact - buildGroups', () => {
  const { buildGroups } = require('../src/compact');

  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('groups entries by category/primaryTopic/month above threshold', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 5; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'decision', 'detail', `decision ${i}`, 'auth,security');
    }
    for (let i = 0; i < 3; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'structure', 'detail', `structure ${i}`, 'api');
    }

    const { groups } = buildGroups(db, 4);

    assert(groups.has('decision/auth/2026-05'));
    assert.strictEqual(groups.get('decision/auth/2026-05').length, 5);
    assert(!groups.has('structure/api/2026-05'));
  });

  it('filters groups below threshold', () => {
    const { groups } = buildGroups(db, 6);
    assert(!groups.has('decision/auth/2026-05'));
  });

  it('puts uncategorized entries in ambiguous list', () => {
    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('2026-05-10', 'human', 'uncategorized', 'detail', 'ambiguous note', 'random');

    const { ambiguous } = buildGroups(db, 10);
    const found = ambiguous.find(e => e.message === 'ambiguous note');
    assert(found);
    assert.strictEqual(found.category, 'uncategorized');
  });

  it('puts fleeting entries in fleeting list (not groups)', () => {
    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('2026-05-10', 'agent', 'decision', 'fleeting', 'old fleeting note', 'auth');

    const { groups, fleeting } = buildGroups(db, 4);
    const found = fleeting.find(e => e.message === 'old fleeting note');
    assert(found);
    assert.strictEqual(found.tier, 'fleeting');
    // Fleet entries should not be in groups
    const group = groups.get('decision/auth/2026-05');
    if (group) {
      const inGroup = group.find(e => e.tier === 'fleeting');
      assert(!inGroup);
    }
  });

  it('handles entries without topics (defaults to general)', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 12; i++) {
      insert.run('2026-05-0' + (i % 9 + 1), 'human', 'pattern', 'detail', `pattern ${i}`, null);
    }

    const { groups } = buildGroups(db, 10);
    assert(groups.has('pattern/general/2026-05'));
  });

  it('groups across different months separately', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 5; i++) {
      insert.run('2026-05-0' + (i + 1), 'human', 'data', 'detail', `may ${i}`, 'storage');
    }
    for (let i = 0; i < 5; i++) {
      insert.run('2026-06-0' + (i + 1), 'human', 'data', 'detail', `june ${i}`, 'storage');
    }

    const { groups } = buildGroups(db, 5);
    assert(groups.has('data/storage/2026-05'));
    assert(groups.has('data/storage/2026-06'));
    assert.strictEqual(groups.get('data/storage/2026-05').length, 5);
    assert.strictEqual(groups.get('data/storage/2026-06').length, 5);
  });
});
