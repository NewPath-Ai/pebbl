'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { createIntent, appendQaPairs } = require('../src/intent');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-intent-'));
  return dir;
}

function setupDb(dir) {
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp         TEXT NOT NULL,
      topic             TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      goal              TEXT NOT NULL,
      constraints       TEXT,
      posture_snapshot  TEXT,
      qa_pairs          TEXT,
      spec              TEXT,
      linked_handoff_id INTEGER,
      source            TEXT NOT NULL DEFAULT 'human'
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
  return db;
}

describe('intent', () => {
  describe('createIntent', () => {
    it('creates a draft intent with goal', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'config.yml'), 'posture:\n  maturity: prototype\n');
      const db = setupDb(dir);
      const id = createIntent(db, dir, 'build a feedback widget', { topic: 'editor' });
      assert.ok(id > 0);

      const row = db.prepare('SELECT * FROM intents WHERE id = ?').get(id);
      assert.equal(row.goal, 'build a feedback widget');
      assert.equal(row.topic, 'editor');
      assert.equal(row.status, 'draft');
      assert.equal(row.source, 'human');
    });

    it('snapshots current posture', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'config.yml'), 'posture:\n  maturity: production\n  security: strict\n');
      const db = setupDb(dir);
      const id = createIntent(db, dir, 'secure auth flow', {});
      const row = db.prepare('SELECT posture_snapshot FROM intents WHERE id = ?').get(id);
      const posture = JSON.parse(row.posture_snapshot);
      assert.equal(posture.maturity, 'production');
      assert.equal(posture.security, 'strict');
    });

    it('handles missing posture gracefully', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'config.yml'), 'compaction:\n  threshold: 10\n');
      const db = setupDb(dir);
      const id = createIntent(db, dir, 'quick fix', {});
      const row = db.prepare('SELECT posture_snapshot FROM intents WHERE id = ?').get(id);
      assert.equal(row.posture_snapshot, null);
    });

    it('stores constraints', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'config.yml'), '');
      const db = setupDb(dir);
      const id = createIntent(db, dir, 'offline mode', { constraints: 'must work without network' });
      const row = db.prepare('SELECT constraints FROM intents WHERE id = ?').get(id);
      assert.equal(row.constraints, 'must work without network');
    });
  });

  describe('appendQaPairs', () => {
    it('appends a Q&A pair', () => {
      const dir = tmpDir();
      const db = setupDb(dir);
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs) VALUES (?, ?, '[]')").run(
        new Date().toISOString(), 'test'
      );
      appendQaPairs(db, 1, 'Q: What framework?; A: React');
      const row = db.prepare('SELECT qa_pairs FROM intents WHERE id = 1').get();
      const pairs = JSON.parse(row.qa_pairs);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].q, 'What framework?');
      assert.equal(pairs[0].a, 'React');
    });

    it('appends multiple pairs', () => {
      const dir = tmpDir();
      const db = setupDb(dir);
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs) VALUES (?, ?, '[]')").run(
        new Date().toISOString(), 'test'
      );
      appendQaPairs(db, 1, 'Q: Framework?; A: React; Q: Styling?; A: Tailwind');
      const row = db.prepare('SELECT qa_pairs FROM intents WHERE id = 1').get();
      const pairs = JSON.parse(row.qa_pairs);
      assert.equal(pairs.length, 2);
    });

    it('preserves existing pairs', () => {
      const dir = tmpDir();
      const db = setupDb(dir);
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs) VALUES (?, ?, ?)").run(
        new Date().toISOString(), 'test', JSON.stringify([{ q: 'old?', a: 'yes' }])
      );
      appendQaPairs(db, 1, 'Q: new?; A: also yes');
      const row = db.prepare('SELECT qa_pairs FROM intents WHERE id = 1').get();
      const pairs = JSON.parse(row.qa_pairs);
      assert.equal(pairs.length, 2);
      assert.equal(pairs[0].q, 'old?');
    });
  });

  describe('status transitions', () => {
    it('draft -> approved -> closed', () => {
      const dir = tmpDir();
      const db = setupDb(dir);
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs, status) VALUES (?, ?, '[]', 'draft')").run(
        new Date().toISOString(), 'test'
      );

      db.prepare("UPDATE intents SET status = 'approved' WHERE id = 1").run();
      let row = db.prepare('SELECT status FROM intents WHERE id = 1').get();
      assert.equal(row.status, 'approved');

      db.prepare("UPDATE intents SET status = 'closed' WHERE id = 1").run();
      row = db.prepare('SELECT status FROM intents WHERE id = 1').get();
      assert.equal(row.status, 'closed');
    });
  });

  describe('current intent', () => {
    it('returns most recent non-closed intent', () => {
      const dir = tmpDir();
      const db = setupDb(dir);
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs, status) VALUES (?, ?, '[]', 'closed')").run(
        '2025-01-01T00:00:00Z', 'old closed'
      );
      db.prepare("INSERT INTO intents (timestamp, goal, qa_pairs, status) VALUES (?, ?, '[]', 'approved')").run(
        '2025-01-02T00:00:00Z', 'current one'
      );
      const row = db.prepare("SELECT * FROM intents WHERE status != 'closed' ORDER BY id DESC LIMIT 1").get();
      assert.equal(row.goal, 'current one');
    });
  });
});
