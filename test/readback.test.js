'use strict';
// `pebbl readback` — the tracer self-learning primitive: surface colliding prior
// work for an incoming task spec so the factory resumes/supersedes instead of
// rebuilding. These tests prove SELECTION (not string-match) on a HERMETIC
// fixture store (test/fixtures/readback-store), seeded from the real Appendix-A
// collision pair plus the must-NOT-trip and blind-spot fixtures. Design:
// notes/design-selflearning-primitives-2026-06-23.md §0/§1/§4.
//
// Idiom mirrors search-fts5.test.js / events.test.js: build the store in a
// TMPDIR at runtime (the repo's .gitignore ignores any `.pebbl/`, so a store
// can't be committed under one), then drive the REAL CLI via execFileSync with
// cwd = that store so storeMode/find-pebbl behave exactly as in production. The
// committed fixture is a plain `events.jsonl` data file (NOT under .pebbl/); we
// copy it into <tmp>/.pebbl/ and write the `.events-canonical` completeness
// marker so storeMode() returns 'events' and readback folds it. readback is
// pure-read, so it never writes into the store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
// The committed seed data (plain file, escapes the .pebbl/ gitignore).
const FIXTURE_EVENTS = path.join(__dirname, 'fixtures', 'readback-store', 'events.jsonl');

// Stand up a hermetic events-mode store in a fresh tmpdir from the committed
// seed, returning the store's WORKING-TREE dir (the parent of .pebbl/, which is
// where find-pebbl walks up from). Built once and reused across the read-only
// assertions below.
function makeFixtureStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-readback-'));
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  fs.copyFileSync(FIXTURE_EVENTS, path.join(pebblDir, 'events.jsonl'));
  // The positive completeness marker -> storeMode() === 'events' (no git needed).
  fs.writeFileSync(path.join(pebblDir, '.events-canonical'), 'hermetic readback fixture\n');
  return dir;
}

const FIXTURE_DIR = makeFixtureStore();

