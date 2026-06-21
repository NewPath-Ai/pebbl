'use strict';
// Mask secret-SHAPES at the db -> .md projection boundary, while the
// authoritative store (db.sqlite / the event log) keeps the ORIGINAL text.
// This is the unblock for the factory promote gate: a FAKE fixture key quoted
// verbatim in a pebbl note (e.g. an `api_key=…` assignment) must not
// appear raw in the committed handoffs.md / manual-logs.md, or the gate's
// SECRET_RE false-blocks a staging->main promote.
//
// Acceptance (from the task workpad):
//   1. a handoff/log whose text contains a secret-shape renders to .md masked
//   2. the masked placeholder does NOT itself match the secret-shape pattern
//   3. the authoritative store (db.sqlite) still holds the ORIGINAL, unmasked text
//   4. re-projecting the same data twice yields byte-identical .md (no churn)

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const privacy = require('../src/privacy-scan');
const { redact, scan, _internal } = privacy;
const { materializeHandoffsMd } = require('../src/handoff');
const { renderManualLogsMd, renderHandoffsMd, renderCommitLogMd, renderNarrativeMd } = require('../src/view');

// The canonical secret-shape that blocks the real promote (a FAKE droplet key).
const FAKE_SECRET = 'api_key=live_droplet_key_abc123'; // allowlist-secret: intentional fake fixture for the redaction test
const FAKE_TOKEN = 'token=ghp_AAAAAAAAAAAAAAAAAAAAAAAA'; // allowlist-secret: intentional fake fixture for the redaction test

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-redact-'));
}

// True iff `text` still carries a TOKEN-class secret shape (the class the
// promote gate blocks on). Reused everywhere so "masked" means one thing.
function stillHasSecretShape(text) {
  for (const line of String(text).split('\n')) {
    if (_internal.findTokens(line).length > 0) return true;
  }
  return false;
}

describe('redact() — the projection-boundary mask (unit)', () => {
  it('masks the gate-blocking assignment shape but keeps the key readable', () => {
    const out = redact(`note about droplet_bad.conf where ${FAKE_SECRET} is a fake fixture`);
    assert.ok(!out.includes('live_droplet_key_abc123'), 'raw value must be gone');
    assert.ok(out.includes('api_key='), 'the key= prefix stays for readability');
    assert.ok(out.includes(privacy.REDACTED), 'the placeholder is written in');
  });

  it('the placeholder does NOT re-trip the secret-shape scan (acceptance #2)', () => {
    const out = redact(`${FAKE_SECRET} and ${FAKE_TOKEN} and key sk-ant-api03-abcdefgh12345678`);
    assert.equal(stillHasSecretShape(out), false, 'masked output must not match any token shape');
    // and the placeholder, scanned alone, is clean too.
    assert.equal(stillHasSecretShape(privacy.REDACTED), false);
    assert.equal(scan(out).filter((h) => h.class === 'token').length, 0);
  });

  it('is deterministic and idempotent — re-redacting is a fixed point', () => {
    const input = `a ${FAKE_SECRET}\nb clean line\nc ${FAKE_TOKEN}`;
    const once = redact(input);
    const twice = redact(once);
    assert.equal(once, redact(input), 'same input -> same output (deterministic)');
    assert.equal(twice, once, 'already-masked text is unchanged (idempotent, no churn)');
  });

  it('leaves secret-free prose byte-identical', () => {
    const prose = 'the system uses sqlite because it ships in-tree; no secrets here';
    assert.equal(redact(prose), prose);
  });

  it('masks every secret on a multi-secret line', () => {
    const out = redact(`first ${FAKE_SECRET} then password="anotherlongsecret123" done`); // allowlist-secret: intentional fake fixtures for the redaction test
    assert.equal(stillHasSecretShape(out), false);
    assert.ok(!out.includes('anotherlongsecret123'));
  });
});

