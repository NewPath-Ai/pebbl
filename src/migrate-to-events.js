'use strict';
// P2 — `pebbl migrate-to-events`: lift a binary `db.sqlite` store into the
// canonical append-only `events.jsonl` so the real cutover (P6) has a lossless,
// auditable on-ramp.
//
// Contract (notes/design-event-sourcing-2026-06-17.md, P2 bullet + Resolved
// decisions):
//   - DRY-RUN by default: prints an audit + plan, mutates NOTHING on disk.
//     A real run is behind an explicit `--apply`/`--write` flag.
//   - Per-store SAME-SNAPSHOT pre-migration FK audit that ABORTS the whole
//     store (non-zero exit, no partial events.jsonl) on ANY dangling reference.
//   - The oldInt->ULID map is built FULLY before any remap, with time-seeded
//     ULIDs so event sort order matches legacy (timestamp, id) order (no
//     forward-reference can dangle because a target was not minted yet).
//   - Remap ALL FIVE FK sites: logs.relates_to, logs.corrects,
//     handoffs.promoted_log_id, and PER-ELEMENT handoffs.session_entries
//     (logs.id ints -> append/correct eids) and handoffs.session_commits
//     (commit hashes -> minted `commit` event eids).
//   - commits table rows -> `commit` events.
//   - The 36 free-text `correction`-category entries migrate as plain `append`
//     events (Q1=A, no heuristic linking) — ONLY explicit logs.corrects ints
//     produce `correct` events.
//   - ADDITIVE: never delete db.sqlite. On a real run, rename db.sqlite ->
//     legacy-db.sqlite as the rollback artifact. Idempotent: a second run on
//     an already-migrated store is a safe no-op.
//
// STAGING DRIFT (bitemporal v0.5): the logs table carries valid_from / valid_to
// / invalidated_by. valid_to/invalidated_by are DERIVED by the fold from the
// `correct` events (fold.js stamps the target's valid_to = the correction's ts,
// invalidated_by = the correcting eid), exactly as the legacy v0.5 write path
// does (log.js:259-263) and the v0.5 backfill (migrate.js:81-86). So we do NOT
// re-emit valid_to as an event field — we emit the `correct` link with the
// correcting row's timestamp as `ts` and let the fold re-derive it. We DO stamp
// valid_from per row so plain appends reproduce db's valid_from.
//
// SOURCE SEAM (carried from P1): P0's append envelope dropped `source`, so the
// fold defaulted rows to human. But db.sqlite HAS the real per-row `source`
// (human/agent/hook) and the current fold READS event.source first
// (fold.js:130 `source: e.source || actorToSource(e)`). So we STAMP `source`
// onto every migrated event — the log is lossless AND fold-level source parity
// closes. No fold change needed.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { requirePebblDir } = require('./find-pebbl');
const { ulid } = require('./ulid');
const { withLock } = require('./lock');
const { appendEvent, resolveActor, eventsPath, ENVELOPE_VERSION } = require('./events');

const LEGACY_DB = 'legacy-db.sqlite';
// A pre-existing events.jsonl on an UN-migrated store is the P0 TRACER log —
// `pebbl log` appends an `append` event on every call (log.js:273, always on).
// It is partial (no commits/handoffs/corrects, no FK remap, throwaway eids), so
// it is NOT a completed migration. The migration writes a fresh CANONICAL log;
// we move the tracer aside to this .bak so it isn't double-counted.
const TRACER_BAK = 'events.tracer.bak.jsonl';

// ── helpers ──────────────────────────────────────────────────────────────────

// A real run is gated behind an explicit flag; default is dry-run. We accept
// both spellings the contract named (`--apply` / `--write`).
function wantsApply(args) {
  return args.includes('--apply') || args.includes('--write');
}

