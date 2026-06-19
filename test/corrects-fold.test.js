'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
// `pebbl log --corrects N` must HIDE the superseded entry in events/shared mode
// exactly as it does in legacy db.sqlite. The fold (src/fold.js) already stamps
// valid_to on a `correct` event's target; this suite proves the WRITE side now
// emits that event — the gap that left a superseded entry VISIBLE in events-mode
// `context`/`search` when only an `append` (no corrects link) reached the
// envelope. Driven through the real CLI so it exercises the write path
// (src/log.js -> events.appendCorrectLogEvent), not just the reducer.
//
// Acceptance covered (task prompt):
//   1. events-mode correction hides the superseded entry (parity with legacy).
//   2. a correction made in one clone, pulled into another, hides it there too
//      (folds across the union merge of events.jsonl).
//   3. correction chains A<-B<-C fold correctly (latest belief wins, no leak).
//   4. old events.jsonl lines with no corrects field still fold without error.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const { fold, readEvents, makeAppendEvent, appendEvent } = require('../src/events');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-corrects-'));
}
function gitInit(cwd) {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd });
}
// Run the real pebbl CLI. PEBBL_DISABLE_EMBED is inherited from setup.js (the
// process-wide env), so the post-commit hook never shells out to a live embed.
function pebbl(cwd, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
// The events-mode read model the user actually sees: view.sqlite is the fold of
// events.jsonl (openReadDb reads it readonly in events mode). The current-belief
// filter is `valid_to IS NULL`, so a correctly-folded supersession is hidden
// here exactly as `pebbl context`/`search` hide it.
function liveMessages(pebblDir) {
  const db = new Database(path.join(pebblDir, 'view.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT message FROM logs WHERE valid_to IS NULL ORDER BY id').all().map((r) => r.message);
  } finally {
    db.close();
  }
}
// The legacy canonical store, for the parity assertion. Same predicate.
function legacyLiveMessages(pebblDir) {
  const db = new Database(path.join(pebblDir, 'db.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT message FROM logs WHERE valid_to IS NULL ORDER BY id').all().map((r) => r.message);
  } finally {
    db.close();
  }
}

describe('corrects-fold: events-mode correction hides the superseded entry', () => {
  it('A then --corrects A: the fold view shows only B, byte-parity with the legacy db (Acceptance 1 + 5)', () => {
    const repo = tmpDir();
    gitInit(repo);
    pebbl(repo, ['init', '--shared']);
    pebbl(repo, ['log', 'old belief: use Redis because it is fast', '--cat', 'decision', '--topic', 'db']);
    pebbl(repo, ['log', '--corrects', '1', 'new belief: use Postgres because we need real transactions', '--cat', 'decision', '--topic', 'db']);

    const pebblDir = path.join(repo, '.pebbl');

    // The events envelope now carries a `correct` event linking to the FIRST
    // entry's EID (never a local int — the on-the-wire identity is the eid).
    const evs = readEvents(pebblDir);
    const correct = evs.find((e) => e.type === 'correct');
    assert.ok(correct, 'a correct event must be appended for --corrects');
    assert.equal(typeof correct.corrects, 'string', 'corrects target is an EID (string), never a local int');
    assert.match(correct.corrects, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'corrects is a 26-char ULID');
    const appendEv = evs.find((e) => e.type === 'append' && /use Redis/.test(e.message));
    assert.equal(correct.corrects, appendEv.eid, 'correct points at the appended entry it supersedes');

    // The fold/view hides the superseded entry.
    const live = liveMessages(pebblDir);
    assert.ok(live.some((m) => /use Postgres/.test(m)), 'new belief is live');
    assert.ok(!live.some((m) => /use Redis/.test(m)), 'superseded belief HIDDEN in the events-mode view');

    // Parity: the same predicate on the legacy db.sqlite yields the same live set
    // (Acceptance 5 — legacy behavior byte-identical; events mode just matches it).
    assert.deepEqual(live, legacyLiveMessages(pebblDir), 'events-mode live set == legacy live set');
  });
});

describe('corrects-fold: a correction folds across a two-clone union merge (Acceptance 2)', () => {
  it('clone-1 corrects, clone-2 pulls events.jsonl: superseded entry hides in clone-2', () => {
    // Origin: a shared store with one base belief, committed.
    const origin = tmpDir();
    gitInit(origin);
    pebbl(origin, ['init', '--shared']);
    pebbl(origin, ['log', 'old belief: deploy on Fridays', '--cat', 'decision', '--topic', 'ops']);
    execFileSync('git', ['add', '-A'], { cwd: origin });
    execFileSync('git', ['commit', '-q', '-m', 'base belief'], { cwd: origin });

    // Two clones off the same base (file:// clone keeps it self-contained).
    const clone1 = tmpDir();
    const clone2 = tmpDir();
    execFileSync('git', ['clone', '-q', origin, clone1]);
    execFileSync('git', ['clone', '-q', origin, clone2]);
    for (const c of [clone1, clone2]) {
      execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: c });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: c });
    }

    // clone-1: correct the base belief. The local int is 1 in clone-1's own fold;
    // the emitted correct event carries the base entry's EID (machine-independent),
    // which is exactly what lets clone-2 resolve it after a pull.
    pebbl(clone1, ['log', '--corrects', '1', 'new belief: deploy any day with a clean pipeline', '--cat', 'decision', '--topic', 'ops']);
    // sanity: hidden in clone-1 too
    assert.ok(!liveMessages(path.join(clone1, '.pebbl')).some((m) => /Fridays/.test(m)), 'superseded hidden in clone-1');
    execFileSync('git', ['add', '-A'], { cwd: clone1 });
    execFileSync('git', ['commit', '-q', '-m', 'correct the belief'], { cwd: clone1 });

    // Transport clone-1's commit straight to clone-2 (pull clone1 as a remote).
    // A push to `origin` would be refused — origin is a non-bare checkout with
    // main checked out — and that git detail is irrelevant to what we're proving:
    // that clone-2 folds clone-1's correction event after a git merge of
    // events.jsonl (the union driver from `init --shared` handles the file).
    execFileSync('git', ['remote', 'add', 'clone1', clone1], { cwd: clone2 });
    const merge = execFileSync('git', ['pull', '-q', '--no-edit', 'clone1', 'main'], { cwd: clone2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    void merge;

    // clone-2 had only the base belief; after pulling the correction event, its
    // fold must hide the superseded entry exactly as clone-1 does.
    const merged = fs.readFileSync(path.join(clone2, '.pebbl', 'events.jsonl'), 'utf8');
    assert.ok(!/^<<<<<<<|^=======|^>>>>>>>/m.test(merged), 'no conflict markers after the events.jsonl merge');
    for (const line of merged.split('\n').filter((l) => l.trim())) {
      assert.doesNotThrow(() => JSON.parse(line), `invalid JSON line after merge: ${line}`);
    }
    // Force a fresh fold in clone-2 (rebuild reads events.jsonl -> view.sqlite).
    pebbl(clone2, ['rebuild']);
    const live2 = liveMessages(path.join(clone2, '.pebbl'));
    assert.ok(live2.some((m) => /clean pipeline/.test(m)), 'pulled new belief is live in clone-2');
    assert.ok(!live2.some((m) => /Fridays/.test(m)), 'pulled correction hides the superseded entry in clone-2');
  });
});

