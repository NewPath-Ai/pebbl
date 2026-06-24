'use strict';
// test/factory-guide.test.js — BYTE-IDENTICAL guard for the shared --factory-guide
// printer (src/factory-guide.js). The renderer is now ONE function shared by
// readback, liveness (check + heartbeat) and encode(recurrence); each module still
// owns its manifest DATA. These frozen snapshots are the exact pre-refactor stdout
// (captured before the extraction), so a future format tweak that would silently
// DRIFT the trio apart fails here instead. Each command is driven through the REAL
// CLI (execFileSync, cwd=os.tmpdir — the guide is static, no store) AND the pure
// renderer is unit-tested directly. If any byte changes, this test goes red.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderFactoryGuide } = require('../src/factory-guide');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

// Run the real CLI and return raw stdout (no trimming — we assert exact bytes).
function cli(args) {
  return execFileSync('node', [PEBBL_BIN, ...args], {
    cwd: os.tmpdir(), // the guide is static: no .pebbl/ store required
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// ── Frozen expected stdout, exactly as the trio emitted it pre-refactor ───────
const EXPECTED = {
  readback:   { human: "readback — factory integration guide (trigger-conditions, not stage names)\n\n  call_when:    a task is about to be claimed/started, before any code is written\n  precondition: you have the task spec text (a file path or stdin)\n  effect:       a COLLISION result means STOP and resume/supersede the prior work, do not rebuild\n  consumes:     task spec text\n  produces:     ranked colliding precedents: [{eid, matched_on, score, collision, verdict_hint}]\n\n  edges (every edge tagged BUILT|PLANNED — PLANNED = surface it, do not wire):\n    -> pebbl search  [BUILT]\n    -> L20 structural-read  [PLANNED]\n",
                json:  "{\n  \"command\": \"readback\",\n  \"call_when\": \"a task is about to be claimed/started, before any code is written\",\n  \"precondition\": \"you have the task spec text (a file path or stdin)\",\n  \"effect\": \"a COLLISION result means STOP and resume/supersede the prior work, do not rebuild\",\n  \"consumes\": \"task spec text\",\n  \"produces\": \"ranked colliding precedents: [{eid, matched_on, score, collision, verdict_hint}]\",\n  \"edges\": [\n    {\n      \"to\": \"pebbl search\",\n      \"status\": \"BUILT\"\n    },\n    {\n      \"to\": \"L20 structural-read\",\n      \"status\": \"PLANNED\"\n    }\n  ]\n}\n" },
  liveness:   { human: "liveness — factory integration guide (trigger-conditions, not stage names)\n\n  call_when:    register: once per scheduled job (declare its cadence). check: on the ONE human floor — the Mac morning brief\n  precondition: every scheduled job that should beat has a liveness-register; the brief runs check on a real schedule\n  effect:       check flags OVERDUE jobs LOUD; a planted sentinel must always trip, so a blind/empty check exits non-zero (never silent-green)\n  consumes:     the folded liveness registry (register + heartbeat events)\n  produces:     an OVERDUE report (name, last_beat, age, reason) + the sentinel status + the registry count walked\n\n  edges (every edge tagged BUILT|PLANNED — PLANNED = surface it, do not wire):\n    -> pebbl heartbeat  [BUILT]\n    -> scheduler-derived registry (crontab/LaunchAgent plists)  [PLANNED]\n    -> morning-brief surface  [PLANNED]\n",
                json:  "{\n  \"command\": \"liveness\",\n  \"call_when\": \"register: once per scheduled job (declare its cadence). check: on the ONE human floor — the Mac morning brief\",\n  \"precondition\": \"every scheduled job that should beat has a liveness-register; the brief runs check on a real schedule\",\n  \"effect\": \"check flags OVERDUE jobs LOUD; a planted sentinel must always trip, so a blind/empty check exits non-zero (never silent-green)\",\n  \"consumes\": \"the folded liveness registry (register + heartbeat events)\",\n  \"produces\": \"an OVERDUE report (name, last_beat, age, reason) + the sentinel status + the registry count walked\",\n  \"edges\": [\n    {\n      \"to\": \"pebbl heartbeat\",\n      \"status\": \"BUILT\"\n    },\n    {\n      \"to\": \"scheduler-derived registry (crontab/LaunchAgent plists)\",\n      \"status\": \"PLANNED\"\n    },\n    {\n      \"to\": \"morning-brief surface\",\n      \"status\": \"PLANNED\"\n    }\n  ]\n}\n" },
  recurrence: { human: "recurrence — factory integration guide (trigger-conditions, not stage names)\n\n  call_when:    TWO triggers — (a) a task is closing/retiring: tag the lesson (signature + the diff's changed_files + your fix_altitude_claimed) onto the close; (b) periodic maintenance: run `recurrence --scan` to surface over-threshold/resistant signatures\n  precondition: at close you have the fix-SITE signature + the merge diff's changed_files; for --scan, lessons have been tagged on prior closes\n  effect:       PATTERN (freq >= threshold) = encode it; RESISTANT (recurred after an OBSERVED-root fix) = the prior root fix is FALSIFIED, escalate to a human; STRUCTURAL (>=2) = stop fixing it as a bug. altitude is OBSERVED from changed_files, never self-graded; a claimed-vs-observed disagreement is itself a flag\n  consumes:     lesson-tagged append/correct events (signature, changed_files, fix_altitude_claimed) folded from the store\n  produces:     per-signature {frequency, resistance, last_seen, attempts[{altitude_observed, altitude_claimed}], flag}; --scan lists every over-threshold signature + flag\n  caveat:       a LOW resistance count is NOT proof of no resistance — a fix that renames/relocates/rewords can reset a string signature; the signature is anchored on the fix-SITE to resist that, and --scan surfaces drift candidates\n\n  edges (every edge tagged BUILT|PLANNED — PLANNED = surface it, do not wire):\n    -> pebbl log / lesson tag at task close  [BUILT]\n    -> merge-diff -> changed_files at retire-time  [PLANNED]\n    -> PATTERN -> inbox (occurrences as must-trip fixtures)  [PLANNED]\n    -> RESISTANT -> Ashley (prior root fix marked falsified)  [PLANNED]\n",
                json:  "{\n  \"command\": \"recurrence\",\n  \"call_when\": \"TWO triggers — (a) a task is closing/retiring: tag the lesson (signature + the diff's changed_files + your fix_altitude_claimed) onto the close; (b) periodic maintenance: run `recurrence --scan` to surface over-threshold/resistant signatures\",\n  \"precondition\": \"at close you have the fix-SITE signature + the merge diff's changed_files; for --scan, lessons have been tagged on prior closes\",\n  \"effect\": \"PATTERN (freq >= threshold) = encode it; RESISTANT (recurred after an OBSERVED-root fix) = the prior root fix is FALSIFIED, escalate to a human; STRUCTURAL (>=2) = stop fixing it as a bug. altitude is OBSERVED from changed_files, never self-graded; a claimed-vs-observed disagreement is itself a flag\",\n  \"consumes\": \"lesson-tagged append/correct events (signature, changed_files, fix_altitude_claimed) folded from the store\",\n  \"produces\": \"per-signature {frequency, resistance, last_seen, attempts[{altitude_observed, altitude_claimed}], flag}; --scan lists every over-threshold signature + flag\",\n  \"caveat\": \"a LOW resistance count is NOT proof of no resistance — a fix that renames/relocates/rewords can reset a string signature; the signature is anchored on the fix-SITE to resist that, and --scan surfaces drift candidates\",\n  \"edges\": [\n    {\n      \"to\": \"pebbl log / lesson tag at task close\",\n      \"status\": \"BUILT\"\n    },\n    {\n      \"to\": \"merge-diff -> changed_files at retire-time\",\n      \"status\": \"PLANNED\"\n    },\n    {\n      \"to\": \"PATTERN -> inbox (occurrences as must-trip fixtures)\",\n      \"status\": \"PLANNED\"\n    },\n    {\n      \"to\": \"RESISTANT -> Ashley (prior root fix marked falsified)\",\n      \"status\": \"PLANNED\"\n    }\n  ]\n}\n" },
  heartbeat:  { human: "heartbeat — factory integration guide (trigger-conditions, not stage names)\n\n  call_when:    any scheduled job, on VERIFIED success — beat LAST, after the artifact is written and checked\n  precondition: the job ran and its real output exists (a beat is a liveness signal, not a correctness signal)\n  effect:       records this job is alive at now; absence of a beat is what `liveness check` later alarms on\n  consumes:     a job name (+ optional --proof evidence token)\n  produces:     a heartbeat event in the store (folds into the liveness registry projection)\n\n  edges (every edge tagged BUILT|PLANNED — PLANNED = surface it, do not wire):\n    -> pebbl liveness register  [BUILT]\n    -> pebbl liveness check  [BUILT]\n    -> artifact/freshness check (correctness)  [PLANNED]\n",
                json:  "{\n  \"command\": \"heartbeat\",\n  \"call_when\": \"any scheduled job, on VERIFIED success — beat LAST, after the artifact is written and checked\",\n  \"precondition\": \"the job ran and its real output exists (a beat is a liveness signal, not a correctness signal)\",\n  \"effect\": \"records this job is alive at now; absence of a beat is what `liveness check` later alarms on\",\n  \"consumes\": \"a job name (+ optional --proof evidence token)\",\n  \"produces\": \"a heartbeat event in the store (folds into the liveness registry projection)\",\n  \"edges\": [\n    {\n      \"to\": \"pebbl liveness register\",\n      \"status\": \"BUILT\"\n    },\n    {\n      \"to\": \"pebbl liveness check\",\n      \"status\": \"BUILT\"\n    },\n    {\n      \"to\": \"artifact/freshness check (correctness)\",\n      \"status\": \"PLANNED\"\n    }\n  ]\n}\n" },
};

// The CLI invocation for each guide (one shared printer, four entry points).
const COMMANDS = {
  readback:   ['readback', '--factory-guide'],
  liveness:   ['liveness', 'check', '--factory-guide'],
  recurrence: ['recurrence', '--scan', '--factory-guide'],
  heartbeat:  ['heartbeat', '--factory-guide'],
};

describe('--factory-guide — shared printer emits byte-identical output for every command', () => {
  for (const name of Object.keys(COMMANDS)) {
    it(`${name} --factory-guide (human) is byte-identical to the frozen snapshot`, () => {
      assert.equal(cli(COMMANDS[name]), EXPECTED[name].human);
    });
    it(`${name} --factory-guide --json is byte-identical to the frozen snapshot`, () => {
      assert.equal(cli([...COMMANDS[name], '--json']), EXPECTED[name].json);
      // and it is still valid JSON whose every edge carries a BUILT|PLANNED status
      const g = JSON.parse(cli([...COMMANDS[name], '--json']));
      assert.ok(Array.isArray(g.edges) && g.edges.length > 0);
      for (const e of g.edges) {
        assert.ok(['BUILT', 'PLANNED'].includes(e.status), `edge ${e.to} bad status ${e.status}`);
      }
    });
  }
});

describe('renderFactoryGuide — the pure shared renderer, exercised directly', () => {
  // The same manifests the modules own, reconstructed from the frozen JSON, must
  // round-trip through the renderer to the frozen human + JSON bytes. This pins
  // the renderer itself (not just the CLI wiring): caveat handling, label padding,
  // edge formatting, trailing newline.
  for (const name of Object.keys(EXPECTED)) {
    it(`renders ${name} to the frozen human + JSON output from its manifest`, () => {
      const manifest = JSON.parse(EXPECTED[name].json);
      assert.equal(renderFactoryGuide(manifest, { json: true }), EXPECTED[name].json);
      assert.equal(renderFactoryGuide(manifest, {}), EXPECTED[name].human);
      assert.equal(renderFactoryGuide(manifest), EXPECTED[name].human); // default = human
    });
  }

  it('renders the optional caveat: line only when the manifest has one', () => {
    // recurrence carries caveat; readback does not — the generic field walk must
    // include it for the former and omit it for the latter (no special-casing).
    assert.match(renderFactoryGuide(JSON.parse(EXPECTED.recurrence.json), {}), /\n  caveat:       /);
    assert.ok(!/\n  caveat:/.test(renderFactoryGuide(JSON.parse(EXPECTED.readback.json), {})));
  });
});
