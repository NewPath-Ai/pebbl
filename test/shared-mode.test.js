'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
//
// Shared mode — the two wires that make multiplayer pebbl memory real (the
// 2026-06-18 event-sourcing cutover shipped the multiplayer-CAPABLE codebase
// but pebbl stayed single-player because these were never built):
//
//   Wire 1 — `pebbl init --shared`: relax the .gitignore to COMMIT events.jsonl
//     (while still ignoring events.local.jsonl / view.sqlite / db.sqlite), and
//     hard-refuse a --shared init on a PUBLIC remote unless --allow-public-memory
//     AND a clean audit-history. Default (no flag) stays LOCAL, byte-for-byte.
//
//   Wire 2 — reads-from-fold: in an events-mode store, `context` and `search`
//     read the folded view.sqlite, not db.sqlite. db.sqlite is gitignored and
//     never transported, so a teammate who pulls only events.jsonl must still
//     SEE the merged learnings — which only works if reads come from the fold.
//
// The keystone is the two-clone merge test (Acceptance #4): two clones each log
// a distinct entry after a common base, git-merge events.jsonl (merge=union) with
// ZERO conflict markers, and BOTH entries surface in `context` AND `search` in
// BOTH clones. Since neither clone's db.sqlite ever saw the other's entry, that
// can only pass if reads are served from the fold.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const tmps = [];

