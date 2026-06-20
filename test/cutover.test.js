'use strict';
// P6 — `pebbl cutover`: read-only inventory + the rollout runbook.
// Asserts: classification (legacy / events / md-only), inventory is genuinely
// NON-DESTRUCTIVE, the runbook encodes the wave/soak/Q4=B-mirror/retirement
// policy + the wave-0 --shared pre-flight gap, and the CLI surfaces work.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cutover = require('../src/cutover');
const { classifyStore, findStores, inventory, RUNBOOK } = cutover;
const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-cutover-'));
}
function mkStore(root, rel, files) {
  const pebblDir = path.join(root, rel, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(pebblDir, name), body);
  }
  return pebblDir;
}

describe('cutover — classifyStore (legacy / events / md-only)', () => {
  it('labels a store with db.sqlite (no events.jsonl) as legacy', () => {
    const root = tmpRoot();
    try {
      const p = mkStore(root, 'a', { 'db.sqlite': 'x' });
      assert.equal(classifyStore(p), 'legacy');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('labels a store with events.jsonl as events (even if legacy-db.sqlite also present)', () => {
    const root = tmpRoot();
    try {
      const p = mkStore(root, 'b', { 'events.jsonl': '{}\n', 'legacy-db.sqlite': 'x' });
      assert.equal(classifyStore(p), 'events');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('labels legacy-db.sqlite (migrator rollback artifact) without events.jsonl as legacy', () => {
    const root = tmpRoot();
    try {
      const p = mkStore(root, 'c', { 'legacy-db.sqlite': 'x' });
      assert.equal(classifyStore(p), 'legacy');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('labels a store with only markdown (no db, no events) as md-only (lumr case)', () => {
    const root = tmpRoot();
    try {
      const p = mkStore(root, 'lumr', { 'handoffs.md': '# handoffs\n' });
      assert.equal(classifyStore(p), 'md-only');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('cutover — findStores / inventory discovery', () => {
  it('finds nested .pebbl stores and skips node_modules/.git/mirror', () => {
    const root = tmpRoot();
    try {
      mkStore(root, 'svcA', { 'db.sqlite': 'x' });
      mkStore(root, 'nested/svcB', { 'events.jsonl': '{}\n' });
      // a .pebbl buried under node_modules / mirror must NOT be discovered
      mkStore(root, 'node_modules/pkg', { 'db.sqlite': 'x' });
      mkStore(root, 'svcA/.pebbl/mirror/otherMachine', { 'db.sqlite': 'x' });

      const stores = findStores(root);
      const rels = stores.map((p) => path.relative(root, p)).sort();
      assert.deepEqual(rels, ['nested/svcB/.pebbl', 'svcA/.pebbl']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('inventory returns one labeled row per store', () => {
    const root = tmpRoot();
    try {
      mkStore(root, 'leg', { 'db.sqlite': 'x' });
      // 'events' label needs a genuine completeness signal now that storeMode()
      // is a completeness predicate, not bare events.jsonl presence: a bare
      // gitignored/unrooted events.jsonl is the P0 tracer (PARTIAL) and reads
      // canonical db.sqlite. legacy-db.sqlite (the migrator's rename) is the
      // strongest signal an events store actually completed migration.
      mkStore(root, 'ev', { 'events.jsonl': '{}\n', 'legacy-db.sqlite': 'x' });
      mkStore(root, 'md', { 'manual-logs.md': '# logs\n' });
      const rows = inventory(root);
      const byMode = Object.fromEntries(rows.map((r) => [path.basename(path.dirname(r.pebblDir)), r.mode]));
      assert.equal(byMode.leg, 'legacy');
      assert.equal(byMode.ev, 'events');
      assert.equal(byMode.md, 'md-only');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('cutover --inventory is NON-DESTRUCTIVE (Acceptance #4)', () => {
  it('scans a real legacy store via the CLI and mutates NOTHING', () => {
    const root = tmpRoot();
    try {
      const pebblDir = mkStore(root, 'real', { 'db.sqlite': 'pretend-binary' });
      const before = fs.readdirSync(pebblDir).sort();
      const dbBytes = fs.readFileSync(path.join(pebblDir, 'db.sqlite'));

      const out = execFileSync('node', [BIN, 'cutover', '--inventory', '--root', root], { encoding: 'utf8' });

      // labels something
      assert.match(out, /legacy|events|md-only/i);
      // created NO events.jsonl, deleted/modified nothing
      assert.ok(!fs.existsSync(path.join(pebblDir, 'events.jsonl')), 'inventory must not create events.jsonl');
      assert.ok(!fs.existsSync(path.join(pebblDir, 'legacy-db.sqlite')), 'inventory must not rename db.sqlite');
      assert.deepEqual(fs.readdirSync(pebblDir).sort(), before, 'inventory must not add/remove files');
      assert.deepEqual(fs.readFileSync(path.join(pebblDir, 'db.sqlite')), dbBytes, 'inventory must not touch db.sqlite');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('inventory of an empty root reports no stores without error', () => {
    const root = tmpRoot();
    try {
      const out = execFileSync('node', [BIN, 'cutover', '--inventory', '--root', root], { encoding: 'utf8' });
      assert.match(out, /no \.pebbl stores/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('cutover --help runbook policy (Acceptance #5/#6)', () => {
  it('the runbook text encodes wave order, soak, mirror, and legacy-db.sqlite retirement', () => {
    // the exact literals the Verify block greps for
    assert.match(RUNBOOK, /legacy-db\.sqlite/);
    assert.match(RUNBOOK, /soak/i);
    assert.match(RUNBOOK, /wave/i);
    assert.match(RUNBOOK, /mirror/i);
    assert.match(RUNBOOK, /inventory/i);
    assert.match(RUNBOOK, /cutover/i);
  });

  it('encodes the wave ORDER: tracer -> sw-factory first real -> the rest', () => {
    const tracerAt = RUNBOOK.toLowerCase().indexOf('tracer');
    const swfAt = RUNBOOK.toLowerCase().indexOf('sw-factory');
    assert.ok(tracerAt !== -1 && swfAt !== -1 && tracerAt < swfAt, 'tracer must precede sw-factory');
    assert.match(RUNBOOK, /lumr/i);
    assert.match(RUNBOOK, /harold/i);
    assert.match(RUNBOOK, /terraform-for-law/i);
    assert.match(RUNBOOK, /~1-week|1-week|one[- ]week/i);
  });

  it('encodes the Q4=B rule: keep BOTH mirror + git, collapse git-only per-store', () => {
    assert.match(RUNBOOK, /both/i);
    assert.match(RUNBOOK, /git-only/i);
    assert.match(RUNBOOK, /per-store/i);
    assert.match(RUNBOOK, /end-state|not a flag day/i);
  });

  it('encodes the retirement policy: legacy-db.sqlite retired only after one stable release, never during a soak', () => {
    assert.match(RUNBOOK, /one stable release/i);
    assert.match(RUNBOOK, /never.*soak|not.*during a soak|NEVER during a soak/i);
  });

  it('encodes the HARD wave-0 pre-flight: the --shared init toggle is NOT yet built', () => {
    assert.match(RUNBOOK, /--shared/);
    assert.match(RUNBOOK, /--allow-public-memory/);
    assert.match(RUNBOOK, /never built|NEVER built|not.*built|gating dependency/i);
    assert.match(RUNBOOK, /DEFAULT = LOCAL|DEFAULT=LOCAL/i);
  });

  it('CLI: `cutover --help` prints the runbook (mentions inventory/wave/soak/cutover)', () => {
    const out = execFileSync('node', [BIN, 'cutover', '--help'], { encoding: 'utf8' });
    assert.match(out, /inventory|wave|soak|cutover/i);
  });

  it('CLI: bare `cutover` (no flag) prints the runbook too', () => {
    const out = execFileSync('node', [BIN, 'cutover'], { encoding: 'utf8' });
    assert.match(out, /runbook/i);
  });
});
