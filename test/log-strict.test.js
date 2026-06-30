'use strict';
// Write-time atomicity enforcement — `pebbl log --strict`.
//
// A non-atomic ("multi-topic") entry crams several facts into one `pebbl log`.
// The detection lives in rubric.atomicityOf (the SAME predicate `pebbl doctor`
// reports on). This suite drives the REAL CLI (bin/pebbl.js) so the assertions
// exercise the whole write path and prove the store does NOT grow on a --strict
// refusal — not just that an advisory printed.
//
// Behavior under test:
//   - NON-ATOMIC + --strict        : exit 1, store unchanged (nothing written).
//   - NON-ATOMIC + no --strict      : exit 0, STORED (lossless) + `pebbl-lint:`
//                                     advisory on stderr.
//   - ATOMIC + --strict             : exit 0, stored normally (no advisory).
//   - [session] multi-topic + strict: exit 0, STILL stored (session/fleeting is
//                                     scoped out — loom's session logging is safe).
//   - primary swap is behavior-preserving on the default rubric (category+tier).
//   - the secret guard fires BEFORE the atomicity check (secret blocked either way).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { ensureProjectFiles, loadRubric, classifyEntry, classifyEntryMulti } = require('../src/rubric');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// A bare .pebbl dir — `pebbl log` builds the schema + default rubric on first
// run. No git remote => visibility 'unknown' => events go to the shared
// events.jsonl, which is the file we assert does/doesn't grow.
function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-strict-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.pebbl'));
  return d;
}

function run(dir, args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// Snapshot the two canonical stores so a refusal can be proven to leave them
// unchanged (db rows + events.jsonl lines). Missing file => 0.
function storeState(dir) {
  const dbPath = path.join(dir, '.pebbl', 'db.sqlite');
  let rows = 0;
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try { rows = db.prepare('SELECT COUNT(*) AS c FROM logs').get().c; } catch { rows = 0; }
    db.close();
  }
  const evPath = path.join(dir, '.pebbl', 'events.jsonl');
  const evLines = fs.existsSync(evPath)
    ? fs.readFileSync(evPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return { rows, evLines };
}

function lastCategory(dir) {
  const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT category, tier FROM logs ORDER BY id DESC LIMIT 1').get();
  } finally {
    db.close();
  }
}

// Trips decision + structure + data on the default rubric → 3 categories.
const NON_ATOMIC_MSG = 'chose to refactor the auth module and migrate the schema to a new table';
// One fact → one category (decision).
const ATOMIC_MSG = 'chose SQLite over Postgres';
// Session summary that ALSO trips content rules; must be scoped out (atomic).
const SESSION_MSG = '[session] chose to refactor the module and migrate the schema and wire the api';
// Non-atomic AND carries an unmarked token-shape (ghp_ + 24 chars). // allowlist-secret
const SECRET_NON_ATOMIC_MSG = 'chose to refactor the module and migrate the schema with key ghp_AAAAAAAAAAAAAAAAAAAAAAAA'; // allowlist-secret

describe('pebbl log --strict — non-atomic enforcement', () => {
  it('REFUSES a non-atomic entry with exit 1 and writes NOTHING to the store', () => {
    const dir = project();
    // Seed one clean atomic entry so there IS a store to leave unchanged.
    const seed = run(dir, ['log', ATOMIC_MSG, '--cat', 'decision']);
    assert.strictEqual(seed.status, 0, seed.stderr);
    const before = storeState(dir);
    assert.ok(before.rows >= 1, 'seed entry should exist');

    const r = run(dir, ['log', NON_ATOMIC_MSG, '--strict']);
    assert.strictEqual(r.status, 1, 'a --strict non-atomic log must exit non-zero');
    assert.match(r.stderr, /pebbl-lint: non-atomic entry \(3 categories: decision,structure,data\)/);
    assert.match(r.stderr, /split into separate atomic/);

    const after = storeState(dir);
    assert.deepStrictEqual(after, before, 'a refused log must leave db rows + events.jsonl lines unchanged');
  });

  it('the SAME non-atomic message WITHOUT --strict is STORED (lossless) + prints the advisory, exit 0', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', NON_ATOMIC_MSG]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /pebbl-lint: non-atomic entry \(3 categories: decision,structure,data\) — prefer one fact per log/);
    const after = storeState(dir);
    assert.ok(after.rows > before.rows, 'default mode must still persist the entry (no data loss)');
    assert.ok(after.evLines > before.evLines, 'default mode must reach events.jsonl');
  });

  it('an ATOMIC entry with --strict stores normally and exits 0 (no advisory)', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', ATOMIC_MSG, '--strict']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /pebbl-lint/, 'an atomic entry must not trip the lint');
    assert.ok(storeState(dir).rows > before.rows, 'an atomic --strict entry must persist');
  });

  it('a [session] multi-topic entry with --strict is STILL stored (session is scoped out)', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', SESSION_MSG, '--strict']);
    assert.strictEqual(r.status, 0, '--strict must never refuse a session log: ' + r.stderr);
    assert.doesNotMatch(r.stderr, /pebbl-lint/, 'a session log must not be flagged non-atomic');
    const after = storeState(dir);
    assert.ok(after.rows > before.rows, 'the session entry must persist under --strict');
  });
});

describe('pebbl log — primary swap is behavior-preserving on the default rubric', () => {
  it('classifyEntryMulti.category/tier == classifyEntry.category/tier for representative messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-swap-'));
    try {
      ensureProjectFiles(dir);
      const rules = loadRubric(dir);
      const messages = [
        'chose SQLite over Postgres',                                   // decision (single)
        'refactored the auth module boundary',                          // structure (single)
        'added a column to the users table',                            // data (single)
        'documented the API endpoint contract',                        // integration (single)
        'parked: failed adversarial review on the ranker',             // steering (single)
        'chose to refactor the module and change the schema',          // multi-match
        'chose threshold 0.5 for the config',                          // decision dual-rule
      ];
      for (const m of messages) {
        const single = classifyEntry(rules, m);
        const multi = classifyEntryMulti(rules, m);
        assert.ok(single && multi, `both classifiers match "${m}"`);
        assert.strictEqual(multi.category, single.category, `stored category must match first-match for "${m}"`);
        assert.strictEqual(multi.tier, single.tier, `stored tier must match first-match for "${m}"`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end: a stored atomic entry keeps the first-match category', () => {
    const dir = project();
    const r = run(dir, ['log', ATOMIC_MSG]); // no --cat: let the rubric classify
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(lastCategory(dir).category, 'decision', 'primary swap stores the same category as before');
  });
});

describe('pebbl log — secret guard fires BEFORE the atomicity check', () => {
  it('a non-atomic message carrying a secret is BLOCKED regardless of --strict', () => {
    for (const extra of [[], ['--strict']]) {
      const dir = project();
      const before = storeState(dir);
      const r = run(dir, ['log', SECRET_NON_ATOMIC_MSG, ...extra]);
      assert.strictEqual(r.status, 1, `secret must block (extra=${JSON.stringify(extra)}): ${r.stderr}`);
      assert.match(r.stderr, /BLOCKED/, 'the secret guard message, not the lint, must win');
      assert.doesNotMatch(r.stderr, /pebbl-lint/, 'the atomicity check must not run after a secret block');
      assert.deepStrictEqual(storeState(dir), before, 'a secret block writes nothing');
    }
  });
});