after(() => {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// Run a shell command in `cwd`, inheriting env + any overrides. Throws on a
// non-zero exit (so a test fails loudly if a setup step breaks). PEBBL_DISABLE_EMBED
// is already process-wide (test/setup.js) and inherited by the child + the git hook.
function sh(cwd, cmd, env) {
  return execFileSync('bash', ['-c', cmd], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...(env || {}) },
  });
}
// Like sh but returns the child's exit code instead of throwing — for the
// "must refuse" gate cases where a non-zero exit IS the assertion.
function shExit(cwd, cmd, env) {
  try {
    execFileSync('bash', ['-c', cmd], {
      cwd, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, ...(env || {}) },
    });
    return 0;
  } catch (e) {
    return e.status == null ? 1 : e.status;
  }
}
// Run a pebbl command via the worktree bin, returning stdout.
function pebbl(cwd, args, env) {
  return execFileSync('node', [BIN, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
}
function mkrepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(repo);
  sh(repo, 'git init -q && git config user.email a@b.c && git config user.name t && git checkout -q -b main');
  return repo;
}
function ignored(repo, p) {
  // git check-ignore exits 0 when the path IS ignored, 1 when it is NOT.
  return shExit(repo, `git check-ignore ${p}`) === 0;
}

// ── Wire 1: gitignore relaxation ─────────────────────────────────────────────

describe('Wire 1 — pebbl init gitignore (default LOCAL vs --shared)', () => {
  it('default `pebbl init` (no flag) gitignores events.jsonl — DEFAULT STAYS LOCAL (Acceptance #1)', () => {
    const repo = mkrepo('pebbl-sm-default-');
    pebbl(repo, ['init']);
    assert.ok(ignored(repo, '.pebbl/events.jsonl'),
      'default init MUST keep events.jsonl gitignored (local-only)');
    // byte-for-byte the pre-shared-mode two lines, in order.
    const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    const lines = gi.split('\n').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(lines, ['.pebbl/', '.pebbl/events.local.jsonl'],
      'default .gitignore must be exactly the original two lines');
  });

  it('`pebbl init --shared` commits events.jsonl but ignores events.local.jsonl/view.sqlite/db.sqlite (Acceptance #2)', () => {
    const repo = mkrepo('pebbl-sm-shared-');
    pebbl(repo, ['init', '--shared'], { PEBBL_REMOTE_VISIBILITY: 'private' });
    assert.ok(!ignored(repo, '.pebbl/events.jsonl'),
      '--shared MUST track events.jsonl (not ignored)');
    assert.ok(ignored(repo, '.pebbl/events.local.jsonl'),
      '--shared MUST still ignore the private events.local.jsonl');
    assert.ok(ignored(repo, '.pebbl/view.sqlite'),
      '--shared MUST ignore the disposable view.sqlite');
    assert.ok(ignored(repo, '.pebbl/db.sqlite'),
      '--shared MUST ignore the local db.sqlite');
    // and git actually stages events.jsonl
    fs.writeFileSync(path.join(repo, '.pebbl', 'events.jsonl'), '{}\n');
    sh(repo, 'git add -A');
    const staged = sh(repo, 'git diff --cached --name-only');
    assert.match(staged, /\.pebbl\/events\.jsonl/, 'events.jsonl must be stage-able under --shared');
    assert.doesNotMatch(staged, /\.pebbl\/db\.sqlite/, 'db.sqlite must NOT be staged');
    assert.doesNotMatch(staged, /events\.local\.jsonl/, 'events.local.jsonl must NOT be staged');
  });

  it('re-init is idempotent: a second --shared init does not duplicate gitignore lines', () => {
    const repo = mkrepo('pebbl-sm-reinit-');
    pebbl(repo, ['init', '--shared'], { PEBBL_REMOTE_VISIBILITY: 'private' });
    const first = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    pebbl(repo, ['init', '--shared'], { PEBBL_REMOTE_VISIBILITY: 'private' });
    const second = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    assert.equal(second, first, 're-init must not append duplicate lines');
    assert.ok(!ignored(repo, '.pebbl/events.jsonl'), 'still tracking events.jsonl after re-init');
  });
});

// ── Wire 1: the public-remote hard gate ──────────────────────────────────────

describe('Wire 1 — public-remote hard gate for --shared (Acceptance #3)', () => {
  it('refuses --shared on a PUBLIC remote without --allow-public-memory (and writes nothing)', () => {
    const repo = mkrepo('pebbl-sm-pub-refuse-');
    const code = shExit(repo, `node "${BIN}" init --shared`, { PEBBL_REMOTE_VISIBILITY: 'public' });
    assert.notEqual(code, 0, 'a public-remote --shared init must be refused (non-zero exit)');
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl')),
      'a refused init must not create .pebbl (refuse BEFORE any write)');
    assert.ok(!fs.existsSync(path.join(repo, '.gitignore')),
      'a refused init must not write a .gitignore');
  });

  it('refuses --shared --allow-public-memory when committed .md history is DIRTY', () => {
    const repo = mkrepo('pebbl-sm-pub-dirty-');
    // commit a leak into history (skip the scan hook — there is none yet, but be safe)
    fs.writeFileSync(path.join(repo, 'leak.md'), 'droplet 67.207.93.196:48422 cred /etc/factory-updates-bot.env\n');
    sh(repo, 'git add leak.md && git commit -qm "leak"', { PEBBL_SKIP_SCAN: '1' });
    const code = shExit(repo, `node "${BIN}" init --shared --allow-public-memory`,
      { PEBBL_REMOTE_VISIBILITY: 'public' });
    assert.notEqual(code, 0, 'dirty .md history must block --shared even with --allow-public-memory');
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl')), 'refused init writes nothing');
  });

  it('ALLOWS --shared --allow-public-memory on a PUBLIC remote with CLEAN history', () => {
    const repo = mkrepo('pebbl-sm-pub-allow-');
    const code = shExit(repo, `node "${BIN}" init --shared --allow-public-memory`,
      { PEBBL_REMOTE_VISIBILITY: 'public' });
    assert.equal(code, 0, 'clean history + --allow-public-memory must allow a public --shared init');
    assert.ok(!ignored(repo, '.pebbl/events.jsonl'), 'and events.jsonl is tracked');
  });

  it('ALLOWS --shared on a PRIVATE remote with no extra flag (repo is the trust boundary)', () => {
    const repo = mkrepo('pebbl-sm-priv-');
    const code = shExit(repo, `node "${BIN}" init --shared`, { PEBBL_REMOTE_VISIBILITY: 'private' });
    assert.equal(code, 0, 'a private remote needs no --allow-public-memory');
    assert.ok(!ignored(repo, '.pebbl/events.jsonl'));
  });
});

// ── Wire 2 + the keystone: two-clone merge proves reads come from the fold ────

