'use strict';

// context ordering — the live read-path wiring (FIX, v0.7). On the targeted
// retrieval path (`pebbl context --topic <x>`), entries come back in rerank order
// (importance + usage, id-DESC tiebreak), NOT the old tier-then-id order, and the
// current-belief filter (valid_to IS NULL) is intact (a superseded row never
// surfaces). We exercise the REAL CLI against a seeded store and read the order
// out of the printed output, so this proves the wiring, not a reimplementation.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');
const dirs = [];

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// Seed a store with one cheap CLI command (so openDb runs the migration chain and
// creates the schema), then overwrite the logs table directly so we control every
// signal column (importance, access_count, valid_to). We re-stamp the rows AFTER
// the schema exists so the migration cannot clobber our deliberate values. We skip
// `pebbl init` (far slower here, and unneeded — context only requires a .pebbl dir).
function seededProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-ctxorder-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.pebbl'));
  // One throwaway log creates db.sqlite via openDb -> migrate (to v0.7).
  spawnSync('node', [BIN, 'log', 'seed', '--tier', 'detail', '--cat', 'quality'],
    { cwd: d, encoding: 'utf8' });

  // This test seeds db.sqlite DIRECTLY (hand-stuffed rows below), which is the
  // LEGACY (db.sqlite-truth) read contract. The throwaway `seed` log above also
  // wrote an events.jsonl, which would flip the store to events-mode and make
  // `context` read the folded view.sqlite (Wire 2 reads-from-fold) instead of
  // our hand-stuffed db.sqlite — surfacing only "seed", not our fixtures. Remove
  // the events artifacts so the store is unambiguously legacy and this test
  // exercises the db.sqlite rerank read path exactly as before. (Events-mode
  // reads-from-fold ordering is covered by shared-mode.test.js via a REAL log
  // path where events.jsonl and db.sqlite agree.)
  for (const f of ['events.jsonl', 'events.local.jsonl', 'view.sqlite']) {
    try { fs.rmSync(path.join(d, '.pebbl', f), { force: true }); } catch {}
  }

  const db = new Database(path.join(d, '.pebbl', 'db.sqlite'));
  db.exec('DELETE FROM logs');
  const ins = db.prepare(`
    INSERT INTO logs (id, timestamp, source, category, tier, message, topics,
                      valid_from, valid_to, importance, access_count)
    VALUES (@id, @timestamp, 'human', @category, @tier, @message, @topics,
            @timestamp, @valid_to, @importance, @access_count)
  `);

  // All on topic 'svc'. Two COMPONENT entries with the SAME importance (4): the
  // old live order would be id-DESC (id 11 before id 10). We give the OLDER,
  // lower-id one (10) some usage so rerank ranks it ABOVE the newer 11 — an order
  // tier-then-id can never produce. The usage is moderate (access_count 2) so its
  // score stays below the unused foundation, which proves importance dominates AND
  // usage breaks within-tier ties. (A much larger access_count would correctly lift
  // a component over an unused foundation; we keep it moderate to isolate one
  // effect per assertion.)
  ins.run({ id: 10, timestamp: '2026-01-01T00:00:00.000Z', category: 'decision',
            tier: 'component', message: 'COMP-HOT used a lot', topics: 'svc',
            valid_to: null, importance: 4, access_count: 2 });
  ins.run({ id: 11, timestamp: '2026-02-01T00:00:00.000Z', category: 'decision',
            tier: 'component', message: 'COMP-COLD never used', topics: 'svc',
            valid_to: null, importance: 4, access_count: 0 });
  // A foundation entry (importance 5) must still lead — importance dominates.
  ins.run({ id: 12, timestamp: '2026-03-01T00:00:00.000Z', category: 'decision',
            tier: 'foundation', message: 'FOUND-lead', topics: 'svc',
            valid_to: null, importance: 5, access_count: 0 });
  // A SUPERSEDED component (valid_to set) — must NEVER surface (filter intact).
  ins.run({ id: 13, timestamp: '2026-02-15T00:00:00.000Z', category: 'decision',
            tier: 'component', message: 'COMP-SUPERSEDED hidden', topics: 'svc',
            valid_to: '2026-03-01T00:00:00.000Z', importance: 9, access_count: 99 });
  db.close();
  return d;
}

// Run `context --topic svc` and return the message lines in printed order.
function topicOrder(dir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // recordAccess may fire; ordering is what we read
  const res = spawnSync('node', [BIN, 'context', '--topic', 'svc'], { cwd: dir, env, encoding: 'utf8' });
  const out = res.stdout || '';
  // displayEntry prints "[tier|category] DATE — message"; pull our marker tokens.
  const markers = ['FOUND-lead', 'COMP-HOT', 'COMP-COLD', 'COMP-SUPERSEDED'];
  const seen = [];
  for (const line of out.split('\n')) {
    for (const m of markers) {
      if (line.includes(m) && !seen.includes(m)) seen.push(m);
    }
  }
  return { order: seen, raw: out };
}

describe('context --topic ordering is rerank order, valid_to filter intact', () => {
  it('returns entries in rerank order (not tier-then-id) with the superseded row filtered out', () => {
    const dir = seededProject();
    const { order, raw } = topicOrder(dir);

    // Current-belief filter: the superseded row never appears.
    assert.ok(!order.includes('COMP-SUPERSEDED'),
      'superseded (valid_to set) entry must not surface:\n' + raw);

    // Importance dominates: the foundation entry leads.
    assert.strictEqual(order[0], 'FOUND-lead', 'foundation (importance 5) ranks first:\n' + raw);

    // Within the component tier, rerank puts the HEAVILY-USED older/lower-id entry
    // ABOVE the unused newer/higher-id one. The OLD live order (tier-then-id DESC)
    // would have ranked COMP-COLD (id 11) before COMP-HOT (id 10); rerank flips it.
    const hot = order.indexOf('COMP-HOT');
    const cold = order.indexOf('COMP-COLD');
    assert.ok(hot !== -1 && cold !== -1, 'both component entries present:\n' + raw);
    assert.ok(hot < cold,
      'rerank must rank the heavily-used COMP-HOT above the unused COMP-COLD ' +
      '(the old tier-then-id order would not):\n' + raw);

    // Full expected rerank order.
    assert.deepStrictEqual(order, ['FOUND-lead', 'COMP-HOT', 'COMP-COLD'],
      'unexpected order:\n' + raw);
  });
});
