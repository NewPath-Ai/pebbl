'use strict';
// M1 — SQLite FTS5 + bm25 search. Covers the three behaviors the task names:
//   (1) the FTS5 ranked + porter-stemmed primary path,
//   (2) curated synonym OR-expansion before MATCH,
//   (3) the LIKE fallback when FTS5 is unavailable, with the same output shape.
// Plus the derived/disposable + deterministic-order guarantees and that the
// existing filters (cat, current-belief, tier!=archived) still hold. Integration
// cases drive the REAL CLI against a real .pebbl store (same pattern as
// staleness.test.js) so the actual read path — capability probe -> searchFts5 ->
// view.sqlite/db.sqlite — is exercised, not a mock.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
const { _internal } = require('../src/search');
const { buildMatchQuery, SYNONYM_INDEX, SYNONYM_GROUPS } = _internal;
const { fts5Compiled, fts5Available, buildFtsIndex, ftsTableExists } = require('../src/db');

// A real git repo + initialized .pebbl store, so the read path behaves exactly
// as in production. Default init => legacy store (reads db.sqlite); pass
// { shared: true } to get an events store (reads view.sqlite).
function makeStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-fts-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  if (opts.shared) {
    // --shared's public-remote gate needs a non-public remote to exist.
    execFileSync('git', ['remote', 'add', 'origin', path.join(dir, 'fake-remote.git')], { cwd: dir });
  }
  execFileSync('node', [PEBBL_BIN, 'init', ...(opts.shared ? ['--shared'] : [])], {
    cwd: dir, stdio: 'ignore',
  });
  return dir;
}

function pebbl(dir, args) {
  return execFileSync('node', [PEBBL_BIN, ...args], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// All categories pebbl accepts are rubric-driven; 'decision' is the safe one for
// a free-text message (it has the broadest keyword set and never gets rejected
// when we pass it explicitly). Tier 'component' keeps entries out of the
// fleeting/rollup machinery so they stay live for the search assertions.
function log(dir, message, extra = []) {
  pebbl(dir, ['log', message, '--cat', 'decision', '--tier', 'component', ...extra]);
}

// ── buildMatchQuery + synonym map (pure, no DB) ──────────────────────────────

describe('FTS5 buildMatchQuery (synonym OR-expansion)', () => {
  it('returns "" for a blank query (no MATCH constraint)', () => {
    assert.equal(buildMatchQuery(''), '');
    assert.equal(buildMatchQuery('   '), '');
  });

  it('quotes each term as an FTS5 string literal (injection-safe)', () => {
    // A term with FTS5-significant characters must be quoted, never bareword.
    const m = buildMatchQuery('foo-bar');
    assert.match(m, /"foo-bar"/);
  });

  it('ANDs multiple terms', () => {
    const m = buildMatchQuery('alpha beta');
    assert.match(m, /"alpha"/);
    assert.match(m, / AND /);
  });

  it('OR-expands a synonym term into its group', () => {
    // "cancel" maps to terminate/abort; the MATCH for it must OR all three.
    const m = buildMatchQuery('cancel');
    assert.match(m, /"cancel"/);
    assert.match(m, /"terminate"/);
    assert.match(m, /"abort"/);
    assert.match(m, / OR /);
  });

  it('prefix-matches the last token so a half-typed word still hits', () => {
    const m = buildMatchQuery('auth');
    assert.match(m, /"auth" \*/); // the prefix form is present
  });

  it('SYNONYM_INDEX is symmetric and derived from the groups', () => {
    // Every member of a group resolves to the rest of that group.
    for (const group of SYNONYM_GROUPS) {
      for (const word of group) {
        const syns = SYNONYM_INDEX.get(word) || [];
        for (const other of group) {
          if (other !== word) assert.ok(syns.includes(other), `${word} -> ${other}`);
        }
      }
    }
  });
});

// ── capability probe + index build (real in-memory DB) ───────────────────────

describe('FTS5 capability + index build', () => {
  it('FTS5 is compiled into the bundled SQLite', () => {
    const db = new Database(':memory:');
    try {
      assert.equal(fts5Compiled(db), true);
    } finally { db.close(); }
  });

  it('buildFtsIndex creates an external-content index that bm25-ranks and stems', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY, message TEXT, valid_to TEXT, tier TEXT, category TEXT, topics TEXT)');
      const ins = db.prepare('INSERT INTO logs(id,message,tier,category) VALUES (?,?,?,?)');
      ins.run(1, 'we rejected the bcrypt proposal once', 'component', 'decision');
      ins.run(2, 'bcrypt bcrypt bcrypt strongest match', 'component', 'decision');
      assert.equal(buildFtsIndex(db), true);
      assert.equal(ftsTableExists(db), true);
      // Stemming: a query for "reject" matches the stored "rejected".
      const stem = db.prepare("SELECT rowid FROM logs_fts WHERE logs_fts MATCH 'reject'").all();
      assert.deepEqual(stem.map(r => r.rowid), [1]);
      // Ranking: the triple-bcrypt row outranks the single-mention row.
      const ranked = db.prepare(
        'SELECT rowid FROM logs_fts WHERE logs_fts MATCH ? ORDER BY bm25(logs_fts), rowid'
      ).all('bcrypt').map(r => r.rowid);
      assert.deepEqual(ranked, [2, 1]);
    } finally { db.close(); }
  });

  it('buildFtsIndex refuses a readonly handle (returns false, no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ro-'));
    const f = path.join(dir, 'v.sqlite');
    const w = new Database(f); w.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY, message TEXT)'); w.close();
    const ro = new Database(f, { readonly: true });
    try {
      assert.equal(buildFtsIndex(ro), false);
      // A readonly handle with no index -> fts5Available is false -> LIKE fallback.
      assert.equal(fts5Available(ro), false);
    } finally { ro.close(); }
  });
});