describe('Wire 2 — two-clone merge: reads come from the fold (Acceptance #4)', () => {
  // Build a shared "origin" with a base entry, clone it twice, each clone logs a
  // distinct entry, then merge clone B's events.jsonl into clone A (and vice
  // versa) via the union driver. The proof: each clone's db.sqlite only ever held
  // its OWN entry + the base (db.sqlite is gitignored, never pushed/pulled), so a
  // foreign entry can only appear in context/search if reads are served from the
  // folded view.sqlite rebuilt from the merged events.jsonl.
  function setupSharedTrio() {
    // bare origin
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-sm-origin-'));
    tmps.push(origin);
    sh(origin, 'git init -q --bare');

    // seed clone: init --shared (private remote so it's allowed), base entry, push
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-sm-seed-'));
    tmps.push(seed);
    sh(seed, `git clone -q "${origin}" .`);
    sh(seed, 'git config user.email seed@b.c && git config user.name seed && git checkout -q -b main');
    pebbl(seed, ['init', '--shared'], { PEBBL_REMOTE_VISIBILITY: 'private' });
    pebbl(seed, ['log', 'the base decision because we agreed on sqlite', '--cat', 'decision', '--topic', 'core'],
      { PEBBL_REMOTE_VISIBILITY: 'private' });
    // commit the shared store (events.jsonl + .gitignore + .gitattributes + md mirror)
    sh(seed, 'git add -A && git commit -qm "shared store base"', { PEBBL_SKIP_SCAN: '1' });
    sh(seed, 'git push -q -u origin main', { PEBBL_SKIP_SCAN: '1' });

    // two working clones
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-sm-A-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-sm-B-'));
    tmps.push(a, b);
    sh(a, `git clone -q "${origin}" .`);
    sh(a, 'git config user.email a@b.c && git config user.name aa');
    sh(b, `git clone -q "${origin}" .`);
    sh(b, 'git config user.email b@b.c && git config user.name bb');
    return { origin, a, b };
  }

  it('zero conflict markers on union-merge, and BOTH entries surface in context AND search in BOTH clones', () => {
    const { a, b } = setupSharedTrio();
    const env = { PEBBL_REMOTE_VISIBILITY: 'private' };

    // Each clone independently logs a distinct entry after the common base.
    pebbl(a, ['log', 'clone A chose redis because of pubsub fanout', '--cat', 'decision', '--topic', 'core'], env);
    pebbl(b, ['log', 'clone B chose kafka because of durable streams', '--cat', 'decision', '--topic', 'core'], env);
    sh(a, 'git add -A && git commit -qm "A entry"', { PEBBL_SKIP_SCAN: '1' });
    sh(b, 'git add -A && git commit -qm "B entry"', { PEBBL_SKIP_SCAN: '1' });

    // A publishes; B pulls (a real git merge over events.jsonl with merge=union).
    sh(a, 'git push -q origin main', { PEBBL_SKIP_SCAN: '1' });
    sh(b, 'git pull -q --no-rebase --no-edit origin main', { PEBBL_SKIP_SCAN: '1' });
    // B publishes its merge; A pulls it back so BOTH clones end up with BOTH entries.
    sh(b, 'git push -q origin main', { PEBBL_SKIP_SCAN: '1' });
    sh(a, 'git pull -q --no-rebase --no-edit origin main', { PEBBL_SKIP_SCAN: '1' });

    // (1) ZERO conflict markers in the merged events.jsonl (the union invariant).
    for (const [name, dir] of [['A', a], ['B', b]]) {
      const events = fs.readFileSync(path.join(dir, '.pebbl', 'events.jsonl'), 'utf8');
      assert.doesNotMatch(events, /^<<<<<<<|^=======|^>>>>>>>/m,
        `clone ${name} events.jsonl must have NO conflict markers after union-merge`);
      // both entries' messages are present in the committed log text
      assert.match(events, /redis/, `clone ${name} log has A's entry`);
      assert.match(events, /kafka/, `clone ${name} log has B's entry`);
    }

    // (2) The PROOF — both entries surface in BOTH clones via context AND search.
    // db.sqlite in each clone only ever held its OWN entry + base; the foreign
    // entry is visible ONLY because reads come from the fold (view.sqlite).
    for (const [name, dir] of [['A', a], ['B', b]]) {
      const ctx = pebbl(dir, ['context', '--topic', 'core'], env);
      assert.match(ctx, /redis/, `clone ${name} context MUST show A's entry (reads-from-fold)`);
      assert.match(ctx, /kafka/, `clone ${name} context MUST show B's entry (reads-from-fold)`);

      const searchA = pebbl(dir, ['search', 'redis'], env);
      assert.match(searchA, /redis/, `clone ${name} search MUST find A's entry (reads-from-fold)`);
      const searchB = pebbl(dir, ['search', 'kafka'], env);
      assert.match(searchB, /kafka/, `clone ${name} search MUST find B's entry (reads-from-fold)`);
    }
  });

  it('the merged entry is absent from a clone\'s db.sqlite — so context could only have read it from the fold', () => {
    const { a, b } = setupSharedTrio();
    const env = { PEBBL_REMOTE_VISIBILITY: 'private' };
    pebbl(a, ['log', 'clone A chose redis because pubsub', '--cat', 'decision', '--topic', 'core'], env);
    pebbl(b, ['log', 'clone B chose kafka because durable', '--cat', 'decision', '--topic', 'core'], env);
    sh(a, 'git add -A && git commit -qm "A"', { PEBBL_SKIP_SCAN: '1' });
    sh(b, 'git add -A && git commit -qm "B"', { PEBBL_SKIP_SCAN: '1' });
    sh(a, 'git push -q origin main', { PEBBL_SKIP_SCAN: '1' });
    sh(b, 'git pull -q --no-rebase --no-edit origin main', { PEBBL_SKIP_SCAN: '1' });

    // BEFORE any read folds the merged log, B's db.sqlite must NOT contain A's
    // 'redis' entry — db.sqlite was never transported, only B's own writes are in
    // it. (We read the raw bytes so no pebbl read path runs the fold first.)
    const Database = require('better-sqlite3');
    const db = new Database(path.join(b, '.pebbl', 'db.sqlite'), { readonly: true });
    const hasRedisInDb = db.prepare("SELECT COUNT(*) c FROM logs WHERE message LIKE '%redis%'").get().c;
    db.close();
    assert.equal(hasRedisInDb, 0,
      "A's entry must be ABSENT from B's db.sqlite (db.sqlite is gitignored / never pulled)");

    // ...yet context surfaces it — which can only come from the folded view.
    const ctx = pebbl(b, ['context', '--topic', 'core'], env);
    assert.match(ctx, /redis/,
      "B's context shows A's entry though db.sqlite lacks it => the read came from the fold");
  });
});