describe('corrects-fold: correction chains fold correctly (Acceptance 3)', () => {
  it('A <- B <- C through the CLI: only C is live; A and B are stamped, no leak', () => {
    const repo = tmpDir();
    gitInit(repo);
    pebbl(repo, ['init', '--shared']);
    pebbl(repo, ['log', 'A: cache in process memory', '--cat', 'decision', '--topic', 'cache']);
    // Each --corrects targets the CURRENT live head's local int (1, then 2),
    // matching how a user reads the id off `context` between corrections.
    pebbl(repo, ['log', '--corrects', '1', 'B: cache in Redis', '--cat', 'decision', '--topic', 'cache']);
    pebbl(repo, ['log', '--corrects', '2', 'C: cache in Memcached', '--cat', 'decision', '--topic', 'cache']);

    const pebblDir = path.join(repo, '.pebbl');
    const live = liveMessages(pebblDir);
    assert.deepEqual(live, ['C: cache in Memcached'], 'only the latest belief in the chain is live');

    // Bitemporal: A and B still EXIST (timeline preserved) but are stamped, and
    // A keeps its ORIGINAL stamp (the double-correct guard — A is not re-stamped
    // when C supersedes B). Assert via the full fold, which keeps stamped rows.
    const all = fold(readEvents(pebblDir));
    const a = all.find((r) => /^A:/.test(r.message));
    const b = all.find((r) => /^B:/.test(r.message));
    const c = all.find((r) => /^C:/.test(r.message));
    assert.ok(a && a.valid_to != null, 'A is stamped superseded');
    assert.ok(b && b.valid_to != null, 'B is stamped superseded');
    assert.equal(c.valid_to, null, 'C is the single live head');
    assert.equal(a.invalidated_by, b.id, 'A attributed to B (its original successor), not C');
    assert.equal(b.invalidated_by, c.id, 'B attributed to C');

    // Parity with legacy on the full chain.
    assert.deepEqual(live, legacyLiveMessages(pebblDir), 'chain live set matches legacy');
  });
});

