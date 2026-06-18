'use strict';
// P4 — lazy staleness: keep view.sqlite + the 4 markdown files current with
// events.jsonl WITHOUT a manual rebuild, and without re-folding when nothing
// changed. The read path (db.js openDb) calls ensureFresh() before handing back
// a handle; a post-merge/post-checkout that pulled new events.jsonl lines is
// picked up on the very next pebbl command, lazily, never inside the git hook.
//
// `folded_through` (stored in view.sqlite's `meta` table) is the watermark the
// last fold reached:
//   - eid    : the last event's eid at fold time (identity of the tail)
//   - offset : events.jsonl byte length at fold time (where the tail ended)
//   - fp     : a CHEAP fingerprint of the PREFIX [0, offset) — its byte length
//              plus a sha1 of those bytes. This is what distinguishes a pure
//              APPEND (prefix unchanged, file only grew) from a changed PREFIX
//              (a union merge / rebase rewrote earlier lines), which is the
//              tail-only-vs-full-replay decision.
//
// Decision table (compareState):
//   - no events.jsonl / empty           -> 'none'  (nothing to fold)
//   - no stored watermark               -> 'full'  (first ever fold)
//   - size == offset && fp matches      -> 'fresh' (no fold — the fast path)
//   - size  > offset && prefix fp match -> 'tail'  (pure append: fold forward)
//   - prefix changed (fp mismatch) or
//     size  < offset (truncated/rewrit) -> 'full'  (replay the whole log)
//
// The P1 fold (src/fold.js, via src/view.js rebuildView) is whole-log and
// deterministic; 'tail' still re-reads the full log because supersession/FK
// translation need every prior event, but it is gated behind the cheap
// fingerprint so an unchanged store does ZERO fold work — that is the real win
// (a post-pull never blocks the next read with a needless reindex). The 'tail'
// vs 'full' split is kept as a first-class, tested decision because a CHANGED
// PREFIX must force a full replay (an incremental folder could not trust the
// stale prefix), and P6's cutover reads this state.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { withLock, isLocked } = require('./lock');
const { eventsPath, readEvents } = require('./events');

const META_KEY = 'folded_through';

function viewPath(pebblDir) {
  return path.join(pebblDir, 'view.sqlite');
}

// Cheap fingerprint of the prefix [0, len) of events.jsonl: a sha1 over exactly
// those bytes. Combined with the byte length this catches any in-place rewrite
// of an already-folded line (union merge of a torn line, a rebase) while a pure
// append leaves it identical. Reads only the prefix, not the (possibly large)
// tail, so it stays cheap.
function prefixFingerprint(file, len) {
  if (len <= 0) return crypto.createHash('sha1').update('').digest('hex');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, read)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// Current on-disk tail state of events.jsonl: byte size, last event's eid, and
// the whole-file fingerprint. Returns null when there is no log to fold.
function currentState(pebblDir) {
  const file = eventsPath(pebblDir);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (size === 0) return null;
  const events = readEvents(pebblDir);
  const last = events.length ? events[events.length - 1] : null;
  return {
    eid: last ? (last.eid || '') : '',
    offset: size,
    fp: prefixFingerprint(file, size),
    count: events.length,
  };
}

