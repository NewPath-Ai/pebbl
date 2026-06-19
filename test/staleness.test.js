'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
// P4 — lazy staleness on the read path: a pure append to events.jsonl is folded
// into the view on the next read with NO manual rebuild (tail), a changed prefix
// forces a full replay (full), an unchanged store does zero fold work (fresh).
// The decision (compareState) is asserted directly so the tail-vs-full split is
// pinned without any timing, and the end-to-end fold-on-read is asserted against
// the real view.sqlite the read path consumes.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
const {
  compareState,
  currentState,
  readWatermark,
  ensureFresh,
  prefixFingerprint,
} = require('../src/staleness');
const { openDb } = require('../src/db');
const { makeAppendEvent, appendEvent } = require('../src/events');

function fp(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// A real git repo + initialized .pebbl store, so the read path (openDb) and the
// append helpers behave exactly as in production.
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-stale-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('node', [PEBBL_BIN, 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function pebbl(dir, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function viewLogCount(pebblDir) {
  const db = new Database(path.join(pebblDir, 'view.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT count(*) c FROM logs').get().c;
  } finally {
    db.close();
  }
}

describe('P4 staleness: compareState decision table', () => {
  it('returns "none" when there is no log state', () => {
    assert.equal(compareState({ eid: 'A', offset: 10, fp: fp('x') }, null), 'none');
  });

  it('returns "full" on the first fold (no watermark yet)', () => {
    assert.equal(compareState(null, { eid: 'A', offset: 10, fp: fp('x') }), 'full');
  });

  it('returns "fresh" when offset and fingerprint match (no fold needed)', () => {
    const wm = { eid: 'A', offset: 100, fp: fp('abc') };
    assert.equal(compareState(wm, { eid: 'A', offset: 100, fp: fp('abc') }), 'fresh');
  });

  it('returns "full" when the same-size file has different bytes (in-place rewrite)', () => {
    const wm = { eid: 'A', offset: 100, fp: fp('abc') };
    assert.equal(compareState(wm, { eid: 'A', offset: 100, fp: fp('XYZ') }), 'full');
  });

  it('returns "tail" on pure append (grew, prefix [0,offset) unchanged)', () => {
    const wm = { eid: 'A', offset: 100, fp: fp('prefix') };
    const state = { eid: 'B', offset: 160, fp: fp('whole'), prefixFp: fp('prefix') };
    assert.equal(compareState(wm, state), 'tail');
  });

  it('returns "full" when the file grew but an earlier line changed (prefix differs)', () => {
    const wm = { eid: 'A', offset: 100, fp: fp('prefix') };
    const state = { eid: 'B', offset: 160, fp: fp('whole'), prefixFp: fp('DIFFERENT') };
    assert.equal(compareState(wm, state), 'full');
  });

  it('returns "full" when the file shrank below the watermark (truncated/rewritten)', () => {
    const wm = { eid: 'A', offset: 200, fp: fp('x') };
    assert.equal(compareState(wm, { eid: 'A', offset: 100, fp: fp('y') }), 'full');
  });
});

describe('P4 staleness: prefixFingerprint reads only the prefix', () => {
  it('distinguishes a pure append (prefix identical) from a changed prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-fp-'));
    const f = path.join(dir, 'events.jsonl');
    fs.writeFileSync(f, 'line-a\nline-b\n');
    const prefixLen = fs.statSync(f).size;
    const before = prefixFingerprint(f, prefixLen);
    // pure append: prefix [0, prefixLen) unchanged
    fs.appendFileSync(f, 'line-c\n');
    assert.equal(prefixFingerprint(f, prefixLen), before, 'prefix fp must be stable across a pure append');
    // changed prefix: rewrite an earlier byte
    fs.writeFileSync(f, 'LINE-a\nline-b\nline-c\n');
    assert.notEqual(prefixFingerprint(f, prefixLen), before, 'prefix fp must change when an earlier line changes');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('P4 staleness: lazy fold on the read path (no manual rebuild)', () => {
  it('surfaces a pure-append event in view.sqlite on the next read, via "tail"', () => {
    const repo = makeStore();
    const pebblDir = path.join(repo, '.pebbl');
    try {
      pebbl(repo, ['log', 'first entry because alpha', '--cat', 'decision', '--topic', 'alpha']);
      assert.equal(viewLogCount(pebblDir), 1, 'view has the logged entry');

      // Hand-append a raw append event straight to events.jsonl (simulates a
      // merge/checkout pulling a new line) — the view is now behind.
      const ev = makeAppendEvent(pebblDir, {
        ts: new Date().toISOString(),
        category: 'decision',
        tier: 'component',
        message: 'pulled entry because beta',
        topics: 'beta',
      });
      appendEvent(pebblDir, ev);

      // The cheap check should classify this as a pure append (tail).
      const file = path.join(pebblDir, 'events.jsonl');
      const wm = readWatermark(pebblDir);
      const state = currentState(pebblDir);
      state.prefixFp = prefixFingerprint(file, wm.offset);
      assert.equal(compareState(wm, state), 'tail', 'a pure append is a tail fold');

      // Reading through the real path (openDb) lazily folds it in — no rebuild.
      openDb(pebblDir).close();
      assert.equal(viewLogCount(pebblDir), 2, 'the pulled entry surfaces with no manual rebuild');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('triggers a full replay when an earlier line in events.jsonl changes', () => {
    const repo = makeStore();
    const pebblDir = path.join(repo, '.pebbl');
    try {
      pebbl(repo, ['log', 'one because a', '--cat', 'decision', '--topic', 'a']);
      pebbl(repo, ['log', 'two because b', '--cat', 'decision', '--topic', 'b']);
      const file = path.join(pebblDir, 'events.jsonl');
      const wmBefore = readWatermark(pebblDir);

      // Rewrite the WHOLE file with the first line's message changed — a changed
      // prefix, which must force a full replay, not a tail fold.
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const first = JSON.parse(lines[0]);
      first.message = 'one CHANGED because a';
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(file, lines.join('\n') + '\n');

      const state = currentState(pebblDir);
      // same size is not guaranteed; classify against the rewritten file
      if (state.offset > wmBefore.offset) {
        state.prefixFp = prefixFingerprint(file, wmBefore.offset);
      }
      assert.equal(compareState(wmBefore, state), 'full', 'a changed prefix is a full replay');

      const mode = ensureFresh(pebblDir);
      assert.equal(mode, 'full');
      const db = new Database(path.join(pebblDir, 'view.sqlite'), { readonly: true });
      const msgs = db.prepare('SELECT message FROM logs ORDER BY id').all().map((r) => r.message);
      db.close();
      assert.ok(msgs.includes('one CHANGED because a'), 'full replay picked up the changed line');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('takes the fast "fresh" path (no fold) when nothing changed', () => {
    const repo = makeStore();
    const pebblDir = path.join(repo, '.pebbl');
    try {
      pebbl(repo, ['log', 'only because x', '--cat', 'decision', '--topic', 'x']);
      // After a log the watermark is stamped; an immediate ensureFresh is a no-op.
      const mode = ensureFresh(pebblDir);
      assert.equal(mode, 'fresh', 'an unchanged store does zero fold work');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