// ── end-to-end: legacy store (reads db.sqlite) ───────────────────────────────

describe('FTS5 search end-to-end (legacy store / db.sqlite)', () => {
  it('ranks by relevance, NOT insertion order, and stems the query', () => {
    const dir = makeStore();
    // Insertion order: single-mention FIRST, triple-mention SECOND. A LIKE scan
    // ordered by timestamp DESC would surface the LAST-inserted first regardless
    // of relevance; bm25 must instead put the triple-mention entry on top.
    log(dir, 'we rejected the bcrypt proposal once');
    log(dir, 'bcrypt bcrypt bcrypt is the strongest bcrypt entry');
    // "reject" (stem) must find the "rejected" entry — proves the porter path.
    const stemOut = pebbl(dir, ['search', 'reject']);
    assert.match(stemOut, /rejected the bcrypt proposal/);

    const out = pebbl(dir, ['search', 'bcrypt']);
    const idxStrong = out.indexOf('strongest bcrypt entry');
    const idxOnce = out.indexOf('rejected the bcrypt proposal');
    assert.ok(idxStrong > -1 && idxOnce > -1, 'both entries present');
    assert.ok(idxStrong < idxOnce, 'triple-bcrypt entry ranks ABOVE the single mention');
  });

  it('a seeded synonym finds an entry that contains ONLY the synonym', () => {
    const dir = makeStore();
    // The entry says "terminate"; the query is "cancel". Only the curated
    // synonym OR-expansion can connect them (no shared substring/stem).
    log(dir, 'we will terminate the legacy job runner');
    const out = pebbl(dir, ['search', 'cancel']);
    assert.match(out, /terminate the legacy job runner/);
  });

  it('honors the category filter', () => {
    const dir = makeStore();
    log(dir, 'bcrypt hashing decision here');
    // Filtering to a category the entry is NOT in yields nothing.
    const miss = pebbl(dir, ['search', 'bcrypt', '--cat', 'data']);
    assert.match(miss, /No results found/);
    // Filtering to its real category still finds it.
    const hit = pebbl(dir, ['search', 'bcrypt', '--cat', 'decision']);
    assert.match(hit, /bcrypt hashing decision here/);
  });

  it('honors the topic filter (l.topics on the FTS join)', () => {
    const dir = makeStore();
    log(dir, 'we rejected bcrypt for the auth flow', ['--topic', 'auth']);
    log(dir, 'bcrypt notes on the billing flow', ['--topic', 'billing']);
    const authOnly = pebbl(dir, ['search', 'bcrypt', '--topic', 'auth']);
    assert.match(authOnly, /auth flow/);
    assert.doesNotMatch(authOnly, /billing flow/);
    const billingOnly = pebbl(dir, ['search', 'bcrypt', '--topic', 'billing']);
    assert.match(billingOnly, /billing flow/);
    assert.doesNotMatch(billingOnly, /auth flow/);
  });

  it('surfaces only the CURRENT belief (a corrected entry is hidden)', () => {
    const dir = makeStore();
    log(dir, 'we use bcrypt for password hashing');
    // Correct it; the superseded row must drop out of search (valid_to set).
    pebbl(dir, ['log', 'we use argon2 for password hashing now', '--cat', 'correction', '--tier', 'component', '--corrects', '1']);
    const out = pebbl(dir, ['search', 'hashing']);
    assert.match(out, /argon2/);
    assert.doesNotMatch(out, /we use bcrypt for password hashing/);
  });

  it('the FTS index is derived/disposable: drop it and the next search rebuilds it identically', () => {
    const dir = makeStore();
    log(dir, 'we rejected the bcrypt proposal once');
    log(dir, 'bcrypt bcrypt bcrypt strongest match');
    const before = pebbl(dir, ['search', 'bcrypt']);
    // Drop the index table out from under the read path.
    const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'));
    db.exec('DROP TABLE IF EXISTS logs_fts');
    assert.equal(ftsTableExists(db), false);
    db.close();
    // Next search rebuilds the index from logs and reproduces the same order.
    const after = pebbl(dir, ['search', 'bcrypt']);
    assert.equal(after, before, 'search output is identical after an index rebuild');
  });
});

