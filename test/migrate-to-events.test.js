'use strict';
// P2 — migrator tests. We seed a real db.sqlite via the canonical openDb (so
// the v0.5 schema + bitemporal columns + the migrate ladder all apply), insert
// controlled logs / commits / handoffs with known FK refs, then exercise:
//   - dry-run mutates nothing
//   - real run produces valid LF-terminated JSONL + the db.sqlite -> legacy
//     rename
//   - lossless read-parity: fold(events) reproduces the live db.sqlite rows
//     (incl. the bitemporal valid_to live-set predicate)
//   - a planted dangling reference makes the migrator ABORT (no partial log)
//   - per-element session_entries (logs.id ints) AND session_commits (commit
//     hashes) resolve to the right event eids
//   - commits table rows become `commit` events
//   - free-text 'correction'-category entries (no corrects int) stay `append`
//   - idempotency: a second run is a safe no-op

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const { openDb } = require('../src/db');
const { fold, foldFull } = require('../src/fold');
const { readEvents, eventsPath } = require('../src/events');
const migrateToEvents = require('../src/migrate-to-events');
const {
  auditForeignKeys,
  buildIdMaps,
  buildEvents,
  readSnapshot,
  MigrationAbort,
  LEGACY_DB,
} = require('../src/migrate-to-events');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

function tmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-mig-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repo });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.pebbl'));
  return repo;
}

// Seed a store directly through openDb (real schema + bitemporal). Returns the
// pebblDir. `withCorrect` adds an explicit logs.corrects link (-> correct
// event) AND a free-text 'correction'-category entry WITHOUT a corrects int
// (-> stays append). Adds commits + a handoff whose session_entries reference
// log ids and session_commits reference commit hashes, plus a closed handoff.
function seed(repo, opts = {}) {
  const pebblDir = path.join(repo, '.pebbl');
  const db = openDb(pebblDir);

  const insLog = db.prepare(
    'INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects, valid_from, valid_to) VALUES (?,?,?,?,?,?,?,?,?,NULL)'
  );
  // 1: a plain decision
  insLog.run('2026-01-01T00:00:00.000Z', 'human', 'decision', 'component', 'use postgres', 'db', null, null, '2026-01-01T00:00:00.000Z');
  // 2: an agent-sourced detail (source parity matters here)
  insLog.run('2026-01-02T00:00:00.000Z', 'agent', 'data', 'detail', 'cache warms on boot', 'cache', null, null, '2026-01-02T00:00:00.000Z');
  // 3: relates_to #2
  insLog.run('2026-01-03T00:00:00.000Z', 'human', 'pattern', 'detail', 'related to cache', 'cache', 2, null, '2026-01-03T00:00:00.000Z');
  // 4: a free-text correction WITHOUT a corrects int — stays a plain append
  insLog.run('2026-01-04T00:00:00.000Z', 'human', 'correction', 'detail', 'we learned the hard way', 'ops', null, null, '2026-01-04T00:00:00.000Z');

  if (opts.withCorrect !== false) {
    // 5: corrects #1 — emits a `correct` event + stamps #1's valid_to
    insLog.run('2026-01-05T00:00:00.000Z', 'human', 'decision', 'component', 'use sqlite actually', 'db', null, 1, '2026-01-05T00:00:00.000Z');
    db.prepare('UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = 1').run('2026-01-05T00:00:00.000Z', 5);
  }

  // commits table — become `commit` events
  const insCommit = db.prepare('INSERT INTO commits (timestamp, hash, message, files) VALUES (?,?,?,?)');
  insCommit.run('2026-01-02T01:00:00.000Z', 'abc1234', 'first commit', 'a.js');
  insCommit.run('2026-01-03T01:00:00.000Z', 'def5678', 'second commit', 'b.js');

  // handoff: session_entries -> log ids [1,2], session_commits -> hashes
  const insHandoff = db.prepare(
    'INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status, closed_at, promoted_log_id, docs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  insHandoff.run(
    '2026-01-06T00:00:00.000Z', 'session one', 'did a; did b', 'do c', null, 'work', 'agent',
    JSON.stringify([1, 2]), JSON.stringify(['abc1234', 'def5678']), 'open', null, null, null
  );
  // a closed handoff with promoted_log_id -> #3
  insHandoff.run(
    '2026-01-07T00:00:00.000Z', 'session two', null, null, null, null, 'agent',
    JSON.stringify([2]), JSON.stringify([]), 'closed', '2026-01-08T00:00:00.000Z', 3, null
  );

  db.close();
  return pebblDir;
}

