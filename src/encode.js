'use strict';
// `pebbl recurrence <signature>` / `pebbl recurrence --scan` — Primitive 3 of 3
// (readback -> liveness -> encode). The BAND-AID DETECTOR: turn repeated friction
// into an escalation signal, and separate FREQUENCY (a symptom recurs a lot →
// encode it) from RESISTANCE (it recurred AFTER a fix that actually touched root →
// the fix didn't take → escalate higher). Full rationale:
// notes/design-selflearning-primitives-2026-06-23.md §0/§3/§4.
//
// DETERMINISTIC, NO-LLM. encode SELECTS and EXPOSES structure (it COMPUTES the
// flag); the agent/factory supplies judgment and does the routing. The actual
// PATTERN→inbox / RESISTANT→Ashley routing is PLANNED (new-factory wiring), NOT
// this command's job — encode only computes the flag.
//
// THE HEADLINE FIX (the adversarial review called self-reported altitude a
// BLOCKER): the closing agent does NOT grade its own fix. `fix_altitude_claimed`
// is stored as a CLAIM only. pebbl OBSERVES the real altitude deterministically
// from `changed_files` (the merge-diff file set the lesson carries) via a
// blast-radius heuristic — touching a shared/definer file (a lib/config/
// bootstrap/schema/single-definer shape) OR landing a test/regression-guard →
// `root`; a single leaf file with NO test → `patch`. `resistance` is computed
// from `altitude_observed`, NEVER from the claim. A claimed-vs-observed
// DISAGREEMENT ("claimed root, touched only the leaf") is itself a high-value
// flag — if that can't go red, the altitude field is decorative.
//
// SIGNATURE anchored on the fix SITE (the named artifact + the changed_files
// set), not the error string (which the act of fixing mutates), so a re-worded
// recurrence still groups. CAVEAT stated in --help/the guide: a LOW resistance
// count is NOT proof of no resistance — a fix that renames/relocates/rewords can
// reset a string signature; site-anchoring resists that, --scan surfaces drift.

const { requirePebblDir } = require('./find-pebbl');
const { readEvents } = require('./events');
const { foldFull } = require('./fold');
const { renderFactoryGuide } = require('./factory-guide'); // ONE printer, shared by the trio

// Default frequency at/above which a signature is a PATTERN (design §3: "freq ≥
// threshold"). 3 = the band-aid floor (two is a coincidence, three is a class).
const PATTERN_THRESHOLD = 3;

// ── altitude heuristic (the BLOCKER fix — OBSERVED, never self-graded) ────────
//
// observeAltitude(changedFiles) -> 'root' | 'patch' | null. PURE: no I/O,
// deterministic given the file list. This is the piece the must-trip test drives
// directly — a claimed-root lesson whose changed_files is a lone leaf with no
// test MUST observe `patch`, so the disagreement can go red.
//
// The rule (a blast-radius proxy, deliberately explainable — NOT hand-tuned to a
// fixture): a fix is `root` when its diff reaches BEYOND a single leaf symptom
// site, which shows up two ways the diff already records —
//   (1) it touches a SHARED DEFINITION — a file whose job is to define something
//       many sites depend on: a `lib/` module, a `config`/`bootstrap`/`settings`
//       file, a `schema`/`migration`, or an explicit single-definer/`-defs` file.
//       Changing one of these changes behavior for every consumer, the signature
//       of a real root fix; OR
//   (2) it LANDS A TEST / REGRESSION GUARD — a `test`/`spec`/`__tests__` file or
//       a `regression`/`fixture` guard. A fix that adds the guard that would have
//       caught the bug is, by construction, fixing the class not the instance.
// Otherwise (a single leaf file, no shared definition, no new guard) → `patch`.
// An EMPTY/absent changed_files → null: altitude is UNOBSERVABLE, so it cannot be
// claimed root by fiat — a null observation is itself a wiring gap, not a pass.
//
// The patterns match on lowercased PATH SEGMENTS and the basename, so both
// `src/lib/router.js` (segment `lib`) and `app.config.ts` (basename token
// `config`) are caught, while a leaf like `src/handlers/widget.js` is not.

