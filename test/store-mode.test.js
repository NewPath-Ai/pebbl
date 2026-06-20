'use strict';
// P6 — the coexistence fork (storeMode). Pure, read-only COMPLETENESS predicate:
// 'events' ONLY when events.jsonl is the complete store (legacy-db.sqlite present,
// or the .events-canonical marker, or events.jsonl is git-tracked); a partial /
// gitignored tracer => 'legacy' (read canonical db.sqlite). No DB open, no
// migration side effect, additive (legacy stores unchanged). The exhaustive
// 5-step + 7-acceptance coverage lives in store-mode-completeness.test.js; this
// file holds the original purity/re-export invariants.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { storeMode, EVENTS_CANONICAL_MARKER, LEGACY_DB } = require('../src/store-mode');
const fromFindPebbl = require('../src/find-pebbl').storeMode;

function tmpPebbl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-storemode-'));
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  return { dir, pebblDir };
}

describe('storeMode — the events.jsonl presence fork', () => {
  it('reports legacy when events.jsonl is absent (Acceptance #1/#2)', () => {
    const { dir, pebblDir } = tmpPebbl();
    try {
      assert.equal(storeMode(pebblDir), 'legacy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports events when events.jsonl is COMPLETE (legacy-db.sqlite present)', () => {
    // Completeness predicate (not bare presence): a migrated store has its
    // db.sqlite renamed to legacy-db.sqlite — that rename is the migrator's
    // idempotency marker and the strongest completeness signal.
    const { dir, pebblDir } = tmpPebbl();
    try {
      fs.writeFileSync(path.join(pebblDir, 'events.jsonl'), '{}\n');
      fs.writeFileSync(path.join(pebblDir, LEGACY_DB), 'renamed-db');
      assert.equal(storeMode(pebblDir), 'events');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports events when the positive .events-canonical marker is present', () => {
    const { dir, pebblDir } = tmpPebbl();
    try {
      fs.writeFileSync(path.join(pebblDir, 'events.jsonl'), '{}\n');
      fs.writeFileSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER), 'canonical\n');
      assert.equal(storeMode(pebblDir), 'events');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is re-exported from find-pebbl so require(".../find-pebbl").storeMode resolves', () => {
    assert.equal(typeof fromFindPebbl, 'function');
    assert.equal(fromFindPebbl, storeMode);
  });

  it('is READ-ONLY: never creates events.jsonl, never opens a db, never writes', () => {
    const { dir, pebblDir } = tmpPebbl();
    try {
      // a legacy store with a db.sqlite present
      fs.writeFileSync(path.join(pebblDir, 'db.sqlite'), 'not-a-real-db');
      const before = fs.readdirSync(pebblDir).sort();
      const dbBytes = fs.readFileSync(path.join(pebblDir, 'db.sqlite'));

      assert.equal(storeMode(pebblDir), 'legacy');
      // calling it many times must not have any side effect
      for (let i = 0; i < 5; i += 1) storeMode(pebblDir);

      const after = fs.readdirSync(pebblDir).sort();
      assert.deepEqual(after, before, 'storeMode must not add/remove any file');
      assert.ok(!fs.existsSync(path.join(pebblDir, 'events.jsonl')), 'must not create events.jsonl');
      assert.deepEqual(fs.readFileSync(path.join(pebblDir, 'db.sqlite')), dbBytes, 'must not touch db.sqlite');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to legacy on a null/undefined dir (no throw)', () => {
    assert.equal(storeMode(null), 'legacy');
    assert.equal(storeMode(undefined), 'legacy');
  });

  it('a bare events.jsonl with NO completeness signal routes to legacy (the tracer fix)', () => {
    // The regression fix: a present-but-partial events.jsonl (the P0 tracer) with
    // no legacy-db.sqlite, no marker, and no git answer (tmp dir is not a repo,
    // so step-4 check-ignore errors -> the SAFE direction) must read the
    // canonical db.sqlite => 'legacy'. Bare presence is no longer enough.
    const { dir, pebblDir } = tmpPebbl();
    try {
      fs.writeFileSync(path.join(pebblDir, 'events.jsonl'), '');
      assert.equal(storeMode(pebblDir), 'legacy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
