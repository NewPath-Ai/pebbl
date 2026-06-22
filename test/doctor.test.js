'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { _internal } = require('../src/doctor');
const {
  detectContradictions,
  detectStaleness,
  detectMissing,
  detectHandoffHealth,
  diagnose,
  toJson,
  contentTerms,
  jaccard,
  pairKey,
} = _internal;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-doctor-'));
// A current belief by default: valid_to is implied NULL (the DB query filters
// it; the pure detectors never see superseded rows, so fixtures are all current).
const entry = (o) => ({
  id: 1,
  tier: 'detail',
  category: 'decision',
  timestamp: '2026-06-10T00:00:00Z',
  message: 'x',
  topics: '',
  relates_to: null,
  corrects: null,
  ...o,
});

// ── shared helpers ───────────────────────────────────────────────────────────

describe('doctor - helpers', () => {
  it('contentTerms splits a message into normalized distinct tokens', () => {
    assert.deepEqual([...contentTerms('Threshold is 0.5! threshold THRESHOLD')].sort(),
      ['0', '5', 'is', 'threshold']);
  });
  it('jaccard is 1 for identical sets, 0 for disjoint', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
  it('pairKey is order-independent', () => {
    assert.equal(pairKey(3, 7), pairKey(7, 3));
  });
});

// ── detector 1: contradictions ───────────────────────────────────────────────

describe('doctor - detectContradictions', () => {
  it('flags two unlinked current entries on a shared topic with high overlap', () => {
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    const out = detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 });
    assert.equal(out.length, 1);
    // The OLDER entry (#1) is marked the likely-superseded one.
    assert.equal(out[0].older.id, 1);
    assert.equal(out[0].newer.id, 2);
    assert.ok(out[0].sharedTopics.includes('auth'));
  });

  it('does NOT flag a pair already linked via corrects', () => {
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth', corrects: 1,
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    assert.equal(detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 }).length, 0);
  });

  it('does NOT flag entries that share no topic', () => {
    const entries = [
      entry({ id: 1, topics: 'auth', message: 'the threshold is 0.2 because conservative' }),
      entry({ id: 2, topics: 'billing', message: 'the threshold is 0.5 because conservative' }),
    ];
    assert.equal(detectContradictions(entries, { overlap: 0.5, cap: 5, minTerms: 3 }).length, 0);
  });

  it('respects the cap', () => {
    const mk = (id) => entry({ id, topics: 'auth',
      message: `the auth threshold is 0.${id} because it is conservative and tuned` });
    const entries = [mk(1), mk(2), mk(3), mk(4)];
    const out = detectContradictions(entries, { overlap: 0.5, cap: 1, minTerms: 3 });
    assert.equal(out.length, 1);
  });

  it('never mutates the input entries', () => {
    const entries = [
      entry({ id: 1, topics: 'auth', message: 'the auth threshold is 0.2 conservative' }),
      entry({ id: 2, topics: 'auth', message: 'the auth threshold is 0.5 conservative' }),
    ];
    const before = JSON.stringify(entries);
    detectContradictions(entries, {});
    assert.equal(JSON.stringify(entries), before);
  });
});

// ── detector 2: staleness ─────────────────────────────────────────────────────

