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