function liveLogRows(pebblDir) {
  const db = new Database(path.join(pebblDir, 'db.sqlite'));
  const rows = db.prepare(
    'SELECT timestamp, source, category, tier, message, topics FROM logs ORDER BY timestamp ASC, id ASC'
  ).all();
  db.close();
  return rows;
}

function runCli(repo, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── dry-run mutates nothing ───────────────────────────────────────────────────

describe('migrate-to-events: dry-run', () => {
  it('default (no flag) prints a plan, writes no events.jsonl, does not rename db.sqlite', () => {
    const repo = tmpRepo();
    seed(repo);
    const before = fs.readdirSync(path.join(repo, '.pebbl')).sort();

    const out = runCli(repo, ['migrate-to-events']);

    const after = fs.readdirSync(path.join(repo, '.pebbl')).sort();
    assert.deepEqual(after, before, 'dry-run must not add/remove any file');
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl', 'events.jsonl')), 'no events.jsonl on dry-run');
    assert.ok(fs.existsSync(path.join(repo, '.pebbl', 'db.sqlite')), 'db.sqlite still present');
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl', LEGACY_DB)), 'no legacy rename on dry-run');
    assert.match(out, /DRY-RUN/);
    assert.match(out, /would write \d+ events/);
  });
});

// ── real run: valid JSONL + rename ────────────────────────────────────────────

describe('migrate-to-events: real run (--apply)', () => {
  it('produces LF-terminated valid-JSON events.jsonl and renames db.sqlite -> legacy', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);

    runCli(repo, ['migrate-to-events', '--apply']);

    const file = path.join(pebblDir, 'events.jsonl');
    assert.ok(fs.existsSync(file), 'events.jsonl written');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw[raw.length - 1], '\n', 'trailing-newline invariant: last byte is LF');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `every line is valid JSON: ${line.slice(0, 60)}`);
    }
    assert.ok(!fs.existsSync(path.join(pebblDir, 'db.sqlite')), 'db.sqlite renamed away');
    assert.ok(fs.existsSync(path.join(pebblDir, LEGACY_DB)), 'legacy-db.sqlite is the rollback artifact');
    // migrate --apply writes the positive completeness marker (the canonical
    // signal for clones; storeMode step 2/3). storeMode must read 'events'.
    const { EVENTS_CANONICAL_MARKER, storeMode } = require('../src/store-mode');
    assert.ok(fs.existsSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER)),
      'migrate --apply must write the .events-canonical marker');
    assert.equal(storeMode(pebblDir), 'events', 'a migrated store reads from the fold');
  });

  it('--write is accepted as the apply alias', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    runCli(repo, ['migrate-to-events', '--write']);
    assert.ok(fs.existsSync(eventsPath(pebblDir)), 'events.jsonl written under --write');
  });
});

// ── lossless read-parity via fold() ───────────────────────────────────────────

describe('migrate-to-events: read-parity (fold equivalence)', () => {
  it('fold(events) reproduces the live db.sqlite logs rows (source/category/tier/message/topics)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);

    const dbRows = liveLogRows(pebblDir); // capture BEFORE the rename

    runCli(repo, ['migrate-to-events', '--apply']);

    const proj = foldFull(readEvents(pebblDir));
    const foldedRows = proj.logs
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id))
      .map((r) => ({
        timestamp: r.timestamp,
        source: r.source,
        category: r.category,
        tier: r.tier,
        message: r.message,
        topics: r.topics || null,
      }));

    assert.deepEqual(foldedRows, dbRows, 'folded logs must match db.sqlite logs');
  });

  it('source parity holds: an agent-sourced row folds back as source=agent (not defaulted to human)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    runCli(repo, ['migrate-to-events', '--apply']);
    const rows = fold(readEvents(pebblDir));
    const agentRow = rows.find((r) => r.message === 'cache warms on boot');
    assert.ok(agentRow, 'agent row present');
    assert.equal(agentRow.source, 'agent', 'source stamped + read back as agent');
  });

  it('bitemporal valid_to: the corrected row is stamped, the correcting row is the live head', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    runCli(repo, ['migrate-to-events', '--apply']);
    const rows = fold(readEvents(pebblDir));
    const orig = rows.find((r) => r.message === 'use postgres');
    const head = rows.find((r) => r.message === 'use sqlite actually');
    assert.equal(orig.valid_to, '2026-01-05T00:00:00.000Z', 'corrected row stamped at correction time');
    assert.equal(orig.invalidated_by, head.id, 'corrected row attributed to the correcting entry');
    assert.equal(head.valid_to, null, 'correcting entry is the current belief');
    // the corrected row does NOT vanish (bitemporal, not a DELETE)
    assert.ok(orig, 'corrected row remains in the set');
  });
});

