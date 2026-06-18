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

const EVENTS_FILE = 'events.jsonl';
const ENVELOPE_VERSION = 1;

function eventsPath(pebblDir) {
  return path.join(pebblDir, EVENTS_FILE);
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

// Build an `append` event envelope. Caller supplies the domain fields; we
// stamp identity (eid), the two time dimensions (ts = domain time, the old
// logs.timestamp; emitted_at = append time, the tie-break), actor, and the
// envelope version.
function makeAppendEvent(pebblDir, { ts, category, tier, message, topics, actor }) {
  const now = new Date();
  return {
    eid: ulid(now.getTime()),
    ts: ts || now.toISOString(),
    emitted_at: now.toISOString(),
    type: 'append',
    actor: actor || resolveActor(pebblDir),
    v: ENVELOPE_VERSION,
    category: category || 'uncategorized',
    tier: tier || 'detail',
    message: message || '',
    topics: Array.isArray(topics)
      ? topics
      : (topics ? String(topics).split(',').map((t) => t.trim()).filter(Boolean) : []),
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
// so the new line is always its own diff hunk.
function appendEvent(pebblDir, event) {
  const file = eventsPath(pebblDir);
  repairTrailingNewline(file);
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(file, line);
  return event;
}

// Read events.jsonl into parsed objects. Skips blank lines. A torn final
// line (no trailing newline) is tolerated on read — JSON.parse still
// succeeds on a complete-but-unterminated object; we just don't let it
// stay torn when we next append. Throws on a genuinely malformed line so
// corruption is loud, never silent.
function readEvents(pebblDir) {
  const file = eventsPath(pebblDir);
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

// Deterministic fold: events[] -> view rows. P0 handles ONLY `append`.
// Determinism is load-bearing: file/line order is irrelevant because we
// sort by (ts, emitted_at, eid). eid is the final tie-break and is globally
// unique, so the order is total — folding the same events twice, in any
// input order, yields byte-identical rows. This is a NEW events->rows
// reduction, not a db read.
function fold(events) {
  const appends = events.filter((e) => e && e.type === 'append');
  appends.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.emitted_at !== b.emitted_at) return a.emitted_at < b.emitted_at ? -1 : 1;
    if (a.eid !== b.eid) return a.eid < b.eid ? -1 : 1;
    return 0;
  });
  return appends.map((e) => ({
    eid: e.eid,
    timestamp: e.ts,
    actor: e.actor || '',
    category: e.category || 'uncategorized',
    tier: e.tier || 'detail',
    message: e.message || '',
    // Normalize topics back to the comma-joined string the rest of pebbl
    // uses (logs.topics is TEXT), so a folded row matches the existing row
    // shape referenced by regenerateMarkdown (compact.js:114-130).
    topics: Array.isArray(e.topics) ? e.topics.join(',') : (e.topics || ''),
    actorTopics: Array.isArray(e.topics) ? e.topics.slice() : [],
  }));
}

// High-level entry: append one `append` event and rebuild the view inline,
// the whole thing serialized by the per-store lock so a concurrent local
// write can't interleave. `rebuild` is injected by the caller (log.js)
// because the view-rebuild target (markdown/sqlite projection) lives there;
// keeping fold/append decoupled from the projection keeps this module
// reusable for later phases. Returns { event, rows }.
function appendLogEvent(pebblDir, fields, rebuild) {
  return withLock(pebblDir, () => {
    const event = makeAppendEvent(pebblDir, fields);
    appendEvent(pebblDir, event);
    const rows = fold(readEvents(pebblDir));
    if (typeof rebuild === 'function') rebuild(rows);
    return { event, rows };
  });
}

module.exports = {
  EVENTS_FILE,
  ENVELOPE_VERSION,
  eventsPath,
  resolveActor,
  makeAppendEvent,
  repairTrailingNewline,
  appendEvent,
  readEvents,
  fold,
  appendLogEvent,
};
