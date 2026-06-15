'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { buildGroups, unionTopics, archiveEntries } = require('../src/compact');
const { _internal } = require('../src/search');
const { parseQmdResults, formatResult } = _internal;

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-compact-'));
  const d = new Database(path.join(dir, 'db.sqlite'));
  d.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'human', category TEXT NOT NULL DEFAULT 'uncategorized',
    tier TEXT NOT NULL DEFAULT 'detail', message TEXT NOT NULL, topics TEXT,
    relates_to INTEGER, corrects INTEGER);`);
  return { dir, d, ins: d.prepare('INSERT INTO logs (timestamp,source,category,tier,message,topics) VALUES (?,?,?,?,?,?)') };
}

describe('compact-retrievability - unionTopics (change 2)', () => {
  it('preserves the union of all entries topics, deduped & order-preserving', () => {
    assert.equal(unionTopics([{ topics: 'auth,security' }, { topics: 'security,db' }, { topics: 'auth' }]),
      'auth,security,db');
  });
  it('a rollup carries every source topic, not just the first primary', () => {
    const { d, ins } = db();
    for (let i = 0; i < 12; i++) ins.run(`2026-05-${10 + i}`, 'human', 'pattern', 'detail', `note ${i}`, i % 2 ? 'logging,ops' : 'logging');
    const { groups } = buildGroups(d, 10, 15);
    const entries = [...groups.values()][0];
    assert.equal(unionTopics(entries), 'logging,ops'); // ops is a secondary topic that must survive
  });
});

describe('compact-retrievability - protect component decisions (change 1)', () => {
  it('a component+decision is pulled into protected, never into a rollup group', () => {
    const { d, ins } = db();
    ins.run('2026-05-01', 'human', 'decision', 'component', 'chose SQLite over Dolt for the store', 'storage');
    for (let i = 0; i < 12; i++) ins.run(`2026-05-${10 + i}`, 'human', 'detail', 'detail', `misc ${i}`, 'misc');
    const { groups, protected: prot } = buildGroups(d, 10, 15);
    assert.equal(prot.length, 1);
    assert.match(prot[0].message, /chose SQLite/);
    const inAnyGroup = [...groups.values()].flat().some(e => e.tier === 'component' && e.category === 'decision');
    assert.equal(inAnyGroup, false, 'a component decision must not be inside any rollup group');
  });
  it('a detail decision is NOT protected (still eligible to roll up)', () => {
    const { d, ins } = db();
    for (let i = 0; i < 12; i++) ins.run(`2026-05-${10 + i}`, 'human', 'decision', 'detail', `small call ${i}`, 'x');
    const { groups, protected: prot } = buildGroups(d, 10, 15);
    assert.equal(prot.length, 0);
    assert.equal([...groups.values()].flat().length, 12);
  });
});

describe('compact-retrievability - archived stays searchable (change 3)', () => {
  it('archiveEntries writes a qmd-indexed archive.md with tier:archived blocks', () => {
    const { dir } = db();
    archiveEntries(dir, [{ id: 7, timestamp: '2026-05-01T00:00:00Z', tier: 'detail', category: 'decision',
      topics: 'auth,security', message: 'used bcrypt for hashing', source: 'agent' }], '2026-06-01T00:00:00Z');
    const md = fs.readFileSync(path.join(dir, 'archive.md'), 'utf8');
    assert.match(md, /## 2026-05-01T00:00:00Z - used bcrypt for hashing/);
    assert.match(md, /tier:archived/);
    assert.match(md, /cat:decision topic:auth,security/);
  });

  it('search parses an archive.md block as tier=archived and tags it [archived]', () => {
    const block = ['qmd://pebbl/archive.md:3', 'Title: t', 'Score: 40%', '',
      '## 2026-05-01T00:00:00Z - used bcrypt for hashing',
      '<!-- cat:decision topic:auth tier:archived source:agent -->', ''].join('\n');
    const r = parseQmdResults(block);
    assert.equal(r.length, 1);
    assert.equal(r[0].tier, 'archived');
    assert.equal(formatResult(r[0]), '[archived] [decision] 2026-05-01 — used bcrypt for hashing');
  });
});