describe('doctor - detectStaleness', () => {
  const now = '2026-06-20T00:00:00Z';

  it('flags an old un-reinforced component/detail entry', () => {
    const entries = [
      entry({ id: 1, tier: 'component', topics: 'legacy', timestamp: '2025-01-01T00:00:00Z',
        message: 'the legacy importer runs nightly' }),
    ];
    const out = detectStaleness(entries, { horizonDays: 180, cap: 3, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, 1);
  });

  it('does NOT flag if a newer entry on the same topic reinforces it', () => {
    const entries = [
      entry({ id: 1, tier: 'component', topics: 'legacy', timestamp: '2025-01-01T00:00:00Z',
        message: 'the legacy importer runs nightly' }),
      entry({ id: 2, tier: 'detail', topics: 'legacy', timestamp: '2026-06-01T00:00:00Z',
        message: 'legacy importer still nightly, confirmed' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });

  it('excludes foundation (durable by design) and fleeting (noise)', () => {
    const entries = [
      entry({ id: 1, tier: 'foundation', topics: 'core', timestamp: '2024-01-01T00:00:00Z',
        message: 'uses sqlite for the store' }),
      entry({ id: 2, tier: 'fleeting', topics: 'core', timestamp: '2024-01-01T00:00:00Z',
        message: 'tmp note about the store' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });

  it('does NOT flag a recent entry', () => {
    const entries = [
      entry({ id: 1, tier: 'detail', topics: 'legacy', timestamp: now,
        message: 'the legacy importer runs nightly' }),
    ];
    assert.equal(detectStaleness(entries, { horizonDays: 180, cap: 3, now }).length, 0);
  });
});

// ── detector 3: missing artifact (reuses check.js) ────────────────────────────

describe('doctor - detectMissing (reuses check.js)', () => {
  it('flags an entry citing a file that does not exist; spares the present one', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/present.js'), 'x');
    const entries = [
      entry({ id: 1, message: 'uses src/present.js for X' }),
      entry({ id: 2, message: 'the gone src/missing.js does Y' }),
    ];
    const out = detectMissing(entries, repo, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, 2);
    assert.deepEqual(out[0].entry.missingPaths, ['src/missing.js']);
  });
});

// ── detector 4: handoff health (lifecycle) ────────────────────────────────────

describe('doctor - detectHandoffHealth', () => {
  const now = '2026-06-22T00:00:00Z';
  const ho = (o) => ({ id: 1, timestamp: now, summary: 'real work summary', status: 'open', ...o });

  it('flags a MALFORMED open handoff (bare number)', () => {
    const out = detectHandoffHealth([ho({ id: 7, summary: '4' })], { openDays: 14, cap: 10, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].handoff.id, 7);
    assert.ok(out[0].malformed, 'carries a malformed reason');
  });

  it('flags a LONG-OPEN handoff (open past the threshold)', () => {
    const out = detectHandoffHealth(
      [ho({ id: 3, timestamp: '2026-05-01T00:00:00Z' })], // ~52d before now
      { openDays: 14, cap: 10, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].handoff.id, 3);
    assert.equal(out[0].malformed, null);
    assert.ok(out[0].longOpen);
    assert.ok(out[0].ageDays >= 14);
  });

  it('does NOT flag a recent, well-formed open handoff', () => {
    const out = detectHandoffHealth([ho({ id: 1, timestamp: now })], { openDays: 14, cap: 10, now });
    assert.equal(out.length, 0);
  });

  it('does NOT flag a CLOSED handoff even if old/malformed', () => {
    const out = detectHandoffHealth(
      [ho({ id: 9, summary: '5', status: 'closed', timestamp: '2026-01-01T00:00:00Z' })],
      { openDays: 14, cap: 10, now });
    assert.equal(out.length, 0);
  });

  it('respects the cap and sorts malformed before merely-old', () => {
    const handoffs = [
      ho({ id: 1, timestamp: '2026-05-01T00:00:00Z' }),        // old, well-formed
      ho({ id: 2, summary: '12', timestamp: now }),            // malformed, recent
      ho({ id: 3, timestamp: '2026-04-01T00:00:00Z' }),        // older, well-formed
    ];
    const out = detectHandoffHealth(handoffs, { openDays: 14, cap: 2, now });
    assert.equal(out.length, 2);
    assert.ok(out[0].malformed, 'malformed sorts first');
    assert.equal(out[0].handoff.id, 2);
  });
});

// ── compose + clean-store + json ──────────────────────────────────────────────

describe('doctor - diagnose (composition)', () => {
  it('clean store: every dimension empty', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'x');
    const entries = [
      entry({ id: 1, tier: 'foundation', topics: 'core', timestamp: '2026-06-19T00:00:00Z',
        message: 'uses src/a.js as the entry point' }),
    ];
    const r = diagnose(entries, repo, { now: '2026-06-20T00:00:00Z' });
    assert.equal(r.contradictions.length, 0);
    assert.equal(r.staleness.length, 0);
    assert.equal(r.missing.length, 0);
    assert.equal(toJson(r).length, 0);
  });

  it('a malformed open handoff surfaces in the json contract with a close hint', () => {
    const repo = tmp();
    const r = diagnose([], repo, {
      now: '2026-06-22T00:00:00Z',
      handoffs: [{ id: 7, timestamp: '2026-06-22T00:00:00Z', summary: '4', status: 'open' }],
    });
    assert.equal(r.handoffs.length, 1);
    const json = toJson(r);
    const hit = json.find(c => c.dimension === 'handoff');
    assert.ok(hit, 'a handoff candidate is emitted');
    assert.deepEqual(hit.ids, [7]);
    assert.match(hit.reason, /malformed/);
    assert.match(hit.suggested, /pebbl handoff --close 7/);
  });

  it('clean store with no handoffs: handoff dimension empty', () => {
    const repo = tmp();
    const r = diagnose([], repo, { now: '2026-06-22T00:00:00Z' }); // no opts.handoffs
    assert.equal(r.handoffs.length, 0);
  });

  it('known contradiction surfaces in the json contract', () => {
    const repo = tmp();
    const entries = [
      entry({ id: 1, timestamp: '2026-01-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.2 because it is conservative' }),
      entry({ id: 2, timestamp: '2026-06-01T00:00:00Z', topics: 'auth',
        message: 'the auth threshold is 0.5 because it is conservative' }),
    ];
    const r = diagnose(entries, repo, { contradictionOverlap: 0.5, now: '2026-06-20T00:00:00Z' });
    const json = toJson(r);
    const hit = json.find(c => c.dimension === 'contradiction');
    assert.ok(hit, 'a contradiction candidate is emitted');
    assert.deepEqual(hit.ids.sort(), [1, 2]);
    assert.match(hit.suggested, /pebbl log ".*" --corrects 1/);
  });
});
