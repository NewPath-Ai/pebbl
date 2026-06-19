'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { buildGroups, unionTopics } = require('../src/compact');

function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-compact-'));
  const d = new Database(path.join(dir, 'db.sqlite'));
  d.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'human', category TEXT NOT NULL DEFAULT 'uncategorized',
    tier TEXT NOT NULL DEFAULT 'detail', message TEXT NOT NULL, topics TEXT,
    relates_to INTEGER, corrects INTEGER, valid_from TEXT, valid_to TEXT, invalidated_by INTEGER);`);
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

// P3 (event-sourcing): the "archived stays searchable (change 3)" describe block
// is DELETED. It exercised archiveEntries()/archive.md/`search --include-archive`,
// all of which the destructive→additive flip removes — compaction no longer
// writes archive/*.txt or archive.md; the append-only events.jsonl IS the durable
// archive and rolled-up source entries stay in the log (their eid lives in a
// supersede's rolls_up), so there is no separate "archived" search tier to assert
// on. The append-only / zero-git-deletion replacement is covered in
// test/compact-append-only.test.js. (search.js still carries a now-vestigial
// --include-archive branch; ripping it out is search-surface cleanup, out of P3.)