// A file is a TEST / regression GUARD when any of these appear in its path. A new
// guard means the fix addressed the class (it added the thing that re-catches it).
const TEST_GUARD_RE = /(^|[\/._-])(tests?|spec|specs|__tests__|__test__|regression|fixture|fixtures)([\/._-]|$)/i;

// A file is a SHARED DEFINITION / single-definer when any of these appear. These
// are the "change-it-and-every-consumer-changes" sites — the shape of a root fix.
// Kept as a small, named, justified set (not tuned to the GLM-judge fixture): the
// classic definer locations the factory's own DRY work keeps flagging.
const SHARED_DEFINER_RE = /(^|[\/._-])(lib|libs|config|configs|bootstrap|settings|schema|schemas|migration|migrations|single-definer|defs?|constants?|env|models|types?|interface|interfaces|shared|common|core|base)([\/._-]|$)/i;

function classifyFile(file) {
  const f = String(file || '').trim().toLowerCase();
  if (!f) return 'leaf';
  if (TEST_GUARD_RE.test(f)) return 'test';
  if (SHARED_DEFINER_RE.test(f)) return 'definer';
  return 'leaf';
}

function observeAltitude(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return null;
  let sawDefinerOrTest = false;
  for (const f of changedFiles) {
    const k = classifyFile(f);
    if (k === 'test' || k === 'definer') { sawDefinerOrTest = true; break; }
  }
  if (sawDefinerOrTest) return 'root';
  // Only leaf files, no test/guard. A lone (or several) leaf-symptom-site edit
  // with no shared definition and no new guard is a `patch` — the symptom site,
  // not the class.
  return 'patch';
}

// ── lesson extraction from the fold ──────────────────────────────────────────
//
// A LESSON is a folded log row that carries a `signature` (only lesson-tagged
// appends/corrects do — events.js stamps these fields present-only). We pull the
// per-signature attempt list off the deterministic fold, so the input order does
// not matter (fold sorts by ts,emitted_at,eid). Each attempt records BOTH the
// claim and the OBSERVED altitude (+ the disagreement), plus eid/ts for citation.
function lessonRowsToAttempts(rows) {
  const bySig = new Map();   // signature -> [attempt...]
  for (const row of rows) {
    if (!row || typeof row.signature !== 'string' || row.signature === '') continue;
    const sig = row.signature;
    const claimed = (row.fix_altitude_claimed === 'patch' || row.fix_altitude_claimed === 'root')
      ? row.fix_altitude_claimed
      : null;
    const observed = observeAltitude(row.changed_files);
    const attempt = {
      eid: row.eid,
      ts: row.timestamp,
      altitude_claimed: claimed,
      altitude_observed: observed,
      changed_files: Array.isArray(row.changed_files) ? row.changed_files.slice() : [],
      // The claim-vs-observed disagreement flag (the must-trip): the agent SAID
      // root but the diff only reached a leaf (or vice versa). Only meaningful
      // when BOTH are known; an unobservable (null) altitude is reported as its
      // own gap, not silently treated as agreement.
      altitude_disagreement: !!(claimed && observed && claimed !== observed),
      altitude_unobservable: observed == null,
    };
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(attempt);
  }
  // Each signature's attempts in chronological (ts,eid) order — the fold already
  // ordered the rows, but a signature's rows are a subset, so re-sort to be safe
  // and explicit (resistance is "a recurrence AFTER an observed-root attempt",
  // which is an ordering claim).
  for (const list of bySig.values()) {
    list.sort((a, b) => (
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0)
    ));
  }
  return bySig;
}

