'use strict';
// Append-only event log — the P0 tracer for inverting pebbl's source of
// truth from binary db.sqlite to a committed text `events.jsonl`.
//
// This is ADDITIVE. db.sqlite stays canonical for now; this file writes an
// `events.jsonl` alongside it and folds it back to rows so the load-bearing
// claim — append-only text merges cleanly under git — can be proven before
// any migration work. P0 handles exactly ONE event type: `append`.
//
// The two hard-won invariants (both failure modes were reproduced during
// design) live here:
//   1. union-merge needs `.pebbl/events.jsonl merge=union` (installed by
//      init) — without it two appends after the same last line CONFLICT.
//   2. The trailing-newline invariant — without it `union` can splice a
//      torn last line into a second line, producing unparseable JSON with
//      exit 0 and no conflict markers. So before every append we repair a
//      missing final newline (a "torn last line").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ulid } = require('./ulid');
const { withLock } = require('./lock');
const { fold, foldFull } = require('./fold');

const EVENTS_FILE = 'events.jsonl';
// P5 — the PRIVATE half of the two-file split. `events.jsonl` is committed
// (shared, git-transported); `events.local.jsonl` is ALWAYS gitignored and
// never leaves the machine. The fold reads BOTH and unions; git only ever
// carries the shared file. Foundation-tier entries route here by default on a
// public remote (private-by-default), unless `--share` opts them into the
// shared file. This is the documented P5 read-split seam: P1 left readEvents
// single-file, so P5 adds the second-file read at the read entry ONLY — the
// reducer (fold.js) is untouched, it still just receives an events[] array.
const LOCAL_EVENTS_FILE = 'events.local.jsonl';
const ENVELOPE_VERSION = 1;

function eventsPath(pebblDir) {
  return path.join(pebblDir, EVENTS_FILE);
}

function localEventsPath(pebblDir) {
  return path.join(pebblDir, LOCAL_EVENTS_FILE);
}

// actor = <git user.email-short>@<hostname>. The author+source dimension
// shared-write adds, so a folded view can attribute every entry. Email is
// resolved from git config; we take the local-part (before @) to keep it
// short and fall back to $USER if git has no email configured.
function resolveActor(pebblDir) {
  let emailShort = process.env.USER || 'unknown';
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: pebblDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (email) emailShort = email.split('@')[0] || email;
  } catch {
    // no git / no email configured — keep the $USER fallback
  }
  const host = (os.hostname() || 'host').split('.')[0];
  return `${emailShort}@${host}`;
}

// Stamp the shared envelope head every event carries: identity (eid), the two
// time dimensions (ts = domain time, the old logs.timestamp; emitted_at =
// append time, the tie-break), type, actor, and the envelope version. Every
// maker below builds ON this one head — one event format, one place to change
// it (DRY). `now` is shared so eid's time prefix and emitted_at agree.
function makeEnvelope(pebblDir, type, { ts, actor } = {}) {
  const now = new Date();
  return {
    eid: ulid(now.getTime()),
    ts: ts || now.toISOString(),
    emitted_at: now.toISOString(),
    type,
    actor: actor || resolveActor(pebblDir),
    v: ENVELOPE_VERSION,
  };
}

// Build an `append` event envelope. Caller supplies the domain fields; the
// envelope head (eid/ts/emitted_at/actor/v) comes from makeEnvelope.
function makeAppendEvent(pebblDir, { ts, category, tier, message, topics, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'append', { ts, actor }),
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: Array.isArray(topics)
      ? topics
      : (topics ? String(topics).split(',').map((t) => t.trim()).filter(Boolean) : []),
  };
}

// Compaction event makers (P3). Each is a pure append onto the log — the
// destructive INSERT/DELETE/UPDATE transaction in compact.js becomes a small
// batch of these. The fold (src/fold.js) is the ONLY reader; these field names
// match exactly what its reducer consumes, so they must not drift:
//   - supersede: `rolls_up:[eid...]` are the source entries this rollup hides;
//     the event itself carries the rollup row's category/tier/message/topics
//     (fold.js emits the surviving rollup row straight off the event). The fold
//     dedups two supersedes that share a rolls_up eid by keeping the
//     lexicographically-smaller eid, so a double compaction is ugly, not broken.
//   - resolve: `target` = the eid whose tier this resolve changes in place
//     (replaces compact.js's UPDATE logs SET tier=...), `tier` the new tier
//     (default 'foundation', matching the old --resolve id:foundation path).
//   - expire: `target` = the eid this removes from the live set (replaces the
//     DELETE of an expired fleeting entry / a --resolve id:rollup drop).
function makeSupersedeEvent(pebblDir, { ts, rolls_up, category, tier, message, topics, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'supersede', { ts, actor }),
    rolls_up: Array.isArray(rolls_up) ? rolls_up.slice() : [],
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: topics == null ? '' : String(topics),
  };
}

function makeResolveEvent(pebblDir, { ts, target, to_tier, tier, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'resolve', { ts, actor }),
    target: target || null,
    tier: tier || to_tier || 'foundation',
  };
}

function makeExpireEvent(pebblDir, { ts, target, actor }) {
  return {
    ...makeEnvelope(pebblDir, 'expire', { ts, actor }),
    target: target || null,
  };
}

