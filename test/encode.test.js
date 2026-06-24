'use strict';
// `pebbl recurrence` — Primitive 3 (encode): the band-aid detector. These tests
// prove the band-aid LOGIC on hand-built lessons (the PURE pieces — observeAltitude
// / summarizeSignature — driven directly via _internal, deterministic, no clock),
// the additive event/fold guarantee (existing entries fold BYTE-IDENTICAL with the
// new lesson fields present-but-absent), and the end-to-end CLI on a hermetic
// store. Design: notes/design-selflearning-primitives-2026-06-23.md §0/§3/§4.
//
// Idiom mirrors liveness.test.js / readback.test.js: a committed seed events.jsonl
// (a plain data file — the repo's .gitignore ignores any `.pebbl/`, so a store can't
// be committed under one) is copied into a fresh tmp <dir>/.pebbl/ at runtime, with
// the `.events-canonical` completeness marker so storeMode() returns 'events' and
// the CLI folds it. The HEADLINE BLOCKER — altitude is OBSERVED, not self-graded —
// is pinned by the must-trip: a claimed-root lesson whose changed_files is a lone
// leaf MUST observe `patch`, and the disagreement MUST be flagged.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { foldFull } = require('../src/fold');
const evmod = require('../src/events');
const {
  observeAltitude,
  classifyFile,
  summarizeSignature,
  lessonRowsToAttempts,
  PATTERN_THRESHOLD,
  FACTORY_GUIDE,
} = require('../src/encode')._internal;

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
const FIXTURE_EVENTS = path.join(__dirname, 'fixtures', 'encode-store', 'events.jsonl');

// Stand up a hermetic events-mode store from the committed seed, returning the
// WORKING-TREE dir (parent of .pebbl/, where find-pebbl walks up from). recurrence
// is pure-read, so a single shared store is safe across the read-only assertions.
function makeFixtureStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-encode-'));
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir, { recursive: true });
  fs.copyFileSync(FIXTURE_EVENTS, path.join(pebblDir, 'events.jsonl'));
  fs.writeFileSync(path.join(pebblDir, '.events-canonical'), 'hermetic encode fixture\n');
  return dir;
}