// ── planted dangling reference -> abort ───────────────────────────────────────

describe('migrate-to-events: dangling FK aborts the store', () => {
  it('a dangling logs.corrects aborts with non-zero and writes no events.jsonl', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    // plant a dangling corrects pointing at a non-existent id 999
    const db = openDb(pebblDir);
    db.prepare('INSERT INTO logs (timestamp, source, category, tier, message, valid_from) VALUES (?,?,?,?,?,?)')
      .run('2026-01-09T00:00:00.000Z', 'human', 'correction', 'detail', 'dangling', '2026-01-09T00:00:00.000Z');
    db.prepare('UPDATE logs SET corrects = 999 WHERE message = ?').run('dangling');
    db.close();

    let threw = false;
    try {
      runCli(repo, ['migrate-to-events', '--apply']);
    } catch (err) {
      threw = true;
      assert.ok(err.status !== 0, 'non-zero exit on dangling reference');
    }
    assert.ok(threw, 'migrator must abort on a dangling reference');
    assert.ok(!fs.existsSync(eventsPath(pebblDir)), 'no partial events.jsonl after abort');
    assert.ok(fs.existsSync(path.join(pebblDir, 'db.sqlite')), 'db.sqlite untouched after abort');
  });

  it('a dangling session_entries element aborts (per-element verify, not just the column)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo, { withCorrect: false });
    const db = openDb(pebblDir);
    // a handoff whose session_entries lists a non-existent log id
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, source, session_entries, session_commits, status) VALUES (?,?,?,?,?,?)'
    ).run('2026-01-10T00:00:00.000Z', 'bad refs', 'agent', JSON.stringify([1, 777]), JSON.stringify([]), 'open');
    db.close();

    assert.throws(() => auditForeignKeys(readSnapshotFor(pebblDir)), MigrationAbort);
  });

  it('a dangling session_commits hash aborts', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo, { withCorrect: false });
    const db = openDb(pebblDir);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, source, session_entries, session_commits, status) VALUES (?,?,?,?,?,?)'
    ).run('2026-01-11T00:00:00.000Z', 'bad commit', 'agent', JSON.stringify([]), JSON.stringify(['nope999']), 'open');
    db.close();
    assert.throws(() => auditForeignKeys(readSnapshotFor(pebblDir)), MigrationAbort);
  });
});

function readSnapshotFor(pebblDir) {
  const db = new Database(path.join(pebblDir, 'db.sqlite'), { readonly: true });
  const snap = readSnapshot(db);
  db.close();
  return snap;
}

// ── per-element array resolution ──────────────────────────────────────────────

describe('migrate-to-events: per-element FK resolution', () => {
  it('session_entries ints map to append/correct eids; session_commits hashes map to commit eids', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const snap = readSnapshotFor(pebblDir);
    const maps = buildIdMaps(snap);
    const events = buildEvents(snap, maps, 'tester@host');

    const open = events.find((e) => e.type === 'handoff-open' && e.summary === 'session one');
    assert.ok(open, 'handoff-open event present');
    // session_entries [1,2] -> the eids minted for log ids 1 and 2
    assert.deepEqual(open.session_entries, [maps.logEid.get(1), maps.logEid.get(2)], 'session_entries remapped per-element to log eids');
    // session_commits hashes -> the eids minted for those commits
    assert.deepEqual(open.session_commits, [maps.commitEid.get('abc1234'), maps.commitEid.get('def5678')], 'session_commits remapped per-element to commit eids');
    // every session_commits eid is actually a minted commit event eid
    const commitEids = new Set(events.filter((e) => e.type === 'commit').map((e) => e.eid));
    for (const eid of open.session_commits) assert.ok(commitEids.has(eid), 'each session_commits eid is a real commit event');
  });

  it('promoted_log_id is remapped to the target log eid on the handoff-open event', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const snap = readSnapshotFor(pebblDir);
    const maps = buildIdMaps(snap);
    const events = buildEvents(snap, maps, 'tester@host');
    const closed = events.find((e) => e.type === 'handoff-open' && e.summary === 'session two');
    assert.equal(closed.promoted_log_id, maps.logEid.get(3), 'promoted_log_id remapped to log #3 eid');
  });
});