// ── Wire 2: legacy coexistence is byte-for-byte unchanged ────────────────────

describe('Wire 2 — legacy (db.sqlite-only) coexistence unchanged (Acceptance #5)', () => {
  // A store with NO events.jsonl is legacy: storeMode==='legacy', so openReadDb
  // delegates straight to openDb(db.sqlite). context/search output must be
  // byte-identical to the pre-change read path. We build a legacy store by
  // logging then deleting the events artifacts, and assert reads still work AND
  // never touch view.sqlite.
  function legacyStore() {
    const repo = mkrepo('pebbl-sm-legacy-');
    // A bare .pebbl dir is enough for the log path to create db.sqlite via
    // openDb -> migrate (we skip `pebbl init` — far slower, and we only need a
    // discoverable store, not git hooks; the throwaway logs build the schema).
    fs.mkdirSync(path.join(repo, '.pebbl'), { recursive: true });
    pebbl(repo, ['log', 'legacy alpha because reasons', '--cat', 'decision', '--topic', 'leg']);
    pebbl(repo, ['log', 'legacy beta note', '--cat', 'pattern', '--topic', 'leg']);
    // strip events artifacts -> legacy mode (db.sqlite truth)
    for (const f of ['events.jsonl', 'events.local.jsonl', 'view.sqlite']) {
      try { fs.rmSync(path.join(repo, '.pebbl', f), { force: true }); } catch {}
    }
    return repo;
  }

  it('a legacy store reads from db.sqlite and NEVER creates view.sqlite on a read', () => {
    const repo = legacyStore();
    const { storeMode } = require('../src/store-mode');
    assert.equal(storeMode(path.join(repo, '.pebbl')), 'legacy', 'no events.jsonl => legacy');

    const ctx = pebbl(repo, ['context', '--topic', 'leg']);
    assert.match(ctx, /legacy alpha/, 'legacy context still surfaces db.sqlite entries');
    assert.match(ctx, /legacy beta/);
    const search = pebbl(repo, ['search', 'legacy']);
    assert.match(search, /legacy/, 'legacy search still works off db.sqlite');

    // a legacy read must not have materialized a view.sqlite (reads-from-fold is
    // events-mode only; legacy stays pure db.sqlite).
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl', 'view.sqlite')),
      'a legacy read must NOT create view.sqlite');
    assert.ok(!fs.existsSync(path.join(repo, '.pebbl', 'events.jsonl')),
      'a legacy read must NOT create events.jsonl');
  });

  it('openReadDb on a legacy store === openDb (same canonical handle, same rows)', () => {
    const repo = legacyStore();
    const { openDb, openReadDb } = require('../src/db');
    const pebblDir = path.join(repo, '.pebbl');
    const viaRead = openReadDb(pebblDir);
    const viaOpen = openDb(pebblDir);
    const rowsRead = viaRead.prepare('SELECT id, message FROM logs ORDER BY id').all();
    const rowsOpen = viaOpen.prepare('SELECT id, message FROM logs ORDER BY id').all();
    viaRead.close();
    viaOpen.close();
    assert.deepEqual(rowsRead, rowsOpen,
      'legacy openReadDb must return the same rows as openDb (it delegates to it)');
  });
});