// ── frequency / resistance / flag (the band-aid math) ────────────────────────
//
// summarizeSignature(attempts) -> { frequency, resistance, last_seen, attempts,
// flag, disagreements }. PURE. Drives the test directly.
//
//  - frequency  = how many times this signature was attempted (the count). One
//                 attempt is frequency 1.
//  - resistance = how many attempts RECURRED after an OBSERVED-root prior attempt
//                 (i.e. a real root fix was made, and the SAME signature came back
//                 anyway). Counts ONLY observed-root priors — the claim is never
//                 used. This is "the fix that should have worked didn't take."
//  - flag:
//      RESISTANT  >= 1 recurrence after an observed-root attempt   (the fix didn't take)
//      STRUCTURAL >= 2 such recurrences  (it keeps coming back through root fixes →
//                 stop fixing it as a bug, escalate once then STOP). Strictly
//                 stronger than RESISTANT, so it WINS when both hold.
//      PATTERN    frequency >= threshold (happens a lot) — when not (yet) resistant.
//      none       otherwise (incl. a novel signature seen once).
//    Resistance dominates frequency: a thing that survived a root fix is a worse
//    signal than a thing that merely recurs, so RESISTANT/STRUCTURAL outrank
//    PATTERN even when the frequency threshold is also met.
function summarizeSignature(attempts, opts = {}) {
  const threshold = opts.threshold || PATTERN_THRESHOLD;
  const list = Array.isArray(attempts) ? attempts : [];
  const frequency = list.length;
  const last_seen = frequency ? list[list.length - 1].ts : null;

  // Walk in order; once we've SEEN an observed-root attempt, every LATER attempt
  // of this same signature is a recurrence-after-root → resistance.
  let seenObservedRoot = false;
  let resistance = 0;
  for (const a of list) {
    if (seenObservedRoot) resistance += 1;     // this attempt recurred after a root fix
    if (a.altitude_observed === 'root') seenObservedRoot = true;
  }

  const disagreements = list.filter((a) => a.altitude_disagreement).length;

  let flag = 'none';
  if (resistance >= 2) flag = 'STRUCTURAL';
  else if (resistance >= 1) flag = 'RESISTANT';
  else if (frequency >= threshold) flag = 'PATTERN';

  return { frequency, resistance, last_seen, attempts: list, flag, disagreements, threshold };
}

// ── store side (read-only) ───────────────────────────────────────────────────
//
// loadSignatures(pebblDir) -> Map<signature, attempt[]>. Folds the store (the
// SAME deterministic reducer every read uses) and extracts lesson attempts.
// Pure-read: recurrence NEVER writes to the store.
function loadSignatures(pebblDir) {
  const proj = foldFull(readEvents(pebblDir));
  return lessonRowsToAttempts(proj.logs);
}

// recurrenceFor(pebblDir, signature) -> the summary for ONE signature (frequency
// 0 / flag none when the signature was never seen — a novel signature).
function recurrenceFor(pebblDir, signature, opts = {}) {
  const bySig = loadSignatures(pebblDir);
  const attempts = bySig.get(signature) || [];
  const summary = summarizeSignature(attempts, opts);
  return { signature, ...summary };
}

// scanSignatures(pebblDir) -> every signature whose flag is NOT 'none' (the
// maintenance feed: PATTERN/RESISTANT/STRUCTURAL), each with its flag + counts.
// Sorted RESISTANCE-first then frequency-first then name, so the worst band-aids
// surface at the top of the scan.
function scanSignatures(pebblDir, opts = {}) {
  const bySig = loadSignatures(pebblDir);
  const out = [];
  for (const [sig, attempts] of bySig) {
    const s = summarizeSignature(attempts, opts);
    if (s.flag === 'none') continue;
    out.push({
      signature: sig,
      flag: s.flag,
      frequency: s.frequency,
      resistance: s.resistance,
      disagreements: s.disagreements,
      last_seen: s.last_seen,
    });
  }
  const flagRank = { STRUCTURAL: 0, RESISTANT: 1, PATTERN: 2 };
  out.sort((a, b) => (
    (flagRank[a.flag] - flagRank[b.flag]) ||
    (b.resistance - a.resistance) ||
    (b.frequency - a.frequency) ||
    (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0)
  ));
  return out;
}