// Run the CLI; capture stdout + exit status without throwing. Returns { status,
// stdout, stderr }.
function runCli(cwd, args, input) {
  const res = require('child_process').spawnSync('node', [PEBBL_BIN, ...args], {
    cwd, input, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Build a lesson "attempt" the summarizer consumes, so the band-aid math is
// drivable without a store (mirrors liveness.test.js's regRow helper).
function attempt(observed, claimed, ts, eid) {
  return {
    eid: eid || `e-${ts}`,
    ts,
    altitude_observed: observed,
    altitude_claimed: claimed,
    altitude_disagreement: !!(claimed && observed && claimed !== observed),
    altitude_unobservable: observed == null,
    changed_files: [],
  };
}

// ── altitude heuristic: OBSERVED, not self-graded (the BLOCKER fix) ──────────

describe('encode: observeAltitude — altitude is inferred from the diff, never claimed', () => {
  it('a shared/definer file (lib/config/bootstrap/schema/single-definer) => root', () => {
    assert.equal(observeAltitude(['src/lib/router.js']), 'root');
    assert.equal(observeAltitude(['app.config.ts']), 'root');
    assert.equal(observeAltitude(['mac/factory-bootstrap.sh']), 'root');
    assert.equal(observeAltitude(['db/schema.sql']), 'root');
    assert.equal(observeAltitude(['src/single-definer.js']), 'root');
  });

  it('landing a test / regression-guard file => root (the fix added the catch)', () => {
    assert.equal(observeAltitude(['test/widget.test.js']), 'root');
    assert.equal(observeAltitude(['src/__tests__/foo.js']), 'root');
    assert.equal(observeAltitude(['test/regression-guard.sh']), 'root');
  });

  it('a single leaf file with NO test => patch (the symptom site, not the class)', () => {
    assert.equal(observeAltitude(['src/handlers/widget_renderer.js']), 'patch');
    assert.equal(observeAltitude(['src/routes/checkout_button.js']), 'patch');
  });

  it('several leaf files, still no test/definer => patch', () => {
    assert.equal(observeAltitude(['src/a_leaf.js', 'src/b_leaf.js']), 'patch');
  });

  it('an empty/absent changed_files => null (UNOBSERVABLE — cannot be claimed root by fiat)', () => {
    assert.equal(observeAltitude([]), null);
    assert.equal(observeAltitude(undefined), null);
    assert.equal(observeAltitude(null), null);
  });

  it('classifyFile labels test vs definer vs leaf on lowercased path segments', () => {
    assert.equal(classifyFile('test/x.js'), 'test');
    assert.equal(classifyFile('src/config/models.env'), 'definer');
    assert.equal(classifyFile('src/handlers/widget.js'), 'leaf');
  });
});

// ── frequency / resistance / flag (the band-aid math) ────────────────────────

describe('encode: summarizeSignature — frequency vs resistance, computed from OBSERVED altitude', () => {
  it('a single attempt is frequency 1, resistance 0, flag none', () => {
    const s = summarizeSignature([attempt('patch', 'patch', '2026-01-01T00:00:00.000Z')]);
    assert.equal(s.frequency, 1);
    assert.equal(s.resistance, 0);
    assert.equal(s.flag, 'none');
  });

  it('frequency >= threshold (and no resistance) => PATTERN', () => {
    const s = summarizeSignature([
      attempt('patch', 'patch', '2026-01-01T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-01-02T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-01-03T00:00:00.000Z'),
    ]);
    assert.equal(s.frequency, 3);
    assert.equal(s.resistance, 0);
    assert.equal(s.flag, 'PATTERN');
  });

  it('a recurrence AFTER an OBSERVED-root attempt => RESISTANT (the root fix did not take)', () => {
    const s = summarizeSignature([
      attempt('root', 'root', '2026-02-01T00:00:00.000Z'),   // a real root fix
      attempt('patch', 'patch', '2026-03-01T00:00:00.000Z'), // ...but it came back
    ]);
    assert.equal(s.resistance, 1);
    assert.equal(s.flag, 'RESISTANT');
  });

  it('RESISTANCE keys on OBSERVED root, NEVER the claim — a CLAIMED-root prior that only patched does NOT make a later attempt resistant', () => {
    // The prior attempt CLAIMED root but its diff only reached a leaf
    // (observed=patch). A later recurrence is therefore NOT "after a root fix":
    // no real root fix ever happened. Resistance must stay 0 (else the claim is
    // load-bearing — exactly the blocker).
    const s = summarizeSignature([
      attempt('patch', 'root', '2026-02-01T00:00:00.000Z'),  // claimed root, observed patch
      attempt('patch', 'patch', '2026-03-01T00:00:00.000Z'), // recurrence
    ]);
    assert.equal(s.resistance, 0, 'a claimed-but-not-observed root must not trigger resistance');
    assert.notEqual(s.flag, 'RESISTANT');
  });

  it('>= 2 recurrences after an observed-root attempt => STRUCTURAL (and STRUCTURAL beats RESISTANT/PATTERN)', () => {
    const s = summarizeSignature([
      attempt('root', 'root', '2026-02-01T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-03-01T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-04-01T00:00:00.000Z'),
    ]);
    assert.equal(s.resistance, 2);
    assert.equal(s.flag, 'STRUCTURAL');
  });

  it('resistance dominates frequency: a 3x signature that survived a root fix is RESISTANT, not just PATTERN', () => {
    const s = summarizeSignature([
      attempt('patch', 'patch', '2026-01-01T00:00:00.000Z'),
      attempt('root', 'root', '2026-02-01T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-03-01T00:00:00.000Z'),
    ]);
    assert.equal(s.frequency, 3);     // meets PATTERN threshold
    assert.equal(s.resistance, 1);    // but also resistant
    assert.equal(s.flag, 'RESISTANT', 'resistant outranks pattern');
  });

  it('--threshold override changes the PATTERN floor', () => {
    const two = [
      attempt('patch', 'patch', '2026-01-01T00:00:00.000Z'),
      attempt('patch', 'patch', '2026-01-02T00:00:00.000Z'),
    ];
    assert.equal(summarizeSignature(two).flag, 'none', `default threshold ${PATTERN_THRESHOLD} => 2 is below`);
    assert.equal(summarizeSignature(two, { threshold: 2 }).flag, 'PATTERN', 'threshold 2 => 2 is a pattern');
  });

  it('disagreements counts attempts whose claim contradicts the observation', () => {
    const s = summarizeSignature([
      attempt('patch', 'root', '2026-01-01T00:00:00.000Z'),  // claimed root, observed patch -> disagree
      attempt('root', 'root', '2026-01-02T00:00:00.000Z'),   // agree
    ]);
    assert.equal(s.disagreements, 1);
  });
});

// ── lessonRowsToAttempts: only signature-tagged rows become attempts ─────────

describe('encode: lessonRowsToAttempts — extracts attempts only from lesson-tagged rows', () => {
  it('a row with no signature is ignored; signature groups its attempts', () => {
    const rows = [
      { eid: 'x1', timestamp: '2026-01-01T00:00:00.000Z', message: 'plain, no signature' },
      { eid: 'x2', timestamp: '2026-01-02T00:00:00.000Z', signature: 'sig-a', fix_altitude_claimed: 'root', changed_files: ['src/lib/x.js'] },
      { eid: 'x3', timestamp: '2026-01-03T00:00:00.000Z', signature: 'sig-a', fix_altitude_claimed: 'patch', changed_files: ['src/leaf.js'] },
      { eid: 'x4', timestamp: '2026-01-04T00:00:00.000Z', signature: 'sig-b', fix_altitude_claimed: 'patch', changed_files: ['src/other.js'] },
    ];
    const bySig = lessonRowsToAttempts(rows);
    assert.equal(bySig.has('sig-a'), true);
    assert.equal(bySig.get('sig-a').length, 2, 'two sig-a attempts');
    assert.equal(bySig.get('sig-b').length, 1, 'one sig-b attempt');
    // the plain (no-signature) row never becomes an attempt
    const all = [...bySig.values()].flat();
    assert.ok(!all.some((a) => a.eid === 'x1'), 'a no-signature row is not a lesson attempt');
    // observed altitude is computed from changed_files, not the claim
    assert.equal(bySig.get('sig-a')[0].altitude_observed, 'root', 'src/lib/x.js => root');
    assert.equal(bySig.get('sig-a')[1].altitude_observed, 'patch', 'src/leaf.js => patch');
  });
});

// ── ADDITIVE FOLD: existing entries fold byte-identical with the new fields ──

describe('encode ADDITIVE FOLD — existing projections are byte-identical', () => {
  // A rich stream of EXISTING event types (mirrors fold.test.js / liveness.test.js
  // richStream), with NONE of the new lesson fields.
  function existingStream() {
    return [
      { type: 'append',        eid: 'a01', ts: '2026-01-01T00:00:00.000Z', emitted_at: '2026-01-01T00:00:00.000Z', message: 'orig db choice', category: 'decision', tier: 'component', topics: ['db'] },
      { type: 'append',        eid: 'a02', ts: '2026-01-02T00:00:00.000Z', emitted_at: '2026-01-02T00:00:00.000Z', message: 'cache warms on boot', category: 'pattern', tier: 'detail', topics: ['cache'] },
      { type: 'correct',       eid: 'a03', ts: '2026-01-03T00:00:00.000Z', emitted_at: '2026-01-03T00:00:00.000Z', message: 'use postgres not mysql', category: 'decision', tier: 'component', topics: ['db'], corrects: 'a01' },
      { type: 'append',        eid: 'a04', ts: '2026-01-04T00:00:00.000Z', emitted_at: '2026-01-04T00:00:00.000Z', message: 'fleeting note', category: 'uncategorized', tier: 'fleeting', topics: [] },
      { type: 'expire',        eid: 'a05', ts: '2026-01-05T00:00:00.000Z', emitted_at: '2026-01-05T00:00:00.000Z', target: 'a04' },
      { type: 'append',        eid: 'a06', ts: '2026-01-06T00:00:00.000Z', emitted_at: '2026-01-06T00:00:00.000Z', message: 'detail one', category: 'data', tier: 'detail', topics: ['x'] },
      { type: 'append',        eid: 'a07', ts: '2026-01-07T00:00:00.000Z', emitted_at: '2026-01-07T00:00:00.000Z', message: 'detail two', category: 'data', tier: 'detail', topics: ['x'] },
      { type: 'supersede',     eid: 'a08', ts: '2026-01-08T00:00:00.000Z', emitted_at: '2026-01-08T00:00:00.000Z', message: '[rollup] data notes on x', category: 'data', tier: 'detail', topics: ['x'], rolls_up: ['a06', 'a07'] },
      { type: 'resolve',       eid: 'a09', ts: '2026-01-09T00:00:00.000Z', emitted_at: '2026-01-09T00:00:00.000Z', target: 'a02', tier: 'foundation' },
      { type: 'handoff-open',  eid: 'h01', ts: '2026-01-10T00:00:00.000Z', emitted_at: '2026-01-10T00:00:00.000Z', summary: 'session', done: 'a; b', todo: 'c', session_entries: ['a01', 'a06'] },
      { type: 'handoff-close', eid: 'h02', ts: '2026-01-11T00:00:00.000Z', emitted_at: '2026-01-11T00:00:00.000Z', handoff: 'h01' },
      { type: 'narrative-set', eid: 'n01', ts: '2026-01-12T00:00:00.000Z', emitted_at: '2026-01-12T00:00:00.000Z', text: 'project does X', refs: ['a03'] },
    ];
  }
  // The SAME existing types, but now several carry the new lesson fields (the
  // additive surface): a tagged append + a tagged correct.
  function lessonStream() {
    return existingStream().concat([
      { type: 'append',  eid: 'L01', ts: '2026-01-13T00:00:00.000Z', emitted_at: '2026-01-13T00:00:00.000Z', message: 'tagged lesson append', category: 'correction', tier: 'detail', topics: ['fix'], signature: 'sig-x', fix_altitude_claimed: 'root', changed_files: ['src/lib/x.js'] },
      { type: 'correct', eid: 'L02', ts: '2026-01-14T00:00:00.000Z', emitted_at: '2026-01-14T00:00:00.000Z', message: 'tagged lesson correct', category: 'correction', tier: 'detail', topics: ['fix'], corrects: 'L01', signature: 'sig-x', fix_altitude_claimed: 'patch', changed_files: ['src/leaf.js'] },
    ]);
  }

  it('a stream with NO lesson fields folds byte-identical to itself (baseline)', () => {
    // Sanity: the projection of the existing-only stream is stable, and carries
    // NONE of the new keys (so the byte-comparison below is meaningful).
    const proj = foldFull(existingStream());
    const json = JSON.stringify(proj.logs);
    assert.ok(!json.includes('signature'), 'no signature key on a non-lesson stream');
    assert.ok(!json.includes('fix_altitude_claimed'), 'no fix_altitude_claimed key on a non-lesson stream');
    assert.ok(!json.includes('changed_files'), 'no changed_files key on a non-lesson stream');
  });

  it('the EXISTING rows in a lesson stream are byte-identical to the no-lesson fold (additive: present-but-absent changes nothing)', () => {
    const without = foldFull(existingStream());
    const withLessons = foldFull(lessonStream());
    // The existing rows (by eid) must serialize identically; the lesson rows are
    // strictly NEW rows appended. Compare the subset that exists in BOTH.
    const existingEids = new Set(without.logs.map((r) => r.eid));
    const withSubset = withLessons.logs.filter((r) => existingEids.has(r.eid));
    assert.equal(
      JSON.stringify(withSubset),
      JSON.stringify(without.logs),
      'existing rows must fold byte-identically whether or not lesson rows are also present',
    );
    // handoffs/commits/narrative untouched too
    assert.equal(JSON.stringify(withLessons.handoffs), JSON.stringify(without.handoffs), 'handoffs unchanged');
    assert.equal(JSON.stringify(withLessons.commits), JSON.stringify(without.commits), 'commits unchanged');
    assert.equal(JSON.stringify(withLessons.narrative), JSON.stringify(without.narrative), 'narrative unchanged');
  });

  it('a tagged lesson row CARRIES the new fields through the fold (present when present)', () => {
    const proj = foldFull(lessonStream());
    const tagged = proj.logs.find((r) => r.eid === 'L01');
    assert.ok(tagged, 'the tagged lesson append is a live row');
    assert.equal(tagged.signature, 'sig-x');
    assert.equal(tagged.fix_altitude_claimed, 'root');
    assert.deepEqual(tagged.changed_files, ['src/lib/x.js']);
  });

  it('makeAppendEvent / makeCorrectEvent OMIT the lesson keys entirely when not supplied (wire stays byte-clean)', () => {
    const pebblDir = path.join(os.tmpdir(), 'no-store'); // makers do not touch disk except git config
    const plain = evmod.makeAppendEvent(pebblDir, { message: 'no lesson', category: 'data', tier: 'detail' });
    assert.ok(!('signature' in plain), 'no signature key on a plain append');
    assert.ok(!('fix_altitude_claimed' in plain), 'no fix_altitude_claimed key on a plain append');
    assert.ok(!('changed_files' in plain), 'no changed_files key on a plain append');
    const tagged = evmod.makeAppendEvent(pebblDir, { message: 'lesson', category: 'correction', tier: 'detail', signature: 'sig', fix_altitude_claimed: 'root', changed_files: ['src/lib/x.js'] });
    assert.equal(tagged.signature, 'sig');
    assert.equal(tagged.fix_altitude_claimed, 'root');
    assert.deepEqual(tagged.changed_files, ['src/lib/x.js']);
    // a bogus claim value is dropped (only patch|root survive)
    const bogus = evmod.makeAppendEvent(pebblDir, { message: 'x', signature: 'sig', fix_altitude_claimed: 'wishful' });
    assert.ok(!('fix_altitude_claimed' in bogus), 'a non-patch/root claim is not stamped');
  });
});

// ── END-TO-END: the real CLI on a hermetic store ─────────────────────────────

describe('encode CLI — recurrence on the committed seed', () => {
  // POSITIVE / RESISTANCE: the GLM-judge saga. A first claimed-root attempt whose
  // changed_files (bootstrap + config/models.env) make altitude_observed=root,
  // then a LATER recurrence of the SAME signature => RESISTANT.
  it('recurrence glm-judge-bills-zero => flag RESISTANT, frequency reflects the count', () => {
    const dir = makeFixtureStore();
    const res = runCli(dir, ['recurrence', 'glm-judge-bills-zero', '--json']);
    assert.equal(res.status, 0, `recurrence should exit 0\n${res.stderr}`);
    const r = JSON.parse(res.stdout);
    assert.equal(r.flag, 'RESISTANT', `expected RESISTANT, got ${r.flag}`);
    assert.equal(r.frequency, 2, 'frequency reflects the two attempts');
    assert.equal(r.resistance, 1, 'one recurrence after the observed-root attempt');
    // the first attempt is OBSERVED root (its diff hit bootstrap + config/models.env)
    assert.equal(r.attempts[0].altitude_observed, 'root', 'attempt 1 observed root from its diff');
    assert.equal(r.last_seen, '2026-03-01T00:00:00.000Z');
  });

  // MUST-TRIP: altitude can't be self-graded. A lesson fix_altitude_claimed=root
  // whose changed_files is a single leaf with no test => observed=patch AND the
  // claimed-vs-observed disagreement is flagged. If this can't go red, the
  // altitude field is decorative.
  it('MUST-TRIP: leaf-only-claimed-root observes PATCH despite claiming root, and the disagreement is flagged', () => {
    const dir = makeFixtureStore();
    const res = runCli(dir, ['recurrence', 'leaf-only-claimed-root', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const r = JSON.parse(res.stdout);
    const a = r.attempts[0];
    assert.equal(a.altitude_claimed, 'root', 'the agent CLAIMED root');
    assert.equal(a.altitude_observed, 'patch', 'but the diff (one leaf, no test) OBSERVES patch');
    assert.equal(a.altitude_disagreement, true, 'the claimed-vs-observed disagreement MUST be flagged');
    assert.equal(r.disagreements, 1, 'the summary counts the disagreement');
  });

  // NEGATIVE: a novel signature seen once => flag none; an unrelated signature is
  // not counted into another's frequency.
  it('NEGATIVE: novel-thing-once => flag none, frequency 1', () => {
    const dir = makeFixtureStore();
    const r = JSON.parse(runCli(dir, ['recurrence', 'novel-thing-once', '--json']).stdout);
    assert.equal(r.flag, 'none');
    assert.equal(r.frequency, 1);
  });

  it('NEGATIVE: an unrelated signature is NOT counted into glm-judge-bills-zero (frequency stays exactly 2)', () => {
    const dir = makeFixtureStore();
    const glm = JSON.parse(runCli(dir, ['recurrence', 'glm-judge-bills-zero', '--json']).stdout);
    assert.equal(glm.frequency, 2, 'unrelated-other / leaf / novel must not pollute the glm count');
    // and a never-seen signature is frequency 0 / none
    const missing = JSON.parse(runCli(dir, ['recurrence', 'never-ever-seen', '--json']).stdout);
    assert.equal(missing.frequency, 0);
    assert.equal(missing.flag, 'none');
  });

  it('recurrence --scan --json lists exactly the over-threshold/resistant signatures (the GLM saga), not the below-threshold ones', () => {
    const dir = makeFixtureStore();
    const res = runCli(dir, ['recurrence', '--scan', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(Array.isArray(out.signatures), 'scan returns a signatures array');
    const names = out.signatures.map((s) => s.signature);
    assert.ok(names.includes('glm-judge-bills-zero'), 'the RESISTANT signature must be in the scan');
    assert.ok(!names.includes('novel-thing-once'), 'a frequency-1 signature must NOT be in the scan');
    assert.ok(!names.includes('leaf-only-claimed-root'), 'a below-threshold signature must NOT be in the scan');
    const glm = out.signatures.find((s) => s.signature === 'glm-judge-bills-zero');
    assert.equal(glm.flag, 'RESISTANT');
  });

  it('a recurrence read is PURE — it does not write to the store (events.jsonl byte-unchanged)', () => {
    const dir = makeFixtureStore();
    const file = path.join(dir, '.pebbl', 'events.jsonl');
    const before = fs.readFileSync(file);
    runCli(dir, ['recurrence', 'glm-judge-bills-zero', '--json']);
    runCli(dir, ['recurrence', '--scan', '--json']);
    assert.deepEqual(fs.readFileSync(file), before, 'recurrence must never mutate the store');
  });
});

// ── --factory-guide: the static integration manifest (B3) ────────────────────

describe('encode --factory-guide — trigger-condition manifest with BUILT|PLANNED edges', () => {
  it('--factory-guide --json emits valid JSON whose every edge carries BUILT|PLANNED status', () => {
    const r = runCli(os.tmpdir(), ['recurrence', '--factory-guide', '--json']); // static, no store
    assert.equal(r.status, 0, `--factory-guide should exit 0\n${r.stderr}`);
    const g = JSON.parse(r.stdout);
    assert.equal(g.command, 'recurrence');
    assert.ok(g.call_when && g.precondition && g.effect && g.consumes && g.produces);
    assert.ok(Array.isArray(g.edges) && g.edges.length > 0);
    for (const e of g.edges) {
      assert.ok(['BUILT', 'PLANNED'].includes(e.status), `edge ${e.to} has bad status ${e.status}`);
    }
  });

  it('the routing edges (PATTERN->inbox, RESISTANT->Ashley) and commit-linked changed_files are tagged PLANNED', () => {
    const g = FACTORY_GUIDE;
    const routing = g.edges.filter((e) => /inbox|ashley|falsified/i.test(e.to));
    assert.ok(routing.length >= 1, 'a routing edge exists');
    assert.ok(routing.every((e) => e.status === 'PLANNED'), 'routing is PLANNED (new-factory wiring)');
    const diff = g.edges.find((e) => /changed_files/i.test(e.to));
    assert.ok(diff && diff.status === 'PLANNED', 'commit-linked changed_files is PLANNED');
  });

  it('--factory-guide (human) prints trigger-conditions + BUILT|PLANNED without touching a store', () => {
    const r = runCli(os.tmpdir(), ['recurrence', '--factory-guide']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /trigger-conditions/i);
    assert.match(r.stdout, /\[BUILT\]/);
    assert.match(r.stdout, /\[PLANNED\]/);
  });
});

// ── CLI surface: help + usage ────────────────────────────────────────────────

describe('encode CLI surface', () => {
  it('recurrence --help exits 0 and prints usage (RESISTANT, OBSERVED altitude)', () => {
    const r = runCli(process.cwd(), ['recurrence', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pebbl recurrence/);
    assert.match(r.stdout, /RESISTANT/);
    assert.match(r.stdout, /OBSERVED/);
  });

  it('recurrence with no signature and no --scan/--factory-guide errors with usage', () => {
    const r = runCli(makeFixtureStore(), ['recurrence']);
    assert.equal(r.status, 1, 'a bare recurrence with no signature must exit non-zero');
    assert.match(r.stderr, /Usage: pebbl recurrence/);
  });
});
