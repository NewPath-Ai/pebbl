'use strict';
// P6 — `pebbl cutover`: the per-store coexistence + cutover-runbook layer.
//
// This phase ORCHESTRATES P0-P5; it does NOT re-implement them. Two surfaces:
//
//   pebbl cutover --inventory   READ-ONLY. Walk the filesystem from a root for
//                               `.pebbl` store dirs and label each
//                               legacy / events / md-only. Never migrates,
//                               deletes, or writes into any discovered store
//                               (Acceptance #4). The migrator that flips a
//                               store is P2's `pebbl migrate-to-events`; this
//                               only reports WHICH stores exist and WHAT state
//                               they are in, so a human sequences the waves.
//
//   pebbl cutover --help        Print the wave-ordered cutover RUNBOOK below
//                               (Acceptance #5/#6): wave order + ~1-week soak,
//                               the Q4=B mirror+git rule, the legacy-db.sqlite
//                               retirement policy, and the HARD wave-0
//                               pre-flight (the --shared init toggle gap).
//
// The runbook text is the single source of truth for the rollout policy and
// lives ONLY here (DRY) — bin/pebbl.js routes `cutover --help` into this module
// instead of the generic help table so there is one copy to keep correct.

const fs = require('fs');
const path = require('path');
const { storeMode } = require('./store-mode');

// ── store classification (pure, from a directory listing) ─────────────────────
//
// A `.pebbl` dir is one of:
//   events    — events.jsonl present (migrated OR a P0 tracer log; either way
//               reads route through the fold path). storeMode() decides this.
//   legacy    — a migratable binary store: db.sqlite (un-migrated) OR
//               legacy-db.sqlite (the migrator's rollback artifact) present,
//               and NO events.jsonl. Still db.sqlite-truth.
//   md-only   — markdown projections but no migratable db and no events.jsonl.
//               Per the design risk note (line 78) lumr is this: it commits
//               only handoffs.md, has no db to migrate losslessly. The
//               inventory LABELS it; it never migrates it.
//
// Pure: takes the .pebbl dir path, does only fs.existsSync probes (no open, no
// write). The migrator's db.sqlite -> legacy-db.sqlite rename (P2,
// migrate-to-events.js:52) means a half-cut store can show BOTH legacy-db.sqlite
// and events.jsonl; events.jsonl presence wins (it is the canonical truth once
// written), so storeMode() is checked FIRST.
const MD_MARKERS = ['manual-logs.md', 'handoffs.md', 'commit-log.md', 'narrative.md'];

function classifyStore(pebblDir) {
  if (storeMode(pebblDir) === 'events') return 'events';
  const hasDb = fs.existsSync(path.join(pebblDir, 'db.sqlite'));
  const hasLegacyDb = fs.existsSync(path.join(pebblDir, 'legacy-db.sqlite'));
  if (hasDb || hasLegacyDb) return 'legacy';
  const hasMd = MD_MARKERS.some((m) => fs.existsSync(path.join(pebblDir, m)));
  if (hasMd) return 'md-only';
  // No db, no events, no md — an empty/uninitialized dir. Report it so the
  // operator sees it, but it is not migratable.
  return 'md-only';
}

// ── discovery (read-only filesystem walk) ─────────────────────────────────────
//
// Find `.pebbl` directories under `root`. The design says scan by the
// "db.sqlite-under-*.pebbl*" convention; we walk for the `.pebbl` dir itself
// (the store root) and classify by its contents. Bounded + safe:
//   - skip heavy/irrelevant dirs (node_modules, .git, the mirror/ subtree which
//     holds OTHER machines' read-only synced stores, archive/),
//   - depth-capped so a scan from $HOME can't wander forever,
//   - swallow EACCES/ENOENT on individual dirs (a store we can't read is
//     skipped, never crashes the inventory),
//   - PURELY readdir/stat — opens nothing, writes nothing, deletes nothing.
const SKIP_DIRS = new Set(['node_modules', '.git', 'mirror', 'archive']);
const DEFAULT_MAX_DEPTH = 8;

