'use strict';
// `pebbl rebuild` (P4) — explicit, forced rebuild of the disposable view from
// the canonical events.jsonl. The view (view.sqlite + the 4 markdown files) is
// normally kept current LAZILY on the read path (src/staleness.js, wired into
// openDb), so a manual rebuild is rarely needed; this command is the escape
// hatch for "rebuild now" — after a hand-edit/repair of events.jsonl, to clear
// a stuck sentinel, or to force-refresh in a script.
//
// It does exactly what the lazy path does, unconditionally:
//   1. Acquire the P0 per-store lockfile (src/lock.js withLock) so a concurrent
//      local append can't interleave with the rebuild — we EXTEND the existing
//      lock, we do not introduce a second one.
//   2. Fold the whole events.jsonl via the P1 fold (src/view.js rebuildView ->
//      src/fold.js) into view.sqlite + the 4 markdown files.
//   3. Stamp folded_through in view.sqlite's meta table so the next read takes
//      the fast 'fresh' path (src/staleness.js writeWatermark / currentState).
//   4. Clear the .rebuild-needed sentinel the git hooks touch.
//   5. Kick the DEFERRED (background) qmd reindex — never inline, so rebuild
//      stays fast and qmd stays off the hot path (the whole point of P4).

const fs = require('fs');
const path = require('path');
const { requirePebblDir } = require('./find-pebbl');
const { withLock } = require('./lock');
const { readEvents } = require('./events');
const { rebuildView } = require('./view');
const { currentState, writeWatermark } = require('./staleness');
const { qmdUpdateDeferred } = require('./qmd');

const SENTINEL = '.rebuild-needed';

module.exports = function rebuild() {
  const pebblDir = requirePebblDir();

  const result = withLock(pebblDir, () => {
    const events = readEvents(pebblDir);
    rebuildView(pebblDir, events);
    const state = currentState(pebblDir);
    if (state) writeWatermark(pebblDir, state);
    // Clear the hook-touched sentinel — the rebuild it asked for just ran.
    try { fs.unlinkSync(path.join(pebblDir, SENTINEL)); } catch { /* absent, fine */ }
    return events.length;
  });

  // qmd reindex runs in the background so `pebbl rebuild` returns fast and qmd
  // stays off the synchronous path (P4). A few-seconds-stale BM25 index is fine.
  qmdUpdateDeferred(pebblDir);

  console.log(`pebbl: rebuilt view from ${result} event${result === 1 ? '' : 's'}.`);
};
