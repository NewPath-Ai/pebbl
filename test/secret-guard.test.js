'use strict';
// Write-time secret BLOCK — the root fix. The redaction filter only masks the
// committed .md PROJECTION; the canonical store (db.sqlite + events.jsonl) keeps
// the original text verbatim, so a logged secret is persisted RAW and rides the
// shared side-rail. This guard runs BEFORE the store is touched, so an unmarked
// secret-shape (token class) can never enter it.
//
// We drive the REAL CLI (bin/pebbl.js) so the assertions exercise the whole
// write path, and prove the store does NOT grow on a block — not just that the
// .md is masked. The DB row count AND the events.jsonl line count are checked.
//
// Coverage:
//   - an unmarked token-shape `pebbl log` is REFUSED (exit 1) + store unchanged
//   - a line carrying `allowlist-secret` IS written
//   - PEBBL_SECRET_GUARD=warn warns on stderr + still writes
//   - PEBBL_SECRET_GUARD=off is silent + writes
//   - clean text writes silently (no guard output)
//   - a handoff field with an unmarked token-shape is REFUSED + store unchanged
//   - guardMode()/findUnmarkedTokens() unit behavior (mode default, marker)

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { guardMode, findUnmarkedTokens, ALLOWLIST_MARKER } = require('../src/secret-guard');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// A bare .pebbl dir — `pebbl log` builds the schema on first run (same setup the
// log-importance test uses). No git remote => visibility 'unknown' => events go
// to the shared events.jsonl, which is exactly the file we assert does not grow.
function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-secguard-'));
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

// Snapshot the two canonical stores so a block can be proven to leave them
// byte-for-byte unchanged (the store does NOT grow). Missing file => 0.
function storeState(dir) {
  const dbPath = path.join(dir, '.pebbl', 'db.sqlite');
  let rows = 0;
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      rows = db.prepare('SELECT COUNT(*) AS c FROM logs').get().c;
    } catch { rows = 0; } // table may not exist yet
    try {
      rows += db.prepare('SELECT COUNT(*) AS c FROM handoffs').get().c;
    } catch { /* handoffs table may not exist */ }
    db.close();
  }
  const evPath = path.join(dir, '.pebbl', 'events.jsonl');
  const evLines = fs.existsSync(evPath)
    ? fs.readFileSync(evPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return { rows, evLines };
}

// A token-shape that scan() flags as the `token` class but is an obvious fake.
const FAKE_TOKEN_MSG = 'the deploy key is ghp_AAAAAAAAAAAAAAAAAAAAAAAA somewhere'; // allowlist-secret
const CLEAN_MSG = 'the project uses sqlite because it keeps the store in-tree';

describe('pebbl log — write-time secret BLOCK (default)', () => {
  it('REFUSES an unmarked token-shape with exit 1 and writes NOTHING to the store', () => {
    const dir = project();
    // Prime the store with one clean entry so there IS a store to leave unchanged.
    const seed = run(dir, ['log', CLEAN_MSG, '--cat', 'decision']);
    assert.strictEqual(seed.status, 0, seed.stderr);
    const before = storeState(dir);
    assert.ok(before.rows >= 1, 'seed entry should exist');

    const r = run(dir, ['log', FAKE_TOKEN_MSG, '--cat', 'data']);
    assert.strictEqual(r.status, 1, 'a blocked log must exit non-zero');
    assert.match(r.stderr, /BLOCKED/);
    assert.match(r.stderr, /allowlist-secret/);

    // The store did NOT grow — nothing was persisted, not just masked.
    const after = storeState(dir);
    assert.deepStrictEqual(after, before, 'a blocked log must leave db rows + events.jsonl lines unchanged');
  });

  it('block also fires on the very first write (no store yet) and creates nothing', () => {
    const dir = project();
    const r = run(dir, ['log', 'api_key=AAAAAAAAAAAAAAAAAAAAAAAA', '--cat', 'data']); // allowlist-secret
    assert.strictEqual(r.status, 1);
    // db.sqlite / events.jsonl must not have been created by a refused write.
    assert.strictEqual(storeState(dir).rows, 0);
    assert.strictEqual(storeState(dir).evLines, 0);
  });
});