function findStores(root, maxDepth = DEFAULT_MAX_DEPTH) {
  const found = [];
  const seen = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      const full = path.join(dir, name);
      if (name === '.pebbl') {
        const real = (() => { try { return fs.realpathSync(full); } catch { return full; } })();
        if (!seen.has(real)) { seen.add(real); found.push(full); }
        continue; // do NOT descend into a store dir
      }
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.pebbl') continue; // skip other dotdirs
      walk(full, depth + 1);
    }
  }

  walk(root, 0);
  found.sort();
  return found;
}

function inventory(root) {
  const stores = findStores(root);
  return stores.map((p) => ({ pebblDir: p, mode: classifyStore(p) }));
}

function renderInventory(rows, root) {
  const lines = [];
  lines.push(`pebbl cutover --inventory — READ-ONLY scan under ${root}`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('No .pebbl stores found.');
    lines.push('');
    lines.push('(legacy / events / md-only — nothing to label here.)');
    return lines.join('\n');
  }
  lines.push(`Found ${rows.length} store(s). No store was migrated, deleted, or written to.`);
  lines.push('');
  const label = {
    legacy: 'legacy   (db.sqlite truth; eligible for migrate-to-events)',
    events: 'events   (events.jsonl present; reads route through the fold)',
    'md-only': 'md-only  (no migratable db; cannot migrate losslessly — label only)',
  };
  for (const r of rows) {
    lines.push(`  [${r.mode.padEnd(7)}] ${r.pebblDir}`);
    lines.push(`            ${label[r.mode] || r.mode}`);
  }
  lines.push('');
  lines.push('Labels: legacy / events / md-only. Inventory NEVER mutates a store.');
  lines.push('To migrate a legacy store, run `pebbl migrate-to-events` IN that store');
  lines.push('(dry-run by default). Sequence the waves per `pebbl cutover --help`.');
  return lines.join('\n');
}