describe('handoff projection — materializeHandoffsMd (real db -> handoffs.md)', () => {
  let dir, db;
  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setupDb(d) {
    const database = new Database(path.join(d, 'db.sqlite'));
    database.exec(`
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
        docs             TEXT
      );
    `);
    return database;
  }

  it('masks the secret in handoffs.md but keeps it verbatim in db.sqlite', () => {
    dir = tmpDir();
    db = setupDb(dir);
    const ts = '2026-06-21T10:00:00.000Z';
    db.prepare(`
      INSERT INTO handoffs (timestamp, summary, done, todo, status, session_entries, session_commits)
      VALUES (?, ?, ?, ?, 'closed', '[]', '[]')
    `).run(
      ts,
      `documented droplet_bad.conf — it quotes ${FAKE_SECRET} as a fake`,
      `wired the scan; ${FAKE_TOKEN} is a sample`,
      'follow-up: ratchet on write',
    );

    materializeHandoffsMd(dir, db);
    const mdPath = path.join(dir, 'handoffs.md');
    const md = fs.readFileSync(mdPath, 'utf8');

    // (a) the rendered .md no longer carries the raw secret shape.
    assert.ok(!md.includes('live_droplet_key_abc123'), 'raw api_key value leaked into handoffs.md');
    assert.ok(!md.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAA'), 'raw token leaked into handoffs.md');
    // (b) the masked .md does not re-trip the secret scan.
    assert.equal(stillHasSecretShape(md), false, 'handoffs.md still trips the secret scan');

    // (c) the authoritative store keeps the ORIGINAL text untouched.
    const row = db.prepare('SELECT summary, done FROM handoffs WHERE id = 1').get();
    assert.ok(row.summary.includes(FAKE_SECRET), 'db.sqlite lost the original summary text');
    assert.ok(row.done.includes(FAKE_TOKEN), 'db.sqlite lost the original done text');

    // (d) re-projecting twice is byte-identical (no churn).
    materializeHandoffsMd(dir, db);
    const md2 = fs.readFileSync(mdPath, 'utf8');
    assert.equal(md2, md, 'second projection must be byte-identical to the first');
  });
});

describe('view.js emitters — the event-sourced render path (compact.js shares these)', () => {
  it('renderManualLogsMd masks the message and is byte-stable', () => {
    const logs = [
      { id: 1, timestamp: '2026-06-21T09:00:00.000Z', message: `the fake key is ${FAKE_SECRET}`, category: 'data', tier: 'detail', source: 'agent', topics: 'security' },
      { id: 2, timestamp: '2026-06-21T09:01:00.000Z', message: 'a perfectly clean note', category: 'decision', tier: 'foundation', source: 'human', topics: '' },
    ];
    const md = renderManualLogsMd(logs);
    assert.ok(!md.includes('live_droplet_key_abc123'));
    assert.equal(stillHasSecretShape(md), false);
    assert.equal(renderManualLogsMd(logs), md, 'deterministic');
  });

  it('renderHandoffsMd masks summary + items', () => {
    const handoffs = [
      { id: 7, timestamp: '2026-06-21T09:00:00.000Z', summary: `closed with ${FAKE_SECRET}`, done: `did ${FAKE_TOKEN}`, todo: '', blocked: '', topics: 'x', status: 'closed', closed_at: '2026-06-21T10:00:00.000Z' },
    ];
    const md = renderHandoffsMd(handoffs);
    assert.equal(stillHasSecretShape(md), false);
    assert.ok(!md.includes('live_droplet_key_abc123'));
    assert.ok(!md.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAA'));
  });

  it('renderCommitLogMd and renderNarrativeMd mask their text', () => {
    const commitMd = renderCommitLogMd([
      { timestamp: '2026-06-21T09:00:00.000Z', hash: 'deadbeefcafe', message: `fix: stop logging ${FAKE_SECRET}`, files: 'a.js', category: 'quality', tier: 'fleeting' },
    ]);
    assert.equal(stillHasSecretShape(commitMd), false);
    assert.ok(!commitMd.includes('live_droplet_key_abc123'));

    const narrativeMd = renderNarrativeMd({ text: `engine talks to droplet via ${FAKE_SECRET}`, refs: [1, 2], updated: '2026-06-21T09:00:00.000Z' });
    assert.equal(stillHasSecretShape(narrativeMd), false);
    assert.ok(!narrativeMd.includes('live_droplet_key_abc123'));
  });
});
