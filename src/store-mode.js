'use strict';
// P6 — the coexistence fork. The design names exactly one structural net-new
// rule for a partially-migrated fleet (notes/design-event-sourcing-2026-06-17.md:54):
//
//   "Format is per-store so migrated + legacy coexist
//    (path picked by presence of `events.jsonl`)."
//
// `storeMode(pebblDir)` IS that path-picker. It is PURE and READ-ONLY: no DB
// open, no walk-up (the caller already has the .pebbl dir, e.g. from
// find-pebbl.findPebblDir), no migration side effect, no write. It returns:
//   'events'  — events.jsonl is the COMPLETE representation -> route reads
//               through the fold path.
//   'legacy'  — read the canonical db.sqlite directly (lossless).
//
// WHY THIS IS A COMPLETENESS PREDICATE, NOT A PRESENCE TEST (the bug it fixes):
// `pebbl log` ALWAYS appends a P0 tracer event to events.jsonl (log.js, on every
// call), while db.sqlite stays canonical. So the FIRST `pebbl log` on ANY legacy
// store materializes a tiny tracer events.jsonl next to a complete db.sqlite. A
// bare-presence test (the old `fs.existsSync`) then routes reads to a fold built
// from those few tracer events and SILENTLY HIDES the historical db.sqlite rows.
// The fork must say 'events' ONLY when events.jsonl is the complete store; a
// partial tracer must read db.sqlite (lossless). Every fall-through below is the
// SAFE direction ('legacy' = read canonical db.sqlite), so this predicate can
// only ever UNDER-fold — it can fall back to db.sqlite, it can never drop a
// store's own history. That is what makes reads-from-fold safe to re-promote.
//
// ADDITIVE-ONLY guarantee (Acceptance #2): a legacy store that never grew an
// events.jsonl short-circuits at step 1 to 'legacy' BEFORE any marker read or
// git spawn — byte-identical to the pre-change path, no new I/O, no subprocess.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EVENTS_FILE = 'events.jsonl';
// The migrator's irreversible idempotency marker: db.sqlite is renamed to this
// on a completed `migrate-to-events --apply` (migrate-to-events.js). Its
// presence == this store was migrated == events.jsonl is canonical. It SURVIVES
// compaction (compact.js re-creates db.sqlite but never touches legacy-db.sqlite),
// which is why keying on it (not on "db.sqlite absent") classifies a compacted
// migrated store correctly.
const LEGACY_DB = 'legacy-db.sqlite';
// The positive completeness marker. A NEW sibling file (NOT a .gitignore entry,
// NOT an events.jsonl envelope field). Written by `init --shared` and
// `migrate-to-events --apply`. In shared mode it is COMMITTED so clones pull it.
const EVENTS_CANONICAL_MARKER = '.events-canonical';

// Is events.jsonl git-IGNORED for the store at `pebblDir`? Returns:
//   true   — git says the path is ignored (exit 0): a private/local tracer.
//   false  — git says NOT ignored (exit 1): a shared/committed store.
//   null   — git could not answer (not a repo, git missing, any error / exit
//            code other than 0|1): caller must fail to the SAFE direction.
// We spawn `git check-ignore` with cwd = the store's working tree (parent of
// .pebbl) so git resolves the repo + .gitignore exactly as the user's git would.
function eventsJsonlIgnored(pebblDir) {
  const workdir = path.dirname(pebblDir);
  const rel = path.join(path.basename(pebblDir), EVENTS_FILE); // e.g. .pebbl/events.jsonl
  try {
    // exit 0 => the path IS ignored. execFileSync throws on any non-zero exit.
    execFileSync('git', ['check-ignore', '-q', rel], {
      cwd: workdir,
      stdio: 'ignore',
    });
    return true; // exited 0
  } catch (err) {
    // exit 1 is git's "the path is NOT ignored" — a normal, meaningful answer.
    if (err && err.status === 1) return false;
    // Any other status (128 not-a-repo, spawn ENOENT, etc.) is unknown -> null,
    // so the caller routes to the SAFE 'legacy' direction. We NEVER return
    // 'events' off a git failure.
    return null;
  }
}

// Priority-ordered COMPLETENESS predicate. Order matters: cheaper/safer signals
// first, the git subprocess last, and every fall-through lands on 'legacy'.
function storeMode(pebblDir) {
  if (!pebblDir) return 'legacy';

  // Step 1 — no events.jsonl => 'legacy'. SHORT-CIRCUIT before any marker read
  // or git spawn so legacy stores are byte-identical and spawn nothing.
  if (!fs.existsSync(path.join(pebblDir, EVENTS_FILE))) return 'legacy';

  // Step 2 — legacy-db.sqlite present => 'events'. The migrator renamed
  // db.sqlite away; events.jsonl is the canonical, completed migration. Survives
  // compaction, so this (not "db.sqlite absent") is the post-compaction signal.
  if (fs.existsSync(path.join(pebblDir, LEGACY_DB))) return 'events';

  // Step 3 — the positive marker present => 'events'. Written by init --shared
  // and migrate --apply; the primary signal for fresh shared stores so the
  // shared path does not depend on a per-read git spawn.
  if (fs.existsSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER))) return 'events';

  // Step 4 — defensive backfill for already-shared stores that predate the
  // marker: if events.jsonl is NOT git-ignored, it is committed => shared =>
  // 'events'. ANY git failure (not-a-repo, git missing, unexpected exit) is
  // treated as unknown and falls through to step 5 — the SAFE direction. A git
  // error NEVER yields 'events'.
  if (eventsJsonlIgnored(pebblDir) === false) return 'events';

  // Step 5 — a gitignored / unmigrated / unmarked events.jsonl is the P0 tracer
  // (PARTIAL). Serve the canonical db.sqlite, lossless. This is the sw-factory
  // regression case.
  return 'legacy';
}

module.exports = { storeMode, EVENTS_FILE, EVENTS_CANONICAL_MARKER, LEGACY_DB };
