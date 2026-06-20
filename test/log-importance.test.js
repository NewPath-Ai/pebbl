'use strict';

// log.js importance (rerank signal A) — set at WRITE time:
//   - default = importanceForTier(tier) (foundation 5 / component 4 / detail 2 /
//     fleeting 1), so a fresh row is tier-weighted for rerank immediately and the
//     launch ordering does not collapse to recency.
//   - --importance <0..5> overrides the tier default for a hand-graded entry.
//   - a non-numeric / out-of-range --importance errors (exit 1), matching the
//     guard in log.js (does NOT silently store NULL/garbage).
// We drive the real CLI and read importance straight out of the store.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { importanceForTier } = require('../src/rank');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-logimp-'));
  dirs.push(d);
  // Just the .pebbl dir — `pebbl log` creates the schema + config on first run.
  // Skipping `pebbl init` (slow here, and not needed for a discoverable store).
  fs.mkdirSync(path.join(d, '.pebbl'));
  return d;
}

function logEntry(dir, args) {
  return spawnSync('node', [BIN, 'log', ...args], { cwd: dir, encoding: 'utf8' });
}

// Read the most-recently inserted row's tier + importance.
function lastRow(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
  const row = db.prepare('SELECT tier, importance FROM logs ORDER BY id DESC LIMIT 1').get();
  db.close();
  return row;
}

describe('log importance default = importanceForTier(tier)', () => {
  it('a foundation entry defaults to importance 5', () => {
    const dir = project();
    // System-wide language drives the foundation tier.
    const r = logEntry(dir, ['the project uses sqlite because it keeps the store simple', '--cat', 'decision']);
    assert.strictEqual(r.status, 0, r.stderr);
    const row = lastRow(dir);
    assert.strictEqual(row.tier, 'foundation');
    assert.strictEqual(row.importance, importanceForTier('foundation'));
    assert.strictEqual(row.importance, 5);
  });

  it('a detail entry defaults to importance 2', () => {
    const dir = project();
    const r = logEntry(dir, ['tweaked a log line for readability', '--tier', 'detail', '--cat', 'quality']);
    assert.strictEqual(r.status, 0, r.stderr);
    const row = lastRow(dir);
    assert.strictEqual(row.tier, 'detail');
    assert.strictEqual(row.importance, importanceForTier('detail'));
    assert.strictEqual(row.importance, 2);
  });
});

describe('log --importance override', () => {
  it('--importance overrides the tier default', () => {
    const dir = project();
    // Foundation tier (default 5) but hand-grade it down to 1.
    const r = logEntry(dir, ['the system uses redis for the cache because of latency', '--cat', 'decision', '--importance', '1']);
    assert.strictEqual(r.status, 0, r.stderr);
    const row = lastRow(dir);
    assert.strictEqual(row.tier, 'foundation');
    assert.strictEqual(row.importance, 1, '--importance must override the tier default');
  });

  it('accepts the boundary values 0 and 5', () => {
    const dir = project();
    let r = logEntry(dir, ['edge low', '--tier', 'detail', '--cat', 'quality', '--importance', '0']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(lastRow(dir).importance, 0);

    r = logEntry(dir, ['edge high', '--tier', 'detail', '--cat', 'quality', '--importance', '5']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(lastRow(dir).importance, 5);
  });
});

describe('log --importance validation (the non-numeric / out-of-range branch)', () => {
  it('errors (exit 1) on a non-numeric --importance and writes nothing', () => {
    const dir = project();
    const r = logEntry(dir, ['bogus importance', '--tier', 'detail', '--cat', 'quality', '--importance', 'high']);
    assert.strictEqual(r.status, 1, 'non-numeric --importance must exit 1');
    assert.match(r.stderr, /--importance expects a number 0\.\.5/);
    // Nothing was inserted. The guard fires BEFORE openDb, so db.sqlite may not
    // even exist (that already proves no write); if it does, it must hold 0 rows.
    const dbPath = path.join(dir, '.pebbl', 'db.sqlite');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const n = db.prepare('SELECT COUNT(*) AS c FROM logs').get().c;
      db.close();
      assert.strictEqual(n, 0, 'a rejected --importance must not write a row');
    }
  });

  it('errors (exit 1) on an out-of-range --importance (> 5)', () => {
    const dir = project();
    const r = logEntry(dir, ['too big', '--tier', 'detail', '--cat', 'quality', '--importance', '9']);
    assert.strictEqual(r.status, 1, 'out-of-range --importance must exit 1');
    assert.match(r.stderr, /--importance expects a number 0\.\.5/);
  });
});