// Read the stored watermark from view.sqlite's meta table. Returns null if the
// view (or the row) doesn't exist yet — both mean "never folded".
function readWatermark(pebblDir) {
  const vp = viewPath(pebblDir);
  if (!fs.existsSync(vp)) return null;
  let db;
  try {
    db = new Database(vp, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(META_KEY);
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch {
    // meta table absent (older view) or unparseable -> treat as never folded.
    return null;
  } finally {
    db.close();
  }
}

// Stamp the watermark into view.sqlite's meta table. Called right after a fold
// rebuilds the view, so the next read sees a matching prefix and takes the
// fast 'fresh' path. writeViewSqlite recreates the file (and its meta table)
// on every rebuild, so this re-stamps each time — by design.
function writeWatermark(pebblDir, state) {
  const vp = viewPath(pebblDir);
  const db = new Database(vp);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(META_KEY, JSON.stringify({ eid: state.eid, offset: state.offset, fp: state.fp }));
  } finally {
    db.close();
  }
}

// Pure decision: given the stored watermark and the current on-disk state,
// which fold (if any) does the next read need? Exported for the unit tests so
// the tail-vs-full split is asserted directly, no timing involved.
function compareState(watermark, state) {
  if (!state) return 'none';
  if (!watermark) return 'full';
  // Truncated or shrunk below the watermark -> the prefix can't be trusted.
  if (state.offset < watermark.offset) return 'full';
  // Up-to-date: same size AND identical bytes.
  if (state.offset === watermark.offset) {
    return state.fp === watermark.fp ? 'fresh' : 'full';
  }
  // Grew: pure append iff the prefix [0, watermark.offset) is byte-identical to
  // what we folded last time. The caller computes that prefix fingerprint
  // against the CURRENT file and passes it as state.prefixFp. Match -> only new
  // lines were appended -> 'tail'; mismatch -> an earlier line changed -> 'full'.
  if (state.prefixFp != null) {
    return state.prefixFp === watermark.fp ? 'tail' : 'full';
  }
  return 'full';
}

// The lazy entry point the read path calls. Cheap when the view is already
// fresh (a fingerprint compare, no fold). Folds the whole log via the P1 fold
// (view.rebuildView) on 'tail' or 'full', then re-stamps the watermark. The
// whole check+fold runs under the P0 per-store lock so a concurrent local
// append can't interleave with the rebuild. Returns the mode taken
// ('none'|'fresh'|'tail'|'full') so callers/tests can assert without timing.
//
// Importing view.js lazily (inside the function) avoids a require cycle:
// view.js -> fold.js, and db.js -> staleness.js is on the read path.
function ensureFresh(pebblDir) {
  // Re-entrancy guard: if this process already holds the store lock, we are
  // inside a write/rebuild (appendLogEvent / appendEventBatch / rebuild) — the
  // O_EXCL lock is not reentrant, so taking it again would deadlock against
  // ourselves. The in-flight write rebuilds the view anyway, so skipping here
  // is correct. This is what makes wiring ensureFresh into openDb safe.
  if (isLocked(pebblDir)) return 'skip-locked';

  const file = eventsPath(pebblDir);
  // Fast pre-check OUTSIDE the lock: if there's nothing to fold, or the view is
  // already current, skip the lock entirely (the common case on every read).
  const pre = currentState(pebblDir);
  if (!pre) return 'none';
  const wmPre = readWatermark(pebblDir);
  if (wmPre && pre.offset === wmPre.offset && pre.fp === wmPre.fp) return 'fresh';

  return withLock(pebblDir, () => {
    // Re-read inside the lock — a concurrent append may have changed the tail
    // between the pre-check and acquiring the lock.
    const state = currentState(pebblDir);
    if (!state) return 'none';
    const wm = readWatermark(pebblDir);
    // Compute the prefix fingerprint at the OLD offset against the CURRENT file
    // so compareState can tell pure-append from a changed prefix.
    if (wm && state.offset > wm.offset) {
      state.prefixFp = prefixFingerprint(file, wm.offset);
    }
    const mode = compareState(wm, state);
    if (mode === 'fresh' || mode === 'none') return mode;

    // 'tail' and 'full' both rebuild from the whole log (the P1 fold needs all
    // prior events for supersession + FK translation); the distinction is the
    // staleness DECISION, surfaced for tests and P6. Rebuild, then stamp.
    const { rebuildView } = require('./view');
    rebuildView(pebblDir, readEvents(pebblDir));
    writeWatermark(pebblDir, state);
    return mode;
  });
}

module.exports = {
  ensureFresh,
  compareState,
  currentState,
  readWatermark,
  writeWatermark,
  prefixFingerprint,
  viewPath,
  META_KEY,
};
