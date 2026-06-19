'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
//
// storeMode() as a COMPLETENESS predicate (the reads-from-fold safety wire).
//
// THE BUG THIS GUARDS: `pebbl log` ALWAYS appends a P0 tracer event to
// events.jsonl while db.sqlite stays canonical. So the first `pebbl log` on any
// legacy store materializes a tiny tracer events.jsonl next to a complete
// db.sqlite. The OLD bare-presence storeMode() then returned 'events', routing
// reads to a fold built from those few tracer events and SILENTLY HIDING the
// historical db.sqlite rows. The fix: 'events' ONLY when events.jsonl is the
// COMPLETE store; a partial tracer reads db.sqlite (lossless). Every fall-through
// is the SAFE direction ('legacy'), so the predicate can only ever UNDER-fold.
//
// Priority-ordered predicate (store-mode.js):
//   step 1  no events.jsonl                     -> legacy (short-circuit, no spawn)
//   step 2  legacy-db.sqlite present            -> events (migrator idempotency)
//   step 3  .events-canonical marker present    -> events (init --shared / migrate)
//   step 4  events.jsonl NOT git-ignored        -> events (predates-marker backfill)
//   step 5  else (gitignored partial tracer)    -> legacy
//
// This file exercises all 5 steps and the 7 acceptance cases. The shared-mode
// keystone (Acceptance #4) lives in shared-mode.test.js and stays green there.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const { execFileSync } = child_process;

const { storeMode, EVENTS_FILE, EVENTS_CANONICAL_MARKER, LEGACY_DB } = require('../src/store-mode');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

// A throwaway working tree. `git` controls so step-4 check-ignore has a repo to
// resolve against; pass {git:false} to test the not-a-repo error path.
function tmpRepo({ git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-smc-'));
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  }
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  return { dir, pebblDir };
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function writeEvents(pebblDir, body = '{"type":"append"}\n') {
  fs.writeFileSync(path.join(pebblDir, EVENTS_FILE), body);
}
// Mark events.jsonl as gitignored via a blanket .pebbl/ rule (the default-init
// shape). Without this, a tracked-but-uncommitted file reads as NOT ignored.
function ignorePebbl(dir) {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.pebbl/\n');
}
// Un-ignore events.jsonl the way `init --shared` does (named ignores + negation).
function sharePebbl(dir) {
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    '.pebbl/db.sqlite\n.pebbl/view.sqlite\n!.pebbl/events.jsonl\n'
  );
}
function pebbl(cwd, args, env) {
  return execFileSync('node', [BIN, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PEBBL_DISABLE_EMBED: '1', ...(env || {}) },
  });
}

// ── the 5 predicate steps, in isolation ─────────────────────────────────────

describe('storeMode — priority-ordered completeness predicate', () => {
  it('step 1: no events.jsonl => legacy (short-circuit)', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      // even with a marker / legacy-db present, an absent events.jsonl is legacy
      fs.writeFileSync(path.join(pebblDir, LEGACY_DB), 'x');
      fs.writeFileSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER), 'x');
      assert.equal(storeMode(pebblDir), 'legacy');
    } finally { rm(dir); }
  });

  it('step 2: legacy-db.sqlite present => events (survives compaction)', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      writeEvents(pebblDir);
      ignorePebbl(dir);                                  // even gitignored...
      fs.writeFileSync(path.join(pebblDir, LEGACY_DB), 'renamed-db');
      assert.equal(storeMode(pebblDir), 'events');       // ...legacy-db wins
    } finally { rm(dir); }
  });

  it('step 3: .events-canonical marker present => events', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      writeEvents(pebblDir);
      ignorePebbl(dir);                                  // gitignored, no legacy-db
      fs.writeFileSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER), 'canonical\n');
      assert.equal(storeMode(pebblDir), 'events');
    } finally { rm(dir); }
  });

  it('step 4: events.jsonl NOT git-ignored => events (predates-marker backfill)', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      writeEvents(pebblDir);
      sharePebbl(dir);                                   // shared shape, no marker
      assert.equal(storeMode(pebblDir), 'events');
    } finally { rm(dir); }
  });

  it('step 5: gitignored partial tracer (no legacy-db, no marker) => legacy', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      writeEvents(pebblDir);
      ignorePebbl(dir);
      assert.equal(storeMode(pebblDir), 'legacy');
    } finally { rm(dir); }
  });

  it('git error (not a repo) falls to the SAFE direction => legacy, never events', () => {
    const { dir, pebblDir } = tmpRepo({ git: false });   // no .git anywhere
    try {
      writeEvents(pebblDir);                             // no marker, no legacy-db
      assert.equal(storeMode(pebblDir), 'legacy');       // check-ignore errors -> legacy
    } finally { rm(dir); }
  });
});

// ── Acceptance #2: legacy default byte-identical, NO git spawn on that path ──

