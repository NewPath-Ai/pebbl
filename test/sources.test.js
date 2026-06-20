'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sourceDirs, searchSources } = require('../src/sources');
const { openDb } = require('../src/db');
const { _internal } = require('../src/search');
const { formatResult, searchSqlite } = _internal;

// A pebbl dir lives at <repo>/.pebbl; source docs live at <repo>/<dir>.
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-src-'));
  const pebblDir = path.join(repo, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  return { repo, pebblDir };
}
function writeSource(repo, rel, body) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe('sources - sourceDirs config', () => {
  it('defaults to <repo>/sources', () => {
    const { repo, pebblDir } = fixture();
    assert.deepStrictEqual(sourceDirs(pebblDir, {}), [path.join(repo, 'sources')]);
  });
  it('honors a configured comma-separated dirs list', () => {
    const { repo, pebblDir } = fixture();
    const dirs = sourceDirs(pebblDir, { sources: { dirs: 'docs, research' } });
    assert.deepStrictEqual(dirs, [path.join(repo, 'docs'), path.join(repo, 'research')]);
  });
});

describe('sources - searchSources', () => {
  it('returns a [source]-tagged hit with the repo-relative path and an excerpt', () => {
    const { repo, pebblDir } = fixture();
    writeSource(repo, 'sources/coord.md', '# Analysis\nWe rejected git worktrees: collisions are an assignment problem.\n');
    const out = searchSources(pebblDir, 'worktrees', {});
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].isSource, true);
    assert.strictEqual(out[0].source, 'sources/coord.md');
    assert.match(out[0].message, /rejected git worktrees/);
  });

  it('returns [] for no match and for a missing dir (inert)', () => {
    const { repo, pebblDir } = fixture();
    writeSource(repo, 'sources/x.md', 'nothing relevant here');
    assert.deepStrictEqual(searchSources(pebblDir, 'worktrees', {}), []);
    const empty = fixture();
    assert.deepStrictEqual(searchSources(empty.pebblDir, 'anything', {}), []);
  });

  it('drops a source file on the next search after it is deleted (re-read from disk)', () => {
    const { repo, pebblDir } = fixture();
    const f = writeSource(repo, 'sources/gone.md', 'mentions worktrees here');
    assert.strictEqual(searchSources(pebblDir, 'worktrees', {}).length, 1);
    fs.unlinkSync(f);
    assert.strictEqual(searchSources(pebblDir, 'worktrees', {}).length, 0);
  });

  it('honors the configured dir (a doc outside it is not indexed)', () => {
    const { repo, pebblDir } = fixture();
    writeSource(repo, 'sources/in.md', 'worktrees inside default');
    writeSource(repo, 'docs/out.md', 'worktrees inside docs');
    const cfg = { sources: { dirs: 'docs' } };
    const out = searchSources(pebblDir, 'worktrees', cfg);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].source, 'docs/out.md');
  });
});

describe('sources - formatResult tags [source]', () => {
  it('renders a source hit as "[source] <path> — <msg>"', () => {
    const line = formatResult({ isSource: true, source: 'sources/coord.md', message: 'rejected worktrees' });
    assert.strictEqual(line, '[source] sources/coord.md — rejected worktrees');
  });
});

describe('sources - ranking: curated above [source]', () => {
  it('prints curated entries before [source] hits for a query that matches both', () => {
    const { pebblDir } = fixture();
    const db = openDb(pebblDir);
    db.prepare('INSERT INTO logs (timestamp, source, category, tier, message, topics) VALUES (?, ?, ?, ?, ?, ?)')
      .run('2026-06-11T00:00:00.000Z', 'agent', 'decision', 'foundation',
           'CURATED: rejected worktrees as the isolation strategy', 'pipeline');
    db.close();
    const sourceResults = [{ isSource: true, source: 'sources/coord.md', message: 'raw worktrees analysis' }];

    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      searchSqlite(pebblDir, 'worktrees', null, null, [], sourceResults);
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    const curatedAt = out.indexOf('CURATED: rejected worktrees');
    const sourceAt = out.indexOf('[source] sources/coord.md');
    assert.ok(curatedAt !== -1, 'curated entry present');
    assert.ok(sourceAt !== -1, '[source] hit present');
    assert.ok(curatedAt < sourceAt, 'curated must rank above [source]');
  });
});