// ── --factory-guide (static trigger-condition manifest, B3 fix) ──────────────
//
// STATIC manifest of TRIGGER-CONDITIONS (call_when/precondition/effect/consumes/
// produces), NOT host stage names — a host factory binds its own stages. EVERY
// edge carries status: BUILT|PLANNED; the integrating agent treats PLANNED as
// "surface it, do not wire." encode COMPUTES the flag (BUILT); the PATTERN→inbox /
// RESISTANT→Ashley routing and the commit-linked changed_files are PLANNED. No
// store access.
const FACTORY_GUIDE = {
  command: 'recurrence',
  call_when: 'TWO triggers — (a) a task is closing/retiring: tag the lesson (signature + the diff\'s changed_files + your fix_altitude_claimed) onto the close; (b) periodic maintenance: run `recurrence --scan` to surface over-threshold/resistant signatures',
  precondition: 'at close you have the fix-SITE signature + the merge diff\'s changed_files; for --scan, lessons have been tagged on prior closes',
  effect: 'PATTERN (freq >= threshold) = encode it; RESISTANT (recurred after an OBSERVED-root fix) = the prior root fix is FALSIFIED, escalate to a human; STRUCTURAL (>=2) = stop fixing it as a bug. altitude is OBSERVED from changed_files, never self-graded; a claimed-vs-observed disagreement is itself a flag',
  consumes: 'lesson-tagged append/correct events (signature, changed_files, fix_altitude_claimed) folded from the store',
  produces: 'per-signature {frequency, resistance, last_seen, attempts[{altitude_observed, altitude_claimed}], flag}; --scan lists every over-threshold signature + flag',
  caveat: 'a LOW resistance count is NOT proof of no resistance — a fix that renames/relocates/rewords can reset a string signature; the signature is anchored on the fix-SITE to resist that, and --scan surfaces drift candidates',
  edges: [
    { to: 'pebbl log / lesson tag at task close', status: 'BUILT' },        // the additive signature/changed_files/fix_altitude_claimed fields exist now
    { to: 'merge-diff -> changed_files at retire-time', status: 'PLANNED' }, // commit-linking the real diff is a follow-up (fixture carries it today)
    { to: 'PATTERN -> inbox (occurrences as must-trip fixtures)', status: 'PLANNED' }, // routing is new-factory wiring
    { to: 'RESISTANT -> Ashley (prior root fix marked falsified)', status: 'PLANNED' }, // routing is new-factory wiring
  ],
};

function printFactoryGuide(asJson) {
  process.stdout.write(renderFactoryGuide(FACTORY_GUIDE, { json: asJson }));
}

// ── CLI arg parsing (own raw-argv parse, like liveness/readback) ─────────────
function parseFlags(args) {
  const out = { json: false, factoryGuide: false, scan: false, threshold: null, positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--factory-guide') { out.factoryGuide = true; continue; }
    if (a === '--scan') { out.scan = true; continue; }
    if (a === '--threshold') { const v = args[i + 1]; if (v !== undefined && !v.startsWith('--')) { out.threshold = parseInt(v, 10); i++; } continue; }
    if (a.startsWith('--threshold=')) { out.threshold = parseInt(a.slice('--threshold='.length), 10); continue; }
    if (a.startsWith('--')) continue;              // ignore unknown flags
    out.positionals.push(a);
  }
  if (!Number.isInteger(out.threshold) || out.threshold < 1) out.threshold = null;
  return out;
}