// ── the cutover RUNBOOK ───────────────────────────────────────────────────────
//
// This is the authoritative rollout policy text. The Verify block greps it for
// `inventory|wave|soak|cutover` (help) and for `legacy-db.sqlite` + `soak|wave|
// mirror` (policy present), so the literal terms below are load-bearing.
const RUNBOOK = `pebbl cutover — fleet event-sourcing rollout runbook

WHAT THIS COMMAND DOES
  pebbl cutover --inventory   read-only: list every .pebbl store and label it
                              legacy / events / md-only. Mutates NOTHING.
  pebbl cutover --help        this runbook.

It does NOT migrate. P2's \`pebbl migrate-to-events\` (dry-run by default) is the
only thing that flips a store; cutover sequences WHICH store goes WHEN and
verifies post-cut read parity via the storeMode() fork (presence of
events.jsonl => the fold path; absent => legacy reads, unchanged).

──────────────────────────────────────────────────────────────────────────────
WAVE 0 — HARD PRE-FLIGHT (blocks every later wave; NOT yet satisfied)
──────────────────────────────────────────────────────────────────────────────
A store cannot actually "go shared" yet. P5's review found the --shared /
shared-mode init toggle was NEVER built by any phase: \`pebbl init\` still
gitignores ALL of .pebbl/ (DEFAULT = LOCAL), so events.jsonl is NOT committed by
default and git-as-transport carries nothing for a "shared" store. Therefore,
BEFORE any real store goes shared:
  PREREQUISITE: a \`--shared\` / \`--allow-public-memory\` init plumbing step MUST
  exist (relax the .pebbl/ blanket gitignore for events.jsonl on an explicit
  shared opt-in; keep events.local.jsonl always ignored). This is OUT OF P6
  SCOPE (it touches init.js's shared/local decision, which P6 must not modify)
  and is NOT built here — it is the gating dependency. Do not start Wave 1
  against a real remote until it lands.
Also pre-flight, per the design Precondition: run \`pebbl audit-history\` over the
store's committed .md history and clear (or accept) the rotation checklist
BEFORE the store is eligible for --shared. A leaked secret in append-only
shared memory can never un-leak; it must be ROTATED at source.

──────────────────────────────────────────────────────────────────────────────
WAVE ORDER (one store per wave; ~1-week soak between waves)
──────────────────────────────────────────────────────────────────────────────
  Wave 1  private throwaway TRACER repo (Q5=A) — prove clean multi-contributor
          merge end-to-end on a disposable store. NOT a real store.
  Wave 2  sw-factory — the FIRST REAL cutover (Q5=A). Highest-traffic store, so
          it surfaces fold/merge edge cases fastest. Soak ~1 week.
  Wave 3  security — soak ~1 week.
  Wave 4  lumr — md-only: it commits only handoffs.md and has no db to migrate
          losslessly (design risk line 78). LABEL it in the inventory; do NOT
          migrate it in this rollout. It rides legacy reads unchanged.
  Wave 5  harold — soak ~1 week.
  Wave 6  terraform-for-law — soak ~1 week.
Each wave: migrate ONE store (migrate-to-events --apply, after a clean dry-run),
soak ~1 week watching read parity (pebbl context / search return the same
entries + supersession hiding + recency order), then proceed. A bad wave rolls
back to legacy-db.sqlite (see RETIREMENT) — never forward.

──────────────────────────────────────────────────────────────────────────────
TRANSPORT DURING ROLLOUT (Q4=B — keep BOTH, collapse PER-STORE)
──────────────────────────────────────────────────────────────────────────────
Keep BOTH the cross-machine mirror AND git-as-transport running during rollout.
eids dedup double-delivery in the fold, so a store reached by BOTH the mirror
and a git pull is safe — the same event arriving twice folds once. Collapse to
git-only PER-STORE, only as THAT store actually goes shared (i.e. after Wave 0's
--shared plumbing exists and the store has opted in). The mirror is NOT turned
off in a flag day and NOT turned off in code here; mirror retirement is the
eventual END-STATE once every shared store transports cleanly over git, not a
switch thrown mid-rollout. Until a store is shared, it keeps using the mirror.

──────────────────────────────────────────────────────────────────────────────
RETIREMENT POLICY (legacy-db.sqlite)
──────────────────────────────────────────────────────────────────────────────
The migrator renames db.sqlite -> legacy-db.sqlite (it NEVER deletes the binary
store) as the rollback artifact. legacy-db.sqlite is retired (deleted) ONLY
after one stable release of that store on the event log — NEVER during a soak.
While a store is soaking, legacy-db.sqlite is the rollback source of truth: a
failed soak restores it. Retiring it early throws away the only lossless
rollback (committed markdown is explicitly lossy — no session_entries — so it is
NOT a rollback source). One stable release, then retire; not before.
`;

// ── command entrypoint ────────────────────────────────────────────────────────
//
// Routed from bin/pebbl.js. `--help` (or no flag) prints the runbook;
// `--inventory` runs the read-only scan. `--root <dir>` overrides the scan root
// (defaults to cwd) — used by tests to point at a tmp store.
module.exports = function cutover(args = []) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(RUNBOOK);
    return;
  }
  if (args.includes('--inventory')) {
    const rootIdx = args.indexOf('--root');
    const root = rootIdx !== -1 && args[rootIdx + 1] ? path.resolve(args[rootIdx + 1]) : process.cwd();
    console.log(renderInventory(inventory(root), root));
    return;
  }
  console.error('pebbl cutover: unknown option. Try `pebbl cutover --help` or `pebbl cutover --inventory`.');
  process.exit(1);
};

// Exported for tests (pure pieces — no I/O beyond read-only fs probes):
module.exports.classifyStore = classifyStore;
module.exports.findStores = findStores;
module.exports.inventory = inventory;
module.exports.renderInventory = renderInventory;
module.exports.RUNBOOK = RUNBOOK;