describe('Acceptance #2 — legacy default: byte-identical, no git subprocess', () => {
  it('a store with NO events.jsonl returns legacy WITHOUT spawning git or reading a marker', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      fs.writeFileSync(path.join(pebblDir, 'db.sqlite'), 'not-a-real-db');
      // Spy on execFileSync: the short-circuit must not reach step 4's git spawn.
      const orig = child_process.execFileSync;
      let gitSpawned = false;
      child_process.execFileSync = function (file, ...rest) {
        if (file === 'git') gitSpawned = true;
        return orig.call(this, file, ...rest);
      };
      try {
        // re-require with the spy installed (store-mode binds execFileSync at
        // module load, so we re-load it fresh under the spy)
        delete require.cache[require.resolve('../src/store-mode')];
        const fresh = require('../src/store-mode');
        const before = fs.readdirSync(pebblDir).sort();
        assert.equal(fresh.storeMode(pebblDir), 'legacy');
        assert.equal(gitSpawned, false, 'legacy short-circuit must NOT spawn git');
        const after = fs.readdirSync(pebblDir).sort();
        assert.deepEqual(after, before, 'storeMode must not add/remove any file');
      } finally {
        child_process.execFileSync = orig;
        // restore the canonical module instance for the rest of the suite
        delete require.cache[require.resolve('../src/store-mode')];
        require('../src/store-mode');
      }
    } finally { rm(dir); }
  });
});

// ── Acceptance #1 + #5: the regression repro, end-to-end via the CLI ─────────

describe('Acceptance #1/#5 — partial tracer reads FULL db.sqlite (the regression)', () => {
  it('a db.sqlite store + a small partial tracer events.jsonl surfaces ALL db.sqlite entries', () => {
    const { dir } = tmpRepo();
    try {
      pebbl(dir, ['init']);                              // default LOCAL: events.jsonl gitignored
      pebbl(dir, ['log', 'alpha first entry', '--cat', 'decision', '--topic', 'core']);
      pebbl(dir, ['log', 'beta second entry', '--cat', 'decision', '--topic', 'core']);
      pebbl(dir, ['log', 'gamma third entry', '--cat', 'decision', '--topic', 'core']);

      // Simulate the partial: keep only the LAST tracer event; db.sqlite still
      // holds all three. (This is the sw-factory on-disk shape: events.jsonl much
      // smaller than db.sqlite, gitignored, no legacy-db, no marker.)
      const ev = path.join(dir, '.pebbl', EVENTS_FILE);
      const lines = fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(ev, lines[lines.length - 1] + '\n');

      const pebblDir = path.join(dir, '.pebbl');
      assert.ok(!fs.existsSync(path.join(pebblDir, LEGACY_DB)), 'no legacy-db in this shape');
      assert.ok(!fs.existsSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER)), 'no marker in this shape');
      assert.equal(storeMode(pebblDir), 'legacy', 'partial tracer must read canonical db.sqlite');

      // #1/#5: the OLDER entries (absent from the partial events.jsonl) still surface.
      const ctx = pebbl(dir, ['context', '--topic', 'core']);
      assert.match(ctx, /alpha first entry/, 'older entry must surface from db.sqlite');
      assert.match(ctx, /beta second entry/);
      const search = pebbl(dir, ['search', 'alpha']);
      assert.match(search, /alpha first entry/, 'search must find the older entry too');
    } finally { rm(dir); }
  });
});

// ── Acceptance #3: fresh init --shared reads-from-fold via the marker ────────

describe('Acceptance #3 — fresh init --shared => events (via marker) + round-trip', () => {
  it('init --shared writes .events-canonical and storeMode === events', () => {
    const { dir } = tmpRepo();
    try {
      pebbl(dir, ['init', '--shared'], { PEBBL_REMOTE_VISIBILITY: 'private' });
      const pebblDir = path.join(dir, '.pebbl');
      assert.ok(fs.existsSync(path.join(pebblDir, EVENTS_CANONICAL_MARKER)),
        'init --shared must write the .events-canonical marker');
      assert.equal(storeMode(pebblDir), 'events');

      // the marker must NOT be gitignored (it has to commit + travel to clones)
      let ignored = true;
      try { execFileSync('git', ['check-ignore', '-q', `.pebbl/${EVENTS_CANONICAL_MARKER}`], { cwd: dir }); }
      catch (e) { if (e.status === 1) ignored = false; }
      assert.equal(ignored, false, 'the marker must be committable (NOT gitignored) in shared mode');

      // a log + context round-trip serves from the fold (events-mode path)
      pebbl(dir, ['log', 'shared decision because teammate visibility', '--cat', 'decision', '--topic', 'core'],
        { PEBBL_REMOTE_VISIBILITY: 'private' });
      const ctx = pebbl(dir, ['context', '--topic', 'core'], { PEBBL_REMOTE_VISIBILITY: 'private' });
      assert.match(ctx, /shared decision/, 'shared store round-trip surfaces the entry');
    } finally { rm(dir); }
  });
});

// ── Acceptance #6: post-compaction migrated store still reads-from-fold ──────

describe('Acceptance #6 — migrated + compacted store keys on legacy-db.sqlite', () => {
  it('legacy-db.sqlite present + db.sqlite RE-CREATED (compaction) => events, not legacy', () => {
    const { dir, pebblDir } = tmpRepo();
    try {
      writeEvents(pebblDir, '{"type":"append","message":"m"}\n');
      ignorePebbl(dir);                                  // gitignored, no marker
      // migrator renamed db.sqlite -> legacy-db.sqlite...
      fs.writeFileSync(path.join(pebblDir, LEGACY_DB), 'rolled-back-db');
      // ...then compaction RE-CREATED db.sqlite (compact.js:438). db.sqlite is
      // PRESENT again, but legacy-db.sqlite is still there.
      fs.writeFileSync(path.join(pebblDir, 'db.sqlite'), 'recompacted-index');
      assert.equal(storeMode(pebblDir), 'events',
        'a compacted migrated store must stay events (keyed on legacy-db.sqlite, not db.sqlite absence)');
    } finally { rm(dir); }
  });
});
