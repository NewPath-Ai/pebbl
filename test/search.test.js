'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { _internal } = require('../src/search');

const { parseQmdResults, dedupeResults, formatResult, stripHandoffPrefix, searchHandoffsSqlite } = _internal;

function qmdBlock(uri, heading, comment) {
  return [`qmd://${uri}`, 'Title: t', 'Score: 50%', '', `## ${heading}`, comment, ''].join('\n');
}

describe('search - parseQmdResults', () => {
  it('parses a log-entry block', () => {
    const raw = qmdBlock('pebbl/manual-logs.md:5', '2026-05-27T10:00:00.000Z - chose bcrypt for hashing',
      '<!-- cat:decision topic:auth tier:component source:agent -->');
    const r = parseQmdResults(raw);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].isHandoff, false);
    assert.strictEqual(r[0].cat, 'decision');
    assert.strictEqual(r[0].tier, 'component');
    assert.strictEqual(r[0].message, 'chose bcrypt for hashing');
  });

  it('parses a closed handoff item-block', () => {
    const raw = qmdBlock('pebbl/handoffs.md:7', '2026-05-27T09:58:50.000Z - handoff #8 done: aggression slider live',
      '<!-- handoff:8 field:done topic:editor status:closed -->');
    const r = parseQmdResults(raw);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].isHandoff, true);
    assert.strictEqual(r[0].handoffId, '8');
    assert.strictEqual(r[0].field, 'done');
    assert.strictEqual(r[0].topics, 'editor');
    assert.strictEqual(r[0].status, 'closed');
  });

  it('parses an open handoff item-block', () => {
    const raw = qmdBlock('pebbl/handoffs.md:7', '2026-05-27T09:58:50.000Z - handoff #6 todo: ship it',
      '<!-- handoff:6 field:todo topic:auth status:open -->');
    const r = parseQmdResults(raw);
    assert.strictEqual(r[0].status, 'open');
  });

  it('defaults status to closed when comment omits it (back-compat)', () => {
    const raw = qmdBlock('pebbl/handoffs.md:7', '2026-05-27T09:58:50.000Z - handoff #1 done: x',
      '<!-- handoff:1 field:done topic:auth -->');
    const r = parseQmdResults(raw);
    assert.strictEqual(r[0].status, 'closed');
  });

  it('filters by topic when requested', () => {
    const raw = qmdBlock('pebbl/handoffs.md:7', '2026-05-27T09:58:50.000Z - handoff #8 done: x',
      '<!-- handoff:8 field:done topic:editor -->');
    assert.strictEqual(parseQmdResults(raw, null, 'pipeline').length, 0);
    assert.strictEqual(parseQmdResults(raw, null, 'editor').length, 1);
  });
});

describe('search - dedupeResults', () => {
  it('suppresses a handoff item that duplicates a log entry', () => {
    const results = [
      { isHandoff: false, message: 'aggression slider rewires cuts live', tier: 'component', cat: 'decision' },
      { isHandoff: true, handoffId: '8', field: 'done', message: 'handoff #8 done: aggression slider rewires cuts live' },
      { isHandoff: true, handoffId: '8', field: 'todo', message: 'handoff #8 todo: rip target_duration' },
    ];
    const out = dedupeResults(results);
    assert.strictEqual(out.length, 2);
    assert(out.some(r => !r.isHandoff));
    assert(out.some(r => r.isHandoff && r.field === 'todo'));
    assert(!out.some(r => r.isHandoff && r.field === 'done'));
  });

  it('collapses repeated handoff items across handoffs', () => {
    const results = [
      { isHandoff: true, handoffId: '7', field: 'done', message: 'handoff #7 done: same thing' },
      { isHandoff: true, handoffId: '8', field: 'done', message: 'handoff #8 done: same thing' },
    ];
    assert.strictEqual(dedupeResults(results).length, 1);
  });

  it('keeps distinct entries', () => {
    const results = [
      { isHandoff: false, message: 'thing one', tier: 'component', cat: 'decision' },
      { isHandoff: true, handoffId: '8', field: 'todo', message: 'handoff #8 todo: thing two' },
    ];
    assert.strictEqual(dedupeResults(results).length, 2);
  });
});

describe('search - formatResult', () => {
  it('renders handoff items with the prefix stripped', () => {
    const line = formatResult({ isHandoff: true, handoffId: '8', field: 'done', status: 'closed',
      date: '2026-05-27', message: 'handoff #8 done: aggression slider live', topics: 'editor' });
    assert.match(line, /\[handoff #8 · done\] 2026-05-27 — aggression slider live/);
    assert.match(line, /topics: editor/);
  });

  it('renders open handoff items with an OPEN marker', () => {
    const line = formatResult({ isHandoff: true, handoffId: '6', field: 'todo', status: 'open',
      date: '2026-05-31', message: 'handoff #6 todo: commit pebbl changes' });
    assert.match(line, /\[handoff #6 · OPEN · todo\] 2026-05-31 — commit pebbl changes/);
  });

  it('renders log entries in the classic format', () => {
    const line = formatResult({ isHandoff: false, tier: 'component', cat: 'decision',
      date: '2026-05-27', message: 'chose bcrypt', topics: 'auth' });
    assert.match(line, /\[component\|decision\] 2026-05-27 — chose bcrypt/);
  });

  it('stripHandoffPrefix handles all field types and bare summary', () => {
    assert.strictEqual(stripHandoffPrefix('handoff #8 done: x'), 'x');
    assert.strictEqual(stripHandoffPrefix('handoff #8 todo: y'), 'y');
    assert.strictEqual(stripHandoffPrefix('handoff #8: a summary'), 'a summary');
    assert.strictEqual(stripHandoffPrefix('a plain log message'), 'a plain log message');
  });
});

describe('search - searchHandoffsSqlite (no-qmd fallback)', () => {
  function dbWith(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-search-'));
    const db = new Database(path.join(dir, 'db.sqlite'));
    db.exec('CREATE TABLE handoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, summary TEXT, done TEXT, todo TEXT, blocked TEXT, topics TEXT, status TEXT, closed_at TEXT)');
    const stmt = db.prepare('INSERT INTO handoffs (summary, done, todo, blocked, topics, status, closed_at) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) stmt.run(r.summary, r.done || null, r.todo || null, r.blocked || null, r.topics || null, r.status, r.closed_at || null);
    return db;
  }

  it('finds the matching item only, in a closed handoff', () => {
    const db = dbWith([
      { summary: 'editorial pivot', done: 'intent field added; aggression slider live', todo: 'rip target_duration', topics: 'editor', status: 'closed', closed_at: '2026-05-27T09:00:00.000Z' },
    ]);
    const r = searchHandoffsSqlite(db, 'aggression', null);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].field, 'done');
    assert.strictEqual(r[0].message, 'aggression slider live');
    assert.strictEqual(r[0].handoffId, '1');
  });

  it('includes open handoffs and tags them status:open', () => {
    const db = dbWith([
      { summary: 'in-progress work', done: 'aggression thing being built', status: 'open' },
    ]);
    const r = searchHandoffsSqlite(db, 'aggression', null);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].status, 'open');
  });

  it('respects topic filter', () => {
    const db = dbWith([
      { summary: 's', todo: 'rip target_duration', topics: 'pipeline', status: 'closed', closed_at: '2026-05-27T09:00:00.000Z' },
    ]);
    assert.strictEqual(searchHandoffsSqlite(db, 'target_duration', 'editor').length, 0);
    assert.strictEqual(searchHandoffsSqlite(db, 'target_duration', 'pipeline').length, 1);
  });
});
