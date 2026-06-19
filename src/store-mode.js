'use strict';
// P6 — the coexistence fork. The design names exactly one structural net-new
// rule for a partially-migrated fleet (notes/design-event-sourcing-2026-06-17.md:54):
//
//   "Format is per-store so migrated + legacy coexist
//    (path picked by presence of `events.jsonl`)."
//
// `storeMode(pebblDir)` IS that path-picker. It is PURE and READ-ONLY: a single
// fs.existsSync on `<pebblDir>/events.jsonl`. No walk-up (the caller already has
// the .pebbl dir, e.g. from find-pebbl.findPebblDir), no DB open, no migration
// side effect, no write. It returns:
//   'events'  — events.jsonl is present  -> route reads through the fold path.
//   'legacy'  — events.jsonl is absent    -> the store is unchanged db.sqlite-truth.
//
// ADDITIVE-ONLY guarantee (Acceptance #2): for a legacy store (no events.jsonl)
// this returns 'legacy' and the existing read path is untouched. Adding this
// helper does not change any behavior of a store that never grew an
// events.jsonl. It only LETS a caller branch when one IS present.
//
// SCOPE NOTE: a bare events.jsonl can be the P0 TRACER log (log.js appends an
// `append` event on every `pebbl log`), which is a partial, not-yet-canonical
// log. The design's coexistence contract is presence-of-file, and the migrator
// keys idempotency on legacy-db.sqlite (migrate-to-events.js:344-354), NOT on
// events.jsonl, precisely because of this. `storeMode` reports the on-disk
// FORMAT FORK only ('does a fold-able log exist?'); whether that log is a
// completed migration vs a tracer is the migrator's concern, not this fork's.
// See Friction.

const fs = require('fs');
const path = require('path');

const EVENTS_FILE = 'events.jsonl';

function storeMode(pebblDir) {
  if (!pebblDir) return 'legacy';
  return fs.existsSync(path.join(pebblDir, EVENTS_FILE)) ? 'events' : 'legacy';
}

module.exports = { storeMode, EVENTS_FILE };