describe('corrects-fold: backward compatibility — old envelopes with no corrects field (Acceptance 4)', () => {
  it('a plain append event (no corrects field) still folds without error', () => {
    // An events.jsonl written before this change carries only `append` events
    // with NO corrects field. The fold must consume them unchanged.
    const repo = tmpDir();
    gitInit(repo);
    pebbl(repo, ['init', '--shared']);
    const pebblDir = path.join(repo, '.pebbl');

    // Hand-append a legacy-shaped append event (makeAppendEvent never writes a
    // corrects field, so this is exactly the pre-change on-disk shape).
    appendEvent(pebblDir, makeAppendEvent(pebblDir, {
      ts: '2026-01-01T00:00:00.000Z',
      message: 'legacy entry with no corrects field',
      category: 'data',
      tier: 'detail',
    }));

    const evs = readEvents(pebblDir);
    const legacy = evs.find((e) => /legacy entry/.test(e.message));
    assert.ok(legacy, 'legacy append present');
    assert.equal(legacy.corrects, undefined, 'legacy append carries NO corrects field');

    let rows;
    assert.doesNotThrow(() => { rows = fold(evs); }, 'fold must not throw on an envelope without a corrects field');
    assert.ok(rows.some((r) => /legacy entry/.test(r.message)), 'legacy entry survives the fold');
  });

  it('a correct event whose target eid is absent folds to a no-op stamp, no throw', () => {
    // Defensive: a correct event pointing at an eid that is not in the log (a
    // dangling ref, e.g. a torn history) must not crash the fold — it simply
    // stamps nothing, and the correcting entry itself stays live.
    const repo = tmpDir();
    gitInit(repo);
    pebbl(repo, ['init', '--shared']);
    const pebblDir = path.join(repo, '.pebbl');

    const { makeCorrectEvent } = require('../src/events');
    appendEvent(pebblDir, makeCorrectEvent(pebblDir, {
      ts: '2026-01-02T00:00:00.000Z',
      message: 'corrects a ghost',
      category: 'decision',
      tier: 'component',
      corrects: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ', // not a real eid in this log
    }));

    let rows;
    assert.doesNotThrow(() => { rows = fold(readEvents(pebblDir)); }, 'dangling corrects must not throw');
    const ghost = rows.find((r) => /corrects a ghost/.test(r.message));
    assert.ok(ghost && ghost.valid_to == null, 'the correcting entry stays live when its target is absent');
  });
});