// Parse a JSON array column (session_entries / session_commits / docs). Stored
// as a JSON-stringified array in a TEXT column (handoff.js:200-202); NULL/empty
// means no refs. A malformed value is loud, not silent — corruption must abort.
function parseJsonArray(value, label, handoffId) {
  if (value == null || value === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new MigrationAbort(
      `handoff #${handoffId}: ${label} is not valid JSON (${err.message})`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MigrationAbort(`handoff #${handoffId}: ${label} is not a JSON array`);
  }
  return parsed;
}

// A loud abort that carries a non-zero exit contract. Thrown by the audit (and
// by malformed JSON) so the store leaves NO partial events.jsonl behind.
class MigrationAbort extends Error {}

// Time-seeded ULID: seed the 48-bit time prefix from the row's domain
// timestamp so event lexical order tracks legacy chronological order. Ties on
// the same ms are broken by `emitted_at` (a monotonic per-row counter, below),
// which is the fold's secondary sort key — so the surviving fold order matches
// legacy (timestamp, id) order exactly.
function tsToMillis(ts) {
  const ms = Date.parse(ts || '');
  return Number.isNaN(ms) ? 0 : ms;
}

// ── reading the store (one snapshot) ──────────────────────────────────────────

// Read every table we migrate in deterministic order. logs and commits in
// (timestamp, id) order — the recency order the read side relies on. handoffs
// in id order. One open db, one snapshot, so the audit and the build see the
// exact same rows (the contract's "per-store SAME-SNAPSHOT" requirement).
function readSnapshot(db) {
  const logs = db.prepare(
    'SELECT id, timestamp, source, category, tier, message, topics, relates_to, corrects, valid_from, valid_to, invalidated_by FROM logs ORDER BY timestamp ASC, id ASC'
  ).all();
  const commits = db.prepare(
    'SELECT id, timestamp, hash, message, files FROM commits ORDER BY timestamp ASC, id ASC'
  ).all();
  const handoffs = db.prepare(
    'SELECT id, timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status, closed_at, promoted_log_id, docs FROM handoffs ORDER BY id ASC'
  ).all();
  return { logs, commits, handoffs };
}

// ── the per-store FK audit (same snapshot, loud abort) ────────────────────────

// Assert EVERY foreign-key integer resolves to a surviving row BEFORE any event
// is built or written. Returns a structured audit report (counts + the resolved
// reference sets) for the dry-run plan; THROWS MigrationAbort on the first
// dangling reference so the store aborts whole (non-zero exit, no partial log).
//
// Five FK sites (design Approach): logs.relates_to, logs.corrects,
// handoffs.promoted_log_id (logs.id ints), and PER-ELEMENT
// handoffs.session_entries (logs.id ints) and handoffs.session_commits (commit
// hashes — a DISTINCT id space, resolved against the commits table, not logs).
function auditForeignKeys(snapshot) {
  const { logs, commits, handoffs } = snapshot;

  const logIds = new Set(logs.map((r) => r.id));
  const commitHashes = new Set(commits.map((c) => c.hash));

  const report = {
    logs: logs.length,
    commits: commits.length,
    handoffs: handoffs.length,
    relatesTo: 0,
    corrects: 0,
    promotedLogId: 0,
    sessionEntries: 0,
    sessionCommits: 0,
    corrections: 0, // free-text 'correction'-category logs WITHOUT a corrects int
  };

  const need = (set, id, what) => {
    if (id == null) return;
    if (!set.has(id)) {
      throw new MigrationAbort(`dangling reference: ${what} -> ${id} (no surviving target)`);
    }
  };

  for (const row of logs) {
    if (row.relates_to != null) { need(logIds, row.relates_to, `logs#${row.id}.relates_to`); report.relatesTo += 1; }
    if (row.corrects != null) { need(logIds, row.corrects, `logs#${row.id}.corrects`); report.corrects += 1; }
    if (row.category === 'correction' && row.corrects == null) report.corrections += 1;
  }

  for (const h of handoffs) {
    if (h.promoted_log_id != null) { need(logIds, h.promoted_log_id, `handoffs#${h.id}.promoted_log_id`); report.promotedLogId += 1; }
    const entries = parseJsonArray(h.session_entries, 'session_entries', h.id);
    for (const e of entries) {
      need(logIds, e, `handoffs#${h.id}.session_entries[]`);
      report.sessionEntries += 1;
    }
    const shCommits = parseJsonArray(h.session_commits, 'session_commits', h.id);
    for (const c of shCommits) {
      if (!commitHashes.has(c)) {
        throw new MigrationAbort(`dangling reference: handoffs#${h.id}.session_commits[] -> ${c} (no surviving commit)`);
      }
      report.sessionCommits += 1;
    }
  }

  return report;
}

// ── map-first pass: oldInt/hash -> ULID, all minted before any remap ──────────

// Build the COMPLETE identity maps before a single reference is rewritten, so
// no forward reference can dangle because a target was not minted yet
// (Acceptance #5). logs.id -> eid; commit hash -> eid. ULIDs are time-seeded
// from each row's timestamp; we read rows in (timestamp, id) order so minting
// order tracks legacy order. A per-row monotonic `emitted_at` (the fold's
// secondary key) guarantees the surviving fold order matches legacy order even
// when timestamps tie at the millisecond.
function buildIdMaps(snapshot) {
  const { logs, commits } = snapshot;
  const logEid = new Map();   // logs.id  -> eid
  const commitEid = new Map(); // commit hash -> eid

  // A single monotonic counter across BOTH tables, interleaved in time order,
  // so emitted_at is globally increasing and the (ts, emitted_at, eid) fold
  // order is total and matches legacy order. We encode the counter as an ISO
  // timestamp offset from a fixed epoch so it is a valid `emitted_at` string.
  const merged = [];
  for (const r of logs) merged.push({ kind: 'log', id: r.id, ts: r.timestamp });
  for (const c of commits) merged.push({ kind: 'commit', id: c.id, hash: c.hash, ts: c.timestamp });
  merged.sort((a, b) => {
    const at = a.ts || '';
    const bt = b.ts || '';
    if (at !== bt) return at < bt ? -1 : 1;
    // tie-break by (kind, legacy id) for a stable, reproducible mint order
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id - b.id;
  });

  const emittedAt = new Map(); // "log:<id>" / "commit:<hash>" -> emitted_at iso
  const EPOCH = Date.parse('2000-01-01T00:00:00.000Z');
  merged.forEach((m, i) => {
    // monotonic, 1ms apart, so emitted_at strictly increases in mint order.
    const iso = new Date(EPOCH + i).toISOString();
    if (m.kind === 'log') {
      logEid.set(m.id, ulid(tsToMillis(m.ts)));
      emittedAt.set(`log:${m.id}`, iso);
    } else {
      commitEid.set(m.hash, ulid(tsToMillis(m.ts)));
      emittedAt.set(`commit:${m.hash}`, iso);
    }
  });

  return { logEid, commitEid, emittedAt };
}

// ── building the events (remap pass) ──────────────────────────────────────────

// Translate the snapshot into the ordered event list. Every FK is remapped
// through the COMPLETE maps from buildIdMaps. Field names match exactly what
// the P1 fold reads (fold.js): append/correct carry the log fields; correct
// carries `corrects` = the remapped target eid; commit -> a `commit` event;
// handoff-open carries session_entries (remapped logs eids) + session_commits
// (remapped commit eids) + promoted_log_id (remapped, stamped for losslessness
// though the current fold does not yet read it); handoff-close carries the open
// handoff's eid.
function buildEvents(snapshot, maps, actor) {
  const { logs, commits, handoffs } = snapshot;
  const { logEid, commitEid, emittedAt } = maps;
  const events = [];

  // logs -> append (or correct when logs.corrects is an explicit int). The 36
  // free-text 'correction'-category entries WITHOUT a corrects int stay plain
  // `append` (Q1=A, no heuristic).
  for (const row of logs) {
    const eid = logEid.get(row.id);
    const base = {
      eid,
      ts: row.timestamp,
      emitted_at: emittedAt.get(`log:${row.id}`),
      type: row.corrects != null ? 'correct' : 'append',
      actor,
      v: ENVELOPE_VERSION,
      source: row.source || 'human',
      category: row.category || 'uncategorized',
      tier: row.tier || 'detail',
      message: row.message || '',
      topics: row.topics || '',
      // valid_from is reproduced verbatim so plain appends keep db's value;
      // valid_to / invalidated_by are DERIVED by the fold from `correct`, never
      // re-emitted (see header note).
      valid_from: row.valid_from || row.timestamp,
      legacy_id: row.id, // old human refs ("see #412") still resolve (design IDs)
    };
    if (row.relates_to != null) base.relates_to = logEid.get(row.relates_to);
    if (row.corrects != null) base.corrects = logEid.get(row.corrects);
    events.push(base);
  }

  // commits table -> `commit` events. Separate id space from logs; the fold
  // does not yet reduce these (KNOWN_TYPES has no `commit`), but they are
  // emitted losslessly and session_commits remaps to their eids.
  for (const c of commits) {
    events.push({
      eid: commitEid.get(c.hash),
      ts: c.timestamp,
      emitted_at: emittedAt.get(`commit:${c.hash}`),
      type: 'commit',
      actor,
      v: ENVELOPE_VERSION,
      hash: c.hash,
      message: c.message || '',
      files: c.files || '',
    });
  }

  // handoffs -> handoff-open (+ handoff-close if closed). Mint one eid per
  // handoff; remap the two arrays per-element and promoted_log_id.
  let handoffEmitSeq = 0;
  const HANDOFF_EPOCH = Date.parse('2001-01-01T00:00:00.000Z');
  for (const h of handoffs) {
    const heid = ulid(tsToMillis(h.timestamp));
    const openEmitted = new Date(HANDOFF_EPOCH + handoffEmitSeq).toISOString();
    handoffEmitSeq += 1;

    const sessionEntries = parseJsonArray(h.session_entries, 'session_entries', h.id)
      .map((id) => logEid.get(id));
    const sessionCommits = parseJsonArray(h.session_commits, 'session_commits', h.id)
      .map((hash) => commitEid.get(hash));

    const open = {
      eid: heid,
      ts: h.timestamp,
      emitted_at: openEmitted,
      type: 'handoff-open',
      actor,
      v: ENVELOPE_VERSION,
      summary: h.summary || '',
      done: h.done || null,
      todo: h.todo || null,
      blocked: h.blocked || null,
      topics: h.topics || null,
      source: h.source || 'agent',
      session_entries: sessionEntries,
      session_commits: sessionCommits,
      docs: h.docs || null,
    };
    // promoted_log_id is a 6th relation in real stores; stamp it remapped so the
    // log stays lossless even though the current fold drops it (Friction).
    if (h.promoted_log_id != null) open.promoted_log_id = logEid.get(h.promoted_log_id);
    events.push(open);

    if (h.status === 'closed') {
      const closeEmitted = new Date(HANDOFF_EPOCH + handoffEmitSeq).toISOString();
      handoffEmitSeq += 1;
      events.push({
        eid: ulid(tsToMillis(h.closed_at || h.timestamp)),
        ts: h.closed_at || h.timestamp,
        emitted_at: closeEmitted,
        type: 'handoff-close',
        actor,
        v: ENVELOPE_VERSION,
        handoff: heid,
      });
    }
  }

  return events;
}

// ── idempotency ───────────────────────────────────────────────────────────────

// A store is "already migrated" iff db.sqlite has been renamed to
// legacy-db.sqlite — the migration-specific, irreversible marker. We do NOT key
// on events.jsonl alone: STAGING DRIFT means the P0 tracer (log.js, always on)
// writes an events.jsonl on every `pebbl log`, so a bare events.jsonl is the
// PARTIAL tracer log, not a completed migration. Keying on it would refuse to
// migrate every real store. legacy-db.sqlite present == db.sqlite renamed away
// == this migrator already ran (the contract's idempotency: no duplicate
// events, no re-rename). See Friction.
function alreadyMigrated(pebblDir) {
  return fs.existsSync(path.join(pebblDir, LEGACY_DB));
}

// ── plan rendering (dry-run) ──────────────────────────────────────────────────

function renderPlan(report, eventCount, apply) {
  const lines = [];
  lines.push('pebbl migrate-to-events — ' + (apply ? 'APPLY' : 'DRY-RUN (no changes written)'));
  lines.push('');
  lines.push('Audit (same snapshot):');
  lines.push(`  logs:                 ${report.logs}`);
  lines.push(`  commits:              ${report.commits}`);
  lines.push(`  handoffs:             ${report.handoffs}`);
  lines.push(`  logs.relates_to:      ${report.relatesTo} (resolved)`);
  lines.push(`  logs.corrects:        ${report.corrects} (-> correct events)`);
  lines.push(`  free-text corrections:${report.corrections} (-> plain append, Q1=A)`);
  lines.push(`  promoted_log_id:      ${report.promotedLogId} (resolved)`);
  lines.push(`  session_entries refs: ${report.sessionEntries} (per-element resolved)`);
  lines.push(`  session_commits refs: ${report.sessionCommits} (per-element resolved)`);
  lines.push('');
  lines.push('Plan:');
  lines.push(`  would write ${eventCount} events to events.jsonl`);
  lines.push('  would rename db.sqlite -> legacy-db.sqlite');
  if (!apply) {
    lines.push('');
    lines.push('Nothing was written. Re-run with --apply to migrate.');
  }
  return lines.join('\n');
}

// ── command entrypoint ────────────────────────────────────────────────────────

module.exports = function migrateToEvents(args = []) {
  const apply = wantsApply(args);
  const pebblDir = requirePebblDir();

  // Idempotency: an already-migrated store is a safe no-op in BOTH modes.
  if (alreadyMigrated(pebblDir)) {
    console.log('pebbl migrate-to-events: store already migrated (events.jsonl / legacy-db.sqlite present) — no-op.');
    return;
  }

  const dbPath = path.join(pebblDir, 'db.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error('pebbl migrate-to-events: no db.sqlite to migrate.');
    process.exit(1);
  }

  // One read-only snapshot drives BOTH the audit and the build.
  const db = new Database(dbPath, { readonly: true });
  let snapshot;
  let report;
  let events;
  try {
    snapshot = readSnapshot(db);
    // Audit first — abort the whole store on ANY dangling reference, BEFORE any
    // event is built or written (no partial events.jsonl).
    report = auditForeignKeys(snapshot);
    const maps = buildIdMaps(snapshot);            // map-first, all eids minted
    const actor = resolveActor(pebblDir);
    events = buildEvents(snapshot, maps, actor);   // remap pass
  } catch (err) {
    db.close();
    if (err instanceof MigrationAbort) {
      console.error(`pebbl migrate-to-events: ABORT — ${err.message}`);
      console.error('No events.jsonl written; db.sqlite untouched.');
      process.exit(1);
    }
    throw err;
  }
  db.close();

  if (!apply) {
    console.log(renderPlan(report, events.length, false));
    return;
  }

  // Real run: serialize the whole write+rename under the per-store lock so a
  // concurrent local write can't interleave. The appender enforces the
  // trailing-newline invariant on every line (one event = one LF-terminated
  // line = one diff hunk).
  let movedTracer = false;
  withLock(pebblDir, () => {
    // Re-check inside the lock: another writer may have migrated while we built.
    if (alreadyMigrated(pebblDir)) {
      console.log('pebbl migrate-to-events: store already migrated (raced) — no-op.');
      return;
    }
    // Move the P0 tracer events.jsonl aside so the canonical migration log is
    // written fresh (not appended onto the tracer, which would double-count the
    // logs the tracer already wrote with throwaway eids). ADDITIVE — the tracer
    // is preserved as a .bak, never deleted.
    const evFile = eventsPath(pebblDir);
    if (fs.existsSync(evFile)) {
      fs.renameSync(evFile, path.join(pebblDir, TRACER_BAK));
      movedTracer = true;
    }
    for (const ev of events) {
      appendEvent(pebblDir, ev);
    }
    // ADDITIVE: never delete db.sqlite — rename to the rollback artifact.
    fs.renameSync(dbPath, path.join(pebblDir, LEGACY_DB));
  });

  console.log(renderPlan(report, events.length, true));
  console.log('');
  console.log(`Wrote ${events.length} events to events.jsonl; db.sqlite -> ${LEGACY_DB}.`);
  if (movedTracer) console.log(`Preserved the P0 tracer log as ${TRACER_BAK}.`);
};

// Exported for tests (pure pieces, no I/O): the audit, the map builder, the
// event builder, and the abort type.
module.exports.auditForeignKeys = auditForeignKeys;
module.exports.buildIdMaps = buildIdMaps;
module.exports.buildEvents = buildEvents;
module.exports.readSnapshot = readSnapshot;
module.exports.MigrationAbort = MigrationAbort;
module.exports.LEGACY_DB = LEGACY_DB;