// ── commits -> commit events ──────────────────────────────────────────────────

describe('migrate-to-events: commits table', () => {
  it('every commits row becomes a commit event carrying its hash', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const snap = readSnapshotFor(pebblDir);
    const maps = buildIdMaps(snap);
    const events = buildEvents(snap, maps, 'tester@host');
    const commitEvents = events.filter((e) => e.type === 'commit');
    assert.equal(commitEvents.length, 2, 'two commit events for two commits rows');
    assert.deepEqual(commitEvents.map((e) => e.hash).sort(), ['abc1234', 'def5678']);
  });
});

// ── free-text corrections stay append (Q1=A) ──────────────────────────────────

describe('migrate-to-events: free-text corrections (Q1=A)', () => {
  it('a correction-category entry WITHOUT a corrects int migrates as a plain append, not a correct', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const snap = readSnapshotFor(pebblDir);
    const maps = buildIdMaps(snap);
    const events = buildEvents(snap, maps, 'tester@host');
    const freeText = events.find((e) => e.message === 'we learned the hard way');
    assert.equal(freeText.type, 'append', 'free-text correction is a plain append');
    assert.ok(!('corrects' in freeText), 'no corrects link invented for a free-text correction');
    // only the explicit logs.corrects produced a correct event
    const corrects = events.filter((e) => e.type === 'correct');
    assert.equal(corrects.length, 1, 'exactly one correct event (the explicit corrects=1 link)');
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────

describe('migrate-to-events: idempotency', () => {
  it('a second --apply run is a safe no-op (no duplicate events, no re-rename)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);

    runCli(repo, ['migrate-to-events', '--apply']);
    const firstRaw = fs.readFileSync(eventsPath(pebblDir), 'utf8');
    const firstCount = firstRaw.split('\n').filter((l) => l).length;

    // second run — store is already migrated (events.jsonl + legacy present)
    const out = runCli(repo, ['migrate-to-events', '--apply']);
    const secondRaw = fs.readFileSync(eventsPath(pebblDir), 'utf8');
    const secondCount = secondRaw.split('\n').filter((l) => l).length;

    assert.equal(secondCount, firstCount, 'no events duplicated on a second run');
    assert.equal(secondRaw, firstRaw, 'events.jsonl byte-identical after a no-op run');
    assert.match(out, /already migrated/);
  });

  it('dry-run on an already-migrated store is also a no-op', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    runCli(repo, ['migrate-to-events', '--apply']);
    const out = runCli(repo, ['migrate-to-events']); // dry-run, already migrated
    assert.match(out, /already migrated/);
  });

  it('idempotency keys on legacy-db.sqlite, NOT a bare events.jsonl (P0 tracer drift)', () => {
    // A real store always has a P0 TRACER events.jsonl (pebbl log writes one on
    // every call). That bare events.jsonl must NOT make the migrator think the
    // store is already migrated — only legacy-db.sqlite (db renamed) means done.
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    // simulate the tracer: a partial events.jsonl present, db NOT yet renamed.
    fs.writeFileSync(eventsPath(pebblDir), JSON.stringify({ eid: 'TRACER', ts: '2026-01-01T00:00:00.000Z', emitted_at: '2026-01-01T00:00:00.000Z', type: 'append', message: 'tracer', source: 'human' }) + '\n');

    runCli(repo, ['migrate-to-events', '--apply']);

    // migration ran (db renamed) despite the pre-existing tracer log
    assert.ok(fs.existsSync(path.join(pebblDir, LEGACY_DB)), 'db.sqlite renamed -> migration ran');
    // the tracer log was preserved, not appended onto / double-counted
    assert.ok(fs.existsSync(path.join(pebblDir, 'events.tracer.bak.jsonl')), 'tracer log preserved as .bak');
    // the canonical log does NOT contain the tracer event
    const events = readEvents(pebblDir);
    assert.ok(!events.some((e) => e.eid === 'TRACER'), 'tracer event not in the canonical migration log');
  });
});

// ── direct unit: the map is built fully before any remap (Acceptance #5) ──────

describe('migrate-to-events: map-first invariant', () => {
  it('every relation eid in the events resolves to a minted event eid (no forward dangle)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const snap = readSnapshotFor(pebblDir);
    const maps = buildIdMaps(snap);
    const events = buildEvents(snap, maps, 'tester@host');
    const allEids = new Set(events.map((e) => e.eid));
    for (const e of events) {
      if (e.corrects) assert.ok(allEids.has(e.corrects), 'corrects eid was minted');
      if (e.relates_to) assert.ok(allEids.has(e.relates_to), 'relates_to eid was minted');
      if (e.type === 'handoff-open') {
        for (const se of e.session_entries) assert.ok(allEids.has(se), 'session_entry eid was minted');
        for (const sc of e.session_commits) assert.ok(allEids.has(sc), 'session_commit eid was minted');
        if (e.promoted_log_id) assert.ok(allEids.has(e.promoted_log_id), 'promoted_log_id eid was minted');
      }
      if (e.type === 'handoff-close') assert.ok(allEids.has(e.handoff), 'handoff-close target eid was minted');
    }
  });
});

