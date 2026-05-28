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
    CREATE TABLE IF NOT EXISTS handoffs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT    NOT NULL,
      summary          TEXT    NOT NULL,
      done             TEXT,
      todo             TEXT,
      blocked          TEXT,
      topics           TEXT,
      source           TEXT    NOT NULL DEFAULT 'agent',
      session_entries  TEXT,
      session_commits  TEXT,
      status           TEXT    NOT NULL DEFAULT 'open',
      closed_at        TEXT,
      promoted_log_id  INTEGER,
      docs             TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.4');
  `);
  return db;
}

describe('handoff - create', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a handoff with all fields', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const ts = '2026-05-25T10:00:00.000Z';
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, 'test summary', 'task A; task B', 'task C', 'waiting on review', 'auth,db', 'human', '[]', '[]', 'open');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();

    assert(row);
    assert.strictEqual(row.summary, 'test summary');
    assert.strictEqual(row.done, 'task A; task B');
    assert.strictEqual(row.todo, 'task C');
    assert.strictEqual(row.blocked, 'waiting on review');
    assert.strictEqual(row.topics, 'auth,db');
    assert.strictEqual(row.source, 'human');
    assert.strictEqual(row.session_entries, '[]');
    assert.strictEqual(row.session_commits, '[]');
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.timestamp, ts);
  });

  it('auto-collects session entries since last handoff', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Insert logs before the previous handoff (should NOT be collected)
    insertLog.run('2026-05-24T10:00:00.000Z', 'human', 'decision', 'detail', 'old entry 1', 'auth');
    insertLog.run('2026-05-24T11:00:00.000Z', 'human', 'decision', 'detail', 'old entry 2', 'auth');

    // Insert a previous handoff with timestamp 2026-05-24T12:00:00Z
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-24T12:00:00.000Z', 'previous handoff', 'closed');

    // Insert logs after the previous handoff (SHOULD be collected)
    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'detail', 'new entry 1', 'auth');
    insertLog.run('2026-05-25T09:00:00.000Z', 'human', 'decision', 'detail', 'new entry 2', 'db');

    // Simulate auto-collect: find logs since last handoff
    const lastHandoff = db.prepare('SELECT timestamp FROM handoffs ORDER BY id DESC LIMIT 1').get();
    const cutoff = lastHandoff.timestamp;
    const sessionLogs = db.prepare('SELECT id FROM logs WHERE timestamp > ?').all(cutoff);
    const sessionEntries = sessionLogs.map(r => r.id);

    assert.strictEqual(sessionEntries.length, 2);
    // IDs 1 and 2 were before cutoff; IDs 3 and 4 are after
    assert(sessionEntries.includes(3));
    assert(sessionEntries.includes(4));
  });

  it('defaults status to open', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary) VALUES (?, ?)'
    ).run('2026-05-25T12:00:00.000Z', 'new handoff');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();

    assert(row);
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.closed_at, null);
  });
});

describe('handoff - close', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('promotes handoff summary to foundation-tier log entry', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const ts = '2026-05-25T10:00:00.000Z';
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, 'completed auth module', 'implemented JWT; added tests', 'write docs', 'CI pipeline', 'auth,security', 'agent', '[]', '[]', 'open');

    // Simulate close logic — build promoted message
    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

    const parts = [`handoff #${row.id} closed: ${row.summary}`];
    if (row.done) parts.push(`done: ${row.done}`);
    if (row.todo) parts.push(`remaining: ${row.todo}`);
    if (row.blocked) parts.push(`blocked: ${row.blocked}`);
    const promotedMessage = parts.join('. ');

    const closeTs = '2026-05-25T18:00:00.000Z';
    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, ?)
    `).run(closeTs, promotedMessage, row.topics);

    const logEntry = db.prepare('SELECT * FROM logs WHERE id = ?').get(logResult.lastInsertRowid);

    assert(logEntry);
    assert.strictEqual(logEntry.tier, 'foundation');
    assert.strictEqual(logEntry.category, 'decision');
    assert.strictEqual(logEntry.source, 'agent');
    assert(logEntry.message.includes('handoff #1 closed: completed auth module'));
    assert(logEntry.message.includes('done: implemented JWT; added tests'));
    assert(logEntry.message.includes('remaining: write docs'));
    assert(logEntry.message.includes('blocked: CI pipeline'));
    assert.strictEqual(logEntry.topics, 'auth,security');
  });

  it('demotes session detail entries to fleeting', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'detail', 'session entry 1', 'auth');
    insertLog.run('2026-05-25T09:00:00.000Z', 'human', 'decision', 'detail', 'session entry 2', 'db');

    // Create a handoff with session_entries pointing to logs 1 and 2
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, session_entries, status)
      VALUES (?, ?, ?, ?)
    `).run('2026-05-25T10:00:00.000Z', 'test handoff', JSON.stringify([1, 2]), 'open');

    // Simulate close — demote detail entries to fleeting
    const handoff = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const entryIds = JSON.parse(handoff.session_entries || '[]');
    const placeholders = entryIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
    ).run(...entryIds);

    const entry1 = db.prepare('SELECT * FROM logs WHERE id = 1').get();
    const entry2 = db.prepare('SELECT * FROM logs WHERE id = 2').get();

    assert.strictEqual(entry1.tier, 'fleeting');
    assert.strictEqual(entry2.tier, 'fleeting');
  });

  it('does not demote foundation entries', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insertLog = db.prepare(
      'INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)'
    );

    insertLog.run('2026-05-25T08:00:00.000Z', 'human', 'decision', 'foundation', 'important foundation entry', 'auth');

    // Create a handoff that includes the foundation entry in session_entries
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, session_entries, status)
      VALUES (?, ?, ?, ?)
    `).run('2026-05-25T10:00:00.000Z', 'test handoff', JSON.stringify([1]), 'open');

    // Simulate close — demote query has AND tier='detail', so foundation entries are skipped
    const handoff = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const entryIds = JSON.parse(handoff.session_entries || '[]');
    const placeholders = entryIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
    ).run(...entryIds);

    const entry = db.prepare('SELECT * FROM logs WHERE id = 1').get();

    // Foundation entries should NOT be demoted because of the AND tier='detail' guard
    assert.strictEqual(entry.tier, 'foundation');
  });

  it('sets closed_at and promoted_log_id', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-25T10:00:00.000Z', 'test handoff', 'open');

    // Simulate close
    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
    const promotedMessage = `handoff #${row.id} closed: ${row.summary}`;
    const closeTs = '2026-05-25T18:00:00.000Z';

    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, NULL)
    `).run(closeTs, promotedMessage);

    const promotedLogId = logResult.lastInsertRowid;

    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ?, promoted_log_id = ? WHERE id = ?"
    ).run(closeTs, promotedLogId, row.id);

    const handoff = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(row.id);

    assert.strictEqual(handoff.status, 'closed');
    assert.strictEqual(handoff.closed_at, closeTs);
    assert.strictEqual(handoff.promoted_log_id, promotedLogId);
  });
});

describe('handoff - list/latest', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns most recent handoff with --latest logic', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    insert.run('2026-05-23T10:00:00.000Z', 'first handoff', 'closed');
    insert.run('2026-05-24T10:00:00.000Z', 'second handoff', 'closed');
    insert.run('2026-05-25T10:00:00.000Z', 'third handoff', 'open');

    const row = db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT 1').get();

    assert(row);
    assert.strictEqual(row.id, 3);
    assert.strictEqual(row.summary, 'third handoff');
  });

  it('returns last 10 handoffs with --list logic', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    // Insert 12 handoffs
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, '0');
      insert.run(`2026-05-${day}T10:00:00.000Z`, `handoff ${i}`, 'closed');
    }

    const rows = db.prepare(
      'SELECT id, timestamp, summary, topics, status FROM handoffs ORDER BY id DESC LIMIT 10'
    ).all();

    assert.strictEqual(rows.length, 10);
    // Should be IDs 12 down to 3 in reverse chronological order
    assert.strictEqual(rows[0].id, 12);
    assert.strictEqual(rows[0].summary, 'handoff 12');
    assert.strictEqual(rows[9].id, 3);
    assert.strictEqual(rows[9].summary, 'handoff 3');
  });
});

describe('handoff - edge cases', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('close with no open handoff returns null', () => {
    dir = tmpDir();
    db = setupDb(dir);

    // Insert only a closed handoff, no open ones
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-25T10:00:00.000Z', 'already closed', 'closed');

    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

    assert.strictEqual(row, undefined);
  });

  it('close only affects the most recent open handoff', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const insert = db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    );

    insert.run('2026-05-24T10:00:00.000Z', 'first open', 'open');
    insert.run('2026-05-25T10:00:00.000Z', 'second open', 'open');

    // Simulate close — selects most recent open handoff (ORDER BY id DESC LIMIT 1)
    const row = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

    assert(row);
    assert.strictEqual(row.id, 2);
    assert.strictEqual(row.summary, 'second open');

    // Close only that one
    const closeTs = '2026-05-25T18:00:00.000Z';
    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, NULL)
    `).run(closeTs, `handoff #${row.id} closed: ${row.summary}`);

    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ?, promoted_log_id = ? WHERE id = ?"
    ).run(closeTs, logResult.lastInsertRowid, row.id);

    // Verify: only handoff #2 is closed, #1 remains open
    const handoff1 = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    const handoff2 = db.prepare('SELECT * FROM handoffs WHERE id = 2').get();

    assert.strictEqual(handoff1.status, 'open');
    assert.strictEqual(handoff2.status, 'closed');
    assert.strictEqual(handoff2.closed_at, closeTs);
  });
});

describe('handoff - docs', () => {
  let dir, db;

  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores docs as JSON array', () => {
    dir = tmpDir();
    db = setupDb(dir);

    const docs = JSON.stringify(['README.md', 'https://example.com/spec']);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status, docs) VALUES (?, ?, ?, ?)'
    ).run('2026-05-27T10:00:00.000Z', 'test', 'open', docs);

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    const parsed = JSON.parse(row.docs);

    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0], 'README.md');
    assert.strictEqual(parsed[1], 'https://example.com/spec');
  });

  it('docs defaults to null when not provided', () => {
    dir = tmpDir();
    db = setupDb(dir);

    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, status) VALUES (?, ?, ?)'
    ).run('2026-05-27T10:00:00.000Z', 'test', 'open');

    const row = db.prepare('SELECT * FROM handoffs WHERE id = 1').get();
    assert.strictEqual(row.docs, null);
  });
});