// ── end-to-end: events store (reads the folded view.sqlite, readonly) ─────────

describe('FTS5 search end-to-end (events store / view.sqlite)', () => {
  it('view.sqlite ships the FTS index built in the fold seam, and search ranks off it', () => {
    const dir = makeStore({ shared: true });
    assert.match(pebbl(dir, ['log', 'we rejected the bcrypt proposal once', '--cat', 'decision', '--tier', 'component']), /.*/);
    log(dir, 'bcrypt bcrypt bcrypt strongest match');
    // The folded view carries logs_fts (writeViewSqlite built it).
    const view = new Database(path.join(dir, '.pebbl', 'view.sqlite'), { readonly: true });
    try {
      assert.equal(ftsTableExists(view), true);
    } finally { view.close(); }
    const out = pebbl(dir, ['search', 'bcrypt']);
    const idxStrong = out.indexOf('strongest match');
    const idxOnce = out.indexOf('rejected the bcrypt proposal');
    assert.ok(idxStrong > -1 && idxOnce > -1 && idxStrong < idxOnce, 'bm25 order off the view');
  });

  it('is rebuildable from events.jsonl: delete view.sqlite and the next search reproduces results', () => {
    const dir = makeStore({ shared: true });
    log(dir, 'we will terminate the legacy job runner');
    const before = pebbl(dir, ['search', 'cancel']); // synonym hit
    fs.unlinkSync(path.join(dir, '.pebbl', 'view.sqlite'));
    const after = pebbl(dir, ['search', 'cancel']);
    assert.match(after, /terminate the legacy job runner/);
    assert.equal(after, before, 'rebuilt-from-events view reproduces the same result');
  });
});

// ── LIKE fallback (the graceful degrade path) ────────────────────────────────

describe('LIKE fallback (FTS5 unavailable) keeps the same output shape', () => {
  it('searchSqlite returns the identical bracketed format as the FTS path', () => {
    // We can't easily un-compile FTS5, so we assert the fallback directly: it is
    // the SAME function search() calls when fts5Available() is false, and it
    // reuses renderResults, so its output shape is guaranteed identical. Drive it
    // against a real legacy store via _internal.searchSqlite and capture stdout.
    const dir = makeStore();
    log(dir, 'we rejected the bcrypt proposal once');
    const pebblDir = path.join(dir, '.pebbl');

    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      _internal.searchSqlite(pebblDir, 'bcrypt', undefined, undefined, [], []);
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    // Same header + bracketed entry shape the FTS path prints via renderResults.
    assert.match(out, /--- SEARCH: bcrypt ---/);
    assert.match(out, /\[component\|decision\] .* — we rejected the bcrypt proposal once/);
  });

  it('the LIKE fallback still matches multi-word AND-of-terms', () => {
    const dir = makeStore();
    log(dir, 'the bcrypt hashing scheme decision');
    const pebblDir = path.join(dir, '.pebbl');
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      // both words present in any order -> a hit
      _internal.searchSqlite(pebblDir, 'hashing bcrypt', undefined, undefined, [], []);
    } finally {
      console.log = orig;
    }
    assert.match(lines.join('\n'), /bcrypt hashing scheme decision/);
  });
});