describe('pebbl log — escape hatches', () => {
  it('a line carrying `allowlist-secret` IS written', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', `${FAKE_TOKEN_MSG} allowlist-secret: fake fixture`, '--cat', 'data']);
    assert.strictEqual(r.status, 0, r.stderr);
    const after = storeState(dir);
    assert.ok(after.rows > before.rows, 'an allowlist-secret line must be persisted');
    assert.ok(after.evLines > before.evLines, 'an allowlist-secret line must reach events.jsonl');
  });

  it('PEBBL_SECRET_GUARD=warn warns on stderr AND still writes', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', FAKE_TOKEN_MSG, '--cat', 'data'], { PEBBL_SECRET_GUARD: 'warn' });
    assert.strictEqual(r.status, 0, 'warn mode must still succeed');
    assert.match(r.stderr, /BLOCKED|writing anyway/);
    const after = storeState(dir);
    assert.ok(after.rows > before.rows, 'warn mode must still persist the entry');
  });

  it('PEBBL_SECRET_GUARD=off is silent and writes', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['log', FAKE_TOKEN_MSG, '--cat', 'data'], { PEBBL_SECRET_GUARD: 'off' });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /BLOCKED/, 'off mode must not print the guard message');
    assert.ok(storeState(dir).rows > before.rows, 'off mode must persist the entry');
  });

  it('clean text writes silently (no guard output)', () => {
    const dir = project();
    const r = run(dir, ['log', CLEAN_MSG, '--cat', 'decision']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /BLOCKED/);
    assert.ok(storeState(dir).rows >= 1);
  });
});

describe('pebbl handoff — write-time secret BLOCK', () => {
  it('REFUSES an unmarked token-shape in a field with exit 1 and store unchanged', () => {
    const dir = project();
    // Seed with one clean handoff so the store is non-empty.
    const seed = run(dir, ['handoff', 'clean session summary', '--done', 'shipped the parser']);
    assert.strictEqual(seed.status, 0, seed.stderr);
    const before = storeState(dir);
    assert.ok(before.rows >= 1, 'seed handoff should exist');

    const r = run(dir, ['handoff', 'wired the deploy', '--done', FAKE_TOKEN_MSG]);
    assert.strictEqual(r.status, 1, 'a blocked handoff must exit non-zero');
    assert.match(r.stderr, /BLOCKED/);
    assert.match(r.stderr, /\[done\]/, 'the offending field is named');

    assert.deepStrictEqual(storeState(dir), before, 'a blocked handoff must leave the store unchanged');
  });

  it('an allowlist-secret handoff field IS written', () => {
    const dir = project();
    const before = storeState(dir);
    const r = run(dir, ['handoff', 'fixture note', '--done', `${FAKE_TOKEN_MSG} allowlist-secret`]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(storeState(dir).rows > before.rows, 'allowlisted handoff must persist');
  });
});

describe('secret-guard unit', () => {
  it('guardMode() defaults to block when unset / unrecognized', () => {
    const saved = process.env.PEBBL_SECRET_GUARD;
    try {
      delete process.env.PEBBL_SECRET_GUARD;
      assert.strictEqual(guardMode(), 'block');
      process.env.PEBBL_SECRET_GUARD = 'nonsense';
      assert.strictEqual(guardMode(), 'block');
      process.env.PEBBL_SECRET_GUARD = 'warn';
      assert.strictEqual(guardMode(), 'warn');
      process.env.PEBBL_SECRET_GUARD = 'OFF';
      assert.strictEqual(guardMode(), 'off', 'mode is case-insensitive');
    } finally {
      if (saved === undefined) delete process.env.PEBBL_SECRET_GUARD;
      else process.env.PEBBL_SECRET_GUARD = saved;
    }
  });

  it('findUnmarkedTokens flags only the token class and honors the marker per-line', () => {
    const fields = [
      { name: 'message', value: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAA' }, // allowlist-secret
      { name: 'note', value: `ghp_BBBBBBBBBBBBBBBBBBBBBBBB ${ALLOWLIST_MARKER}` }, // allowlist-secret
      { name: 'ip', value: 'connects to 8.8.8.8' }, // network class — NOT blocked
    ];
    const found = findUnmarkedTokens(fields);
    assert.strictEqual(found.length, 1, 'only the unmarked token field is flagged');
    assert.strictEqual(found[0].field, 'message');
    assert.strictEqual(found[0].hit.class, 'token');
  });

  it('the marker only exempts its own line, not a sibling line in the field', () => {
    const fields = [{
      name: 'message',
      value: `ghp_AAAAAAAAAAAAAAAAAAAAAAAA\nfixture ghp_BBBBBBBBBBBBBBBBBBBBBBBB ${ALLOWLIST_MARKER}`, // allowlist-secret
    }];
    const found = findUnmarkedTokens(fields);
    assert.strictEqual(found.length, 1, 'the unmarked line is still caught');
  });
});