// Run `pebbl readback` against the fixture store with a spec passed on STDIN
// (the `-` source), returning the parsed --json result array. Stdin keeps the
// query OUT of argv (so a paraphrase with spaces/punctuation needs no quoting)
// and also exercises the `-` read path.
function readback(spec, extraArgs = []) {
  const out = execFileSync('node', [PEBBL_BIN, 'readback', '-', '--json', ...extraArgs], {
    cwd: FIXTURE_DIR,
    input: spec,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

// Convenience: the result entry for a given eid prefix (the fixture uses the
// real 26-char eids for the seed pair; a prefix match keeps assertions short).
function byEidPrefix(results, prefix) {
  return results.find((r) => r.eid.startsWith(prefix));
}

const SEED_A = '01KV3F6EEF'; // "seed heartbeat from a literal, not the live file"
const SEED_B = '01KV3FYFG9'; // "fixed test-triage-watermark.sh fixture rot"

// ── POSITIVE: paraphrased query surfaces the real collision pair, ranked #1 ───

describe('readback POSITIVE — paraphrase surfaces the colliding prior fix', () => {
  // The query NAMES NEITHER eid NOR the exact `test-triage-watermark.sh` casing;
  // it paraphrases ("the triage watermark test ... live heartbeat file ... rots").
  // Only SELECTION (identifier-aware extraction + FTS5 stem/match + artifact-
  // component collision) can connect it to the seeded fixes — proving this is not
  // a `.includes` string match.
  const PARAPHRASE =
    'the triage watermark test seeds from the live heartbeat file and rots';

  it('returns both seeded eids with collision=true', () => {
    const res = readback(PARAPHRASE);
    const a = byEidPrefix(res, SEED_A);
    const b = byEidPrefix(res, SEED_B);
    assert.ok(a, `expected a result for ${SEED_A}`);
    assert.ok(b, `expected a result for ${SEED_B}`);
    assert.equal(a.collision, true, `${SEED_A} must be a COLLISION`);
    assert.equal(b.collision, true, `${SEED_B} must be a COLLISION`);
  });

  it('the query never names the eids or the exact filename casing (selection, not string-match)', () => {
    // Guard the test's own premise: if the query literally contained an eid or
    // the exact artifact filename, a string match could "pass" trivially.
    assert.doesNotMatch(PARAPHRASE, new RegExp(SEED_A, 'i'));
    assert.doesNotMatch(PARAPHRASE, new RegExp(SEED_B, 'i'));
    assert.doesNotMatch(PARAPHRASE, /test-triage-watermark\.sh/i);
  });

  it('a collision is ranked #1 (collisions sort ABOVE non-collision matches)', () => {
    const res = readback(PARAPHRASE);
    assert.ok(res.length > 0, 'expected at least one result');
    assert.equal(res[0].collision, true, 'the top result must be a collision');
    // The #1 result is one of the required seed pair (not some other entry).
    assert.ok(
      res[0].eid.startsWith(SEED_A) || res[0].eid.startsWith(SEED_B),
      `#1 should be one of the seed pair, got ${res[0].eid}`
    );
    // Every required-pair collision outranks every NON-collision result.
    const lastCollisionIdx = res.map((r) => r.collision).lastIndexOf(true);
    const firstNonCollisionIdx = res.findIndex((r) => !r.collision);
    if (firstNonCollisionIdx !== -1) {
      assert.ok(
        lastCollisionIdx < firstNonCollisionIdx,
        'all collisions must sort above all non-collisions'
      );
    }
  });

  it('matched_on carries the shared ARTIFACT components, not a topic word', () => {
    const res = readback(PARAPHRASE);
    const a = byEidPrefix(res, SEED_A);
    // It collided on pieces of `test-triage-watermark.sh` / `triage-heartbeat.txt`.
    assert.ok(a.matched_on.length > 0, 'matched_on must be non-empty for a collision');
    assert.ok(
      a.matched_on.includes('watermark') || a.matched_on.includes('heartbeat'),
      `expected an artifact component, got ${JSON.stringify(a.matched_on)}`
    );
    // The ambient word "factory" must never be a collision anchor.
    assert.ok(!a.matched_on.includes('factory'), 'a topic word must not anchor a collision');
  });

  it('the JSON shape is [{eid, matched_on, score, collision, verdict_hint}]', () => {
    const res = readback(PARAPHRASE);
    for (const r of res) {
      assert.ok(typeof r.eid === 'string' && r.eid.length > 0);
      assert.ok(Array.isArray(r.matched_on));
      assert.equal(typeof r.score, 'number');
      assert.equal(typeof r.collision, 'boolean');
      assert.equal(typeof r.verdict_hint, 'string');
    }
  });
});

// ── MUST-NOT-TRIP: three false-positive traps ────────────────────────────────

describe('readback MUST-NOT-TRIP — no false collisions', () => {
  it('the jotter rebuild-each-pass fixture does NOT collide', () => {
    // Querying the jotter's own situation must not flag a collision: the jotter
    // entry is fleeting+hook (filtered OUT of the reasoning corpus), and nothing
    // else shares an artifact with it.
    const res = readback('the morning jotter rebuilds itself every pass and is never stable');
    assert.ok(
      res.every((r) => !r.collision),
      `jotter query produced a collision: ${JSON.stringify(res.filter((r) => r.collision))}`
    );
  });

  it('a genuinely novel artifact returns an empty result', () => {
    // No shared vocabulary with any reasoning entry -> nothing matches at all.
    const res = readback('implement Bluetooth pairing for the wristband firmware over GATT');
    assert.deepEqual(res, [], `expected empty, got ${JSON.stringify(res)}`);
  });

  it('two tasks sharing only the ambient words {factory, review} do NOT collide', () => {
    // "factory" and "review" are ambient — sharing only them is not a collision.
    const res = readback('set up a factory review cadence for the new onboarding flow');
    assert.ok(
      res.every((r) => !r.collision),
      `ambient-only query produced a collision: ${JSON.stringify(res.filter((r) => r.collision))}`
    );
  });
});

// ── BLIND SPOT: a commit-only precedent is invisible (documented limitation) ──

describe('readback BLIND SPOT — a commit-only precedent is NOT surfaced', () => {
  it('a precedent recorded ONLY as a type==commit entry is invisible until the two-store split', () => {
    // The fixture carries a commit-only precedent for billing/payment_retry.go.
    // It folds into the commits side-channel, NEVER into the reasoning log set,
    // so readback cannot see it — asserted here so the limitation is EXPLICIT,
    // not accidental (it lifts once the two-store split lands; out of scope now).
    const res = readback('add a circuit breaker to payment_retry.go so a flaky downstream cannot cascade');
    assert.ok(
      !res.some((r) => r.eid.startsWith('01KV3COMMITONLY')),
      'the commit-only precedent must NOT be surfaced'
    );
    // And it certainly must not be reported as a collision.
    assert.ok(res.every((r) => !r.collision), 'no collision should come from a commit-only precedent');
  });
});

// ── --factory-guide: the static integration manifest ─────────────────────────

describe('readback --factory-guide — trigger-condition manifest with BUILT|PLANNED edges', () => {
  function guide(extraArgs = []) {
    const out = execFileSync('node', [PEBBL_BIN, 'readback', '--factory-guide', ...extraArgs], {
      cwd: os.tmpdir(), // no store needed: the guide is static
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out;
  }

  it('--factory-guide --json emits valid JSON whose every edge carries BUILT|PLANNED status', () => {
    const g = JSON.parse(guide(['--json']));
    assert.equal(g.command, 'readback');
    assert.ok(g.call_when && g.precondition && g.effect && g.consumes && g.produces);
    assert.ok(Array.isArray(g.edges) && g.edges.length > 0);
    for (const e of g.edges) {
      assert.ok(['BUILT', 'PLANNED'].includes(e.status), `edge ${e.to} has bad status ${e.status}`);
    }
    // It names trigger-conditions, not host stage names: the declared downstream
    // (L20 structural-read) is PLANNED; the sibling it actually rides is BUILT.
    const l20 = g.edges.find((e) => /L20/i.test(e.to));
    const search = g.edges.find((e) => /search/i.test(e.to));
    assert.ok(l20 && l20.status === 'PLANNED', 'L20 structural-read must be PLANNED');
    assert.ok(search && search.status === 'BUILT', 'pebbl search must be BUILT');
  });

  it('--factory-guide (human) prints without touching a store and exits 0', () => {
    const text = guide([]);
    assert.match(text, /trigger-conditions/i);
    assert.match(text, /\[BUILT\]/);
    assert.match(text, /\[PLANNED\]/);
  });
});

// ── CLI surface: help + a spec FILE path ─────────────────────────────────────

describe('readback CLI surface', () => {
  it('readback --help exits 0 and prints usage', () => {
    const out = execFileSync('node', [PEBBL_BIN, 'readback', '--help'], { encoding: 'utf8' });
    assert.match(out, /pebbl readback/);
    assert.match(out, /COLLIDE/i);
  });

  it('reads a spec from a FILE path (not just stdin)', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-spec-')), 'task.md');
    fs.writeFileSync(tmp, 'fix the triage watermark fixture: it seeds from the live heartbeat file');
    const out = execFileSync('node', [PEBBL_BIN, 'readback', tmp, '--json'], {
      cwd: FIXTURE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const res = JSON.parse(out);
    assert.ok(byEidPrefix(res, SEED_A) || byEidPrefix(res, SEED_B), 'file-path spec should surface the seed pair');
    assert.ok(res.some((r) => r.collision), 'file-path spec should produce a collision');
  });

  it('--top N truncates the result list', () => {
    const all = readback('the triage watermark test seeds from the live heartbeat file and rots');
    const top1 = readback('the triage watermark test seeds from the live heartbeat file and rots', ['--top', '1']);
    assert.ok(all.length >= 1);
    assert.equal(top1.length, 1);
    assert.equal(top1[0].eid, all[0].eid, '--top keeps the same #1');
  });
});