// Enforce the trailing-newline invariant and repair a torn final line.
// If the file exists and its last byte is NOT '\n', a previous write (or a
// union merge) left a partial line; we append a '\n' to close it off BEFORE
// the next append, so the new event can never be spliced onto a dangling
// line. Every committed line ends in exactly one LF and is independently
// valid JSON.
function repairTrailingNewline(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return; // nothing to repair
    throw err;
  }
  if (st.size === 0) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, st.size - 1);
    if (buf[0] !== 0x0a) {
      // torn last line: close it with a newline
      fs.writeSync(fd, '\n', st.size);
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Append a single event as one LF-terminated JSON line. Low-level: assumes
// the caller already holds the store lock. Repairs a torn final line first
// so the new line is always its own diff hunk. `opts.local` targets the PRIVATE
// events.local.jsonl (P5 private-by-default) instead of the shared file; the
// trailing-newline / torn-line invariant (P0) applies to BOTH files identically.
function appendEvent(pebblDir, event, opts = {}) {
  const file = opts.local ? localEventsPath(pebblDir) : eventsPath(pebblDir);
  repairTrailingNewline(file);
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(file, line);
  return event;
}

// Parse one events file into objects. Skips blank lines. A torn final line is
// tolerated on read. Throws on a genuinely malformed line so corruption is loud.
// Missing file => []. Shared by readEvents for each half of the split.
function readEventsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`pebbl: malformed event on line ${i + 1} of ${file}: ${err.message}`);
    }
  }
  return events;
}

// Read the FULL event stream: the shared events.jsonl UNIONed with the private
// events.local.jsonl (P5 two-file split). The fold sorts by (ts, emitted_at,
// eid), so concatenation order doesn't matter — local + shared events interleave
// deterministically and the local entries surface in the view exactly like
// shared ones. git only ever transports the shared file; the local file is
// machine-private. eids are globally unique, so there's no collision risk in
// the union. This is the ONLY change the split needs on the read side — the
// reducer in fold.js is untouched.
function readEvents(pebblDir) {
  const shared = readEventsFile(eventsPath(pebblDir));
  const local = readEventsFile(localEventsPath(pebblDir));
  if (local.length === 0) return shared;
  return shared.concat(local);
}

// Deterministic fold: events[] -> view rows. As of P1 the real reducer lives
// in src/fold.js (full 8-type event set, supersession hiding, eid->local-int
// FK translation, the view.sqlite + markdown emitters). It is imported above
// and RE-EXPORTED here so it is reachable from BOTH `require('./events').fold`
// (P3 gates on this) and `require('./fold').fold` (P2/P4/P5/P6 gate on it) —
// both resolve to the exact same reducer; the sequential chain breaks if they
// diverge. `fold` and `foldFull` are the imported references (see top of file).

// High-level entry: append one `append` event and rebuild the view inline,
// the whole thing serialized by the per-store lock so a concurrent local
// write can't interleave. `rebuild` is injected by the caller (log.js)
// because the view-rebuild target (markdown/sqlite projection) lives there;
// keeping fold/append decoupled from the projection keeps this module
// reusable for later phases. Returns { event, rows }.
function appendLogEvent(pebblDir, fields, rebuild, opts = {}) {
  return withLock(pebblDir, () => {
    const event = makeAppendEvent(pebblDir, fields);
    // P5: a private entry (foundation, private-by-default on a public remote,
    // no --share) is appended to events.local.jsonl; everything else to the
    // shared events.jsonl. The fold reads BOTH via readEvents, so the row shows
    // up in the view either way — only the git-transport side differs.
    appendEvent(pebblDir, event, { local: !!opts.local });
    const rows = fold(readEvents(pebblDir));
    if (typeof rebuild === 'function') rebuild(rows);
    return { event, rows };
  });
}

// Append a BATCH of pre-built events as one atomic-ish unit and rebuild once.
// Compaction (P3) emits many supersede/resolve/expire events for one --execute
// run; appending them under a SINGLE lock + a SINGLE fold/rebuild is the
// append-only replacement for the old db.transaction (one critical section,
// one view rebuild). Each line still goes through appendEvent, so the
// trailing-newline / torn-line invariant (P0) guards every one — if the batch
// is interrupted mid-write, the next append/fold repairs the torn final line
// and the already-written events stand (no rollback needed, and none possible:
// the log is the durable record). `rebuild(rows)` is injected by the caller so
// events.js stays decoupled from the projection target. Returns {events, rows}.
function appendEventBatch(pebblDir, events, rebuild) {
  return withLock(pebblDir, () => {
    for (const event of events) {
      appendEvent(pebblDir, event);
    }
    const rows = fold(readEvents(pebblDir));
    if (typeof rebuild === 'function') rebuild(rows);
    return { events, rows };
  });
}

module.exports = {
  EVENTS_FILE,
  LOCAL_EVENTS_FILE,
  ENVELOPE_VERSION,
  eventsPath,
  localEventsPath,
  readEventsFile,
  resolveActor,
  makeEnvelope,
  makeAppendEvent,
  makeSupersedeEvent,
  makeResolveEvent,
  makeExpireEvent,
  repairTrailingNewline,
  appendEvent,
  appendEventBatch,
  readEvents,
  fold,
  foldFull,
  appendLogEvent,
};