// ── --repair: dangling FK refs migrate instead of aborting the whole store ─────

const { REPAIR_MANIFEST } = require('../src/migrate-to-events');

// Run the CLI capturing stdout/stderr/status without throwing on non-zero.
function runCliCapture(repo, args) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('node', [PEBBL_BIN, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Make a real git commit in the repo so its hash is RECOVERABLE from git.
function makeRealCommit(repo, name, content) {
  fs.writeFileSync(path.join(repo, name), content);
  execFileSync('git', ['add', name], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', `add ${name}`], { cwd: repo });
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('migrate-to-events: --repair dangling session_commits', () => {
  // The headline acceptance: a store with a handoff -> non-existent commit hash
  // ABORTS at default --apply (db untouched) but COMPLETES under --apply --repair
  // with a manifest, marker, rename, read parity, and a no-op second run.
  it('default --apply ABORTS and leaves db.sqlite untouched; --apply --repair COMPLETES with a manifest', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    // plant a handoff referencing a commit hash that is NOT in the commits table
    // AND not reachable in git -> the unrecoverable drop-with-manifest path.
    const db = openDb(pebblDir);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, source, session_entries, session_commits, status) VALUES (?,?,?,?,?,?)'
    ).run('2026-02-01T00:00:00.000Z', 'dangling commit handoff', 'agent', JSON.stringify([1]), JSON.stringify(['deadbeef']), 'open');
    db.close();

    // capture the pre-migration read surface (for parity) BEFORE any rename
    const dbRowsBefore = liveLogRows(pebblDir);

    // 1) default --apply -> ABORT, nothing written, db.sqlite untouched
    const strict = runCliCapture(repo, ['migrate-to-events', '--apply']);
    assert.notEqual(strict.status, 0, 'default --apply exits non-zero on a dangling commit');
    assert.match(strict.stderr, /ABORT/);
    assert.ok(!fs.existsSync(eventsPath(pebblDir)), 'no partial events.jsonl after strict abort');
    assert.ok(fs.existsSync(path.join(pebblDir, 'db.sqlite')), 'db.sqlite untouched after strict abort');
    assert.ok(!fs.existsSync(path.join(pebblDir, LEGACY_DB)), 'no legacy rename after strict abort');
    assert.ok(!fs.existsSync(path.join(pebblDir, REPAIR_MANIFEST)), 'no manifest written in strict mode');

    // 2) --apply --repair -> COMPLETE: events.jsonl, rename, marker, manifest
    const rep = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(rep.status, 0, '--apply --repair completes (exit 0)');
    assert.ok(fs.existsSync(eventsPath(pebblDir)), 'events.jsonl written under --repair');
    assert.ok(!fs.existsSync(path.join(pebblDir, 'db.sqlite')), 'db.sqlite renamed away under --repair');
    assert.ok(fs.existsSync(path.join(pebblDir, LEGACY_DB)), 'legacy-db.sqlite rollback artifact present');
    const { EVENTS_CANONICAL_MARKER, storeMode } = require('../src/store-mode');
    assert.ok(fs.existsSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER)), '.events-canonical marker present');
    assert.equal(storeMode(pebblDir), 'events', 'migrated store reads from the fold');

    // events.jsonl is complete + valid (every line parses, LF-terminated)
    const raw = fs.readFileSync(eventsPath(pebblDir), 'utf8');
    assert.equal(raw[raw.length - 1], '\n', 'trailing-newline invariant holds');
    for (const line of raw.split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), 'every events.jsonl line is valid JSON');
    }

    // the manifest names exactly what was dropped (handoff id + hash)
    assert.ok(fs.existsSync(path.join(pebblDir, REPAIR_MANIFEST)), 'manifest written when something was repaired');
    const manifest = JSON.parse(fs.readFileSync(path.join(pebblDir, REPAIR_MANIFEST), 'utf8'));
    assert.equal(manifest.dropped_commits.length, 1, 'one dropped commit recorded');
    assert.equal(manifest.dropped_commits[0].hash, 'deadbeef', 'manifest names the dropped hash');
    assert.ok(manifest.dropped_commits[0].handoff != null, 'manifest names the owning handoff id');
    assert.match(rep.stderr, /DROPPED dangling commit deadbeef/);

    // 3) read parity: every memory ENTRY survives (only the back-link element changed)
    const proj = foldFull(readEvents(pebblDir));
    const foldedRows = proj.logs
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id))
      .map((r) => ({ timestamp: r.timestamp, source: r.source, category: r.category, tier: r.tier, message: r.message, topics: r.topics || null }));
    assert.deepEqual(foldedRows, dbRowsBefore, 'no memory entry lost: folded logs == pre-migration db.sqlite logs');

    // the surviving session_commits for that handoff is now empty (element dropped)
    const open = readEvents(pebblDir).find((e) => e.type === 'handoff-open' && e.summary === 'dangling commit handoff');
    assert.ok(open, 'the repaired handoff still migrated');
    assert.deepEqual(open.session_commits, [], 'the single dangling element was dropped, not the handoff');
    assert.equal(open.session_entries.length, 1, 'the valid session_entries ref (log #1) is preserved — only the bad commit element was dropped');

    // 4) idempotency: a second --repair run is a safe no-op
    const second = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(second.status, 0, 'second --repair run exits 0');
    assert.match(second.stdout, /already migrated/);
    const rawAfter = fs.readFileSync(eventsPath(pebblDir), 'utf8');
    assert.equal(rawAfter, raw, 'events.jsonl byte-identical after the no-op second run');
  });

  it('--repair RECOVERS a git-reachable commit hash (backfills a commits row) instead of dropping', () => {
    const repo = tmpRepo();
    // a REAL commit -> its hash is recoverable from git
    const realHash = makeRealCommit(repo, 'feature.js', 'export const x = 1;\n');
    const pebblDir = seed(repo);
    // handoff references the real commit hash, which is NOT in the commits table
    const db = openDb(pebblDir);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, source, session_entries, session_commits, status) VALUES (?,?,?,?,?,?)'
    ).run('2026-02-02T00:00:00.000Z', 'recoverable commit handoff', 'agent', JSON.stringify([]), JSON.stringify([realHash]), 'open');
    db.close();

    const rep = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(rep.status, 0, '--repair completes');
    const manifest = JSON.parse(fs.readFileSync(path.join(pebblDir, REPAIR_MANIFEST), 'utf8'));
    assert.equal(manifest.recovered_commits.length, 1, 'the reachable commit was recovered, not dropped');
    assert.equal(manifest.recovered_commits[0].hash, realHash, 'manifest names the recovered hash');
    assert.equal(manifest.dropped_commits.length, 0, 'nothing dropped when git recovery succeeds');
    assert.match(rep.stderr, /RECOVERED commit/);

    // the recovered commit appears as a real `commit` event and the handoff links it
    const events = readEvents(pebblDir);
    const open = events.find((e) => e.type === 'handoff-open' && e.summary === 'recoverable commit handoff');
    assert.equal(open.session_commits.length, 1, 'the recovered commit element survives');
    const commitEids = new Set(events.filter((e) => e.type === 'commit').map((e) => e.eid));
    assert.ok(commitEids.has(open.session_commits[0]), 'session_commits points at a minted commit event');
    const recoveredCommit = events.find((e) => e.type === 'commit' && e.hash === realHash);
    assert.ok(recoveredCommit, 'a commit event was backfilled for the recovered hash');
    assert.match(recoveredCommit.message, /add feature\.js/, 'backfilled commit carries the real subject from git');
  });

  it('--repair clears a dangling logs.corrects (row migrates as a plain append) and records it', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    // plant a dangling corrects -> 999 (the strict-abort test fixture, now repaired)
    const db = openDb(pebblDir);
    db.prepare('INSERT INTO logs (timestamp, source, category, tier, message, valid_from) VALUES (?,?,?,?,?,?)')
      .run('2026-02-03T00:00:00.000Z', 'human', 'correction', 'detail', 'dangling correct', '2026-02-03T00:00:00.000Z');
    db.prepare('UPDATE logs SET corrects = 999 WHERE message = ?').run('dangling correct');
    db.close();

    const rep = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(rep.status, 0, '--repair completes past a dangling corrects');
    const manifest = JSON.parse(fs.readFileSync(path.join(pebblDir, REPAIR_MANIFEST), 'utf8'));
    assert.equal(manifest.dropped_corrects.length, 1, 'the dangling corrects was cleared');
    assert.equal(manifest.dropped_corrects[0].target, 999, 'manifest names the missing target');

    // the row still migrated, now as a plain append (no corrects link)
    const events = readEvents(pebblDir);
    const row = events.find((e) => e.message === 'dangling correct');
    assert.equal(row.type, 'append', 'a row whose corrects dangled migrates as a plain append');
    assert.ok(!('corrects' in row), 'no corrects link survives');
  });

  it('--repair drops a dangling session_entries element and records the handoff + log id', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo, { withCorrect: false });
    const db = openDb(pebblDir);
    db.prepare(
      'INSERT INTO handoffs (timestamp, summary, source, session_entries, session_commits, status) VALUES (?,?,?,?,?,?)'
    ).run('2026-02-04T00:00:00.000Z', 'bad entry', 'agent', JSON.stringify([1, 777]), JSON.stringify([]), 'open');
    db.close();

    const rep = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(rep.status, 0, '--repair completes past a dangling session_entries element');
    const manifest = JSON.parse(fs.readFileSync(path.join(pebblDir, REPAIR_MANIFEST), 'utf8'));
    assert.equal(manifest.dropped_session_entries.length, 1, 'one dangling entry dropped');
    assert.deepEqual(
      { handoff: manifest.dropped_session_entries[0].handoff != null, logId: manifest.dropped_session_entries[0].logId },
      { handoff: true, logId: 777 },
      'manifest names the owning handoff and the missing log id'
    );

    // the surviving entry (#1) is kept; only #777 was dropped
    const open = readEvents(pebblDir).find((e) => e.type === 'handoff-open' && e.summary === 'bad entry');
    assert.equal(open.session_entries.length, 1, 'the surviving session_entries element is kept');
  });

  it('--repair on a CLEAN store writes NO manifest and behaves like a plain --apply', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo); // no planted dangling refs
    const rep = runCliCapture(repo, ['migrate-to-events', '--apply', '--repair']);
    assert.equal(rep.status, 0, '--repair on a clean store completes');
    assert.ok(fs.existsSync(eventsPath(pebblDir)), 'events.jsonl written');
    assert.ok(!fs.existsSync(path.join(pebblDir, REPAIR_MANIFEST)), 'no manifest when nothing needed repair');
    assert.ok(!/ALTERED the store/.test(rep.stderr), 'no LOUD repair warning when nothing was repaired');
  });

  it('default --apply (no --repair) on a dangling-corrects store still ABORTS (strict unchanged)', () => {
    const repo = tmpRepo();
    const pebblDir = seed(repo);
    const db = openDb(pebblDir);
    db.prepare('INSERT INTO logs (timestamp, source, category, tier, message, valid_from) VALUES (?,?,?,?,?,?)')
      .run('2026-02-05T00:00:00.000Z', 'human', 'correction', 'detail', 'still dangling', '2026-02-05T00:00:00.000Z');
    db.prepare('UPDATE logs SET corrects = 999 WHERE message = ?').run('still dangling');
    db.close();
    const strict = runCliCapture(repo, ['migrate-to-events', '--apply']);
    assert.notEqual(strict.status, 0, 'strict default still aborts on a dangling corrects');
    assert.ok(!fs.existsSync(eventsPath(pebblDir)), 'no events.jsonl after strict abort');
    assert.ok(fs.existsSync(path.join(pebblDir, 'db.sqlite')), 'db.sqlite untouched');
  });
});