// ── human / JSON rendering ───────────────────────────────────────────────────
function renderOne(summary, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      signature: summary.signature,
      frequency: summary.frequency,
      resistance: summary.resistance,
      last_seen: summary.last_seen,
      flag: summary.flag,
      disagreements: summary.disagreements,
      attempts: summary.attempts.map((a) => ({
        altitude_observed: a.altitude_observed,
        altitude_claimed: a.altitude_claimed,
        altitude_disagreement: a.altitude_disagreement,
        eid: a.eid,
        ts: a.ts,
      })),
    }, null, 2) + '\n');
    return;
  }
  const out = [];
  out.push(`\n--- RECURRENCE: ${summary.signature} ---`);
  out.push(`flag:        ${summary.flag}`);
  out.push(`frequency:   ${summary.frequency}`);
  out.push(`resistance:  ${summary.resistance}  (recurrences after an OBSERVED-root fix — the fix didn't take)`);
  out.push(`last seen:   ${summary.last_seen || 'never'}`);
  if (summary.disagreements > 0) {
    out.push(`!! ${summary.disagreements} attempt(s) CLAIMED an altitude the diff DISAGREES with (claimed root, touched only the leaf)`);
  }
  if (summary.frequency === 0) {
    out.push('(novel — this signature has never been seen)');
  } else {
    out.push('attempts (chronological):');
    for (const a of summary.attempts) {
      const dis = a.altitude_disagreement ? '  <-- CLAIM/OBSERVED DISAGREE' : '';
      out.push(`  observed=${a.altitude_observed || 'unobservable'} claimed=${a.altitude_claimed || 'none'}  ${a.ts}  ${a.eid}${dis}`);
    }
  }
  if (summary.flag === 'RESISTANT' || summary.flag === 'STRUCTURAL') {
    out.push('NOTE: a prior OBSERVED-root fix did not take — the "root fix" is falsified. Escalate to a human.');
  }
  out.push('CAVEAT: a low resistance count is NOT proof of no resistance — a relocating/renaming fix can reset a string signature.');
  out.push('---\n');
  process.stdout.write(out.join('\n') + '\n');
}

function renderScan(rows, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({ signatures: rows }, null, 2) + '\n');
    return;
  }
  const out = [];
  out.push('\n--- RECURRENCE SCAN (over-threshold / resistant signatures) ---');
  if (rows.length === 0) {
    out.push('No signature over threshold and none resistant — nothing to escalate.');
  } else {
    for (const r of rows) {
      out.push(`  [${r.flag}] ${r.signature}  (freq ${r.frequency}, resistance ${r.resistance}, ${r.disagreements} disagreement(s), last ${r.last_seen || '?'})`);
    }
    out.push('');
    out.push('RESISTANT/STRUCTURAL => the prior root fix is falsified; route to a human (PLANNED wiring).');
  }
  out.push('CAVEAT: a low resistance count is NOT proof of no resistance (a relocating fix resets a string signature).');
  out.push('---\n');
  process.stdout.write(out.join('\n') + '\n');
}

// ── the command ──────────────────────────────────────────────────────────────
//
// `pebbl recurrence <signature> [--json]`
// `pebbl recurrence --scan [--json]`
// `pebbl recurrence --factory-guide [--json]`
function recurrenceCmd(args) {
  const opts = parseFlags(args);

  // --factory-guide is a STATIC manifest: no store needed. Honored even when a
  // signature/--scan is also present (mirrors liveness/readback).
  if (opts.factoryGuide) { printFactoryGuide(opts.json); return; }

  const evalOpts = opts.threshold ? { threshold: opts.threshold } : {};

  if (opts.scan) {
    const pebblDir = requirePebblDir();
    const rows = scanSignatures(pebblDir, evalOpts);
    renderScan(rows, opts.json);
    return;
  }

  const signature = opts.positionals[0];
  if (!signature) {
    console.error('Usage: pebbl recurrence <signature> [--json]');
    console.error('       pebbl recurrence --scan [--json]');
    console.error('       pebbl recurrence --factory-guide [--json]');
    process.exit(1);
  }
  const pebblDir = requirePebblDir();
  const summary = recurrenceFor(pebblDir, signature, evalOpts);
  renderOne(summary, opts.json);
}

module.exports = recurrenceCmd;

// Internal surface for tests (pure pieces + constants), mirroring
// liveness._internal / readback._internal.
module.exports._internal = {
  PATTERN_THRESHOLD,
  classifyFile,
  observeAltitude,
  lessonRowsToAttempts,
  summarizeSignature,
  loadSignatures,
  recurrenceFor,
  scanSignatures,
  FACTORY_GUIDE,
  parseFlags,
};
