'use strict';
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, notCorrected } = require('./db');
const { ensureProjectFiles, loadConfig } = require('./rubric');
// REUSE check.js's pure detector for the missing-artifact dimension — do NOT
// reimplement its path/symbol regex here (DRY: one definition of "a cited file
// is gone"). See src/check.js _internal.checkEntries.
const { _internal: checkInternal } = require('./check');
// REUSE search.js's tokenizer for the term-overlap part of the contradiction
// heuristic, so doctor and search agree on what a "term" is (no second
// tokenizer to drift). See src/search.js _internal.normalize.
const { _internal: searchInternal } = require('./search');

// `pebbl doctor` — a report-only memory-health command. Where `check` compares
// memory-vs-code (does a cited file still exist?), `doctor` compares
// memory-vs-memory: it SURFACES current beliefs that are probably wrong so an
// agent or human can correct them with `pebbl log --corrects <id>`. It NEVER
// judges or edits — every flag is a candidate the caller decides on. Mirrors
// check.js end to end: pure detectors + a thin CLI wrapper + an `_internal`
// export, tier-then-recency sorted, same `if wrong, supersede:` hint line.
//
// REPORT ONLY: this module must never write to or mutate .pebbl/ — no event
// appends, no file writes, no schema/fold changes (the Verify gate enforces it).
// Keeping the LLM out is a hard line too — pebbl stays a single-native-dependency,
// deterministic, offline tool (the LLM-judgment half is a separate factory job
// that consumes --json).

// Tier ordering for the shared sort — same ranking check.js uses, re-exported
// from its _internal so the two commands cannot disagree about tier priority.
const TIER_RANK = checkInternal.TIER_RANK;

// Built-in, conservative defaults. Read overrides from config.doctor.* the way
// compact.js reads config.compaction.* — works with no config at all. `--all`
// widens these at the call site (raises caps, lowers the overlap bar, drops the
// staleness horizon) so the default stays quiet and trustworthy.
const DEFAULTS = {
  // Contradiction: minimum Jaccard overlap of normalized content tokens for two
  // current entries on a shared topic to be flagged as a likely conflict. 0.5
  // is deliberately high so only genuinely similar pairs surface.
  contradiction_overlap: 0.5,
  contradiction_cap: 5,        // top-N pairs, so the section stays short.
  // Staleness: a current component/detail entry older than this many days that
  // nothing newer on its topic reinforces. ~6 months is conservative on
  // purpose — this is the softest, lowest-confidence section.
  staleness_horizon_days: 180,
  staleness_cap: 3,
  // Minimum distinct content tokens an entry must have before it can take part
  // in the overlap math — a one-word entry would trivially match many others.
  min_terms: 3,
};

function loadDoctorConfig(pebblDir, { all = false } = {}) {
  const cfg = (loadConfig(pebblDir) || {}).doctor || {};
  const out = {
    contradictionOverlap: cfg.contradiction_overlap ?? DEFAULTS.contradiction_overlap,
    contradictionCap: cfg.contradiction_cap ?? DEFAULTS.contradiction_cap,
    stalenessHorizonDays: cfg.staleness_horizon_days ?? DEFAULTS.staleness_horizon_days,
    stalenessCap: cfg.staleness_cap ?? DEFAULTS.staleness_cap,
    minTerms: cfg.min_terms ?? DEFAULTS.min_terms,
  };
  if (all) {
    // Widen every knob: more output, a lower bar to flag, a shorter horizon.
    out.contradictionOverlap = Math.max(0.3, out.contradictionOverlap - 0.2);
    out.contradictionCap = out.contradictionCap * 4;
    out.stalenessHorizonDays = Math.round(out.stalenessHorizonDays / 2);
    out.stalenessCap = out.stalenessCap * 4;
  }
  return out;
}

// ── shared helpers ──────────────────────────────────────────────────────────

// Distinct normalized content tokens of an entry's message, as a Set. Reuses
// search.js normalize() (lowercase, strip non-alphanumerics to spaces) so the
// notion of a "term" is identical to search's. Used for the term-overlap math.
function contentTerms(message) {
  return new Set(searchInternal.normalize(message).split(' ').filter(Boolean));
}

// Topics column is a comma-separated string (see log.js formatEntry). Split it
// into a trimmed, non-empty list — the one place this parse lives in doctor.
function entryTopics(e) {
  return String(e.topics || '').split(',').map(t => t.trim()).filter(Boolean);
}

// Jaccard similarity of two token sets: |A∩B| / |A∪B|. A symmetric 0..1 score
// of how much two messages share, which is what the contradiction heuristic
// thresholds on. Cheap, deterministic, no embeddings.
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(a - b) / 86400000;
}

// ── detector 1: contradictions (new heuristic, memory-vs-memory) ────────────
//
// Candidate = two CURRENT entries that (a) share ≥1 topic, (b) have content
// term-overlap ≥ threshold, and (c) are NOT already linked via corrects /
// relates_to. The OLDER of the pair is marked the likely-superseded one (newer
// belief usually wins), which drives the --corrects hint. Score by overlap,
// then CAP to top-N so the section stays quiet. No LLM: this only says "these
// two look like they're about the same thing and nobody linked them" — the
// caller decides if they actually conflict.
function detectContradictions(entries, { overlap, cap, minTerms } = {}) {
  overlap = overlap ?? DEFAULTS.contradiction_overlap;
  cap = cap ?? DEFAULTS.contradiction_cap;
  minTerms = minTerms ?? DEFAULTS.min_terms;

  // Precompute each entry's term set and topic set once (O(n) not O(n²)).
  const enriched = entries.map(e => ({
    e,
    terms: contentTerms(e.message),
    topics: new Set(entryTopics(e)),
  }));

  // Pairs already linked by the user are NOT contradictions to re-surface — the
  // link IS the resolution. Build a quick lookup of {min-max} id pairs.
  const linked = new Set();
  for (const e of entries) {
    for (const other of [e.corrects, e.relates_to]) {
      if (other != null) linked.add(pairKey(e.id, other));
    }
  }

  const candidates = [];
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const A = enriched[i], B = enriched[j];
      if (A.terms.size < minTerms || B.terms.size < minTerms) continue;
      if (linked.has(pairKey(A.e.id, B.e.id))) continue;
      // Require a shared topic — the cheap gate that keeps this from comparing
      // every pair of unrelated memories.
      let shareTopic = false;
      for (const t of A.topics) if (B.topics.has(t)) { shareTopic = true; break; }
      if (!shareTopic) continue;

      const score = jaccard(A.terms, B.terms);
      if (score < overlap) continue;

      // Older entry is the likely-superseded one; newer is the survivor.
      const [older, newer] = Date.parse(A.e.timestamp) <= Date.parse(B.e.timestamp)
        ? [A.e, B.e] : [B.e, A.e];
      candidates.push({
        dimension: 'contradiction',
        score,
        older,
        newer,
        sharedTopics: [...A.topics].filter(t => B.topics.has(t)),
      });
    }
  }
  // Highest overlap first, then prefer the pair whose older entry is highest
  // tier (most consequential to get right).
  candidates.sort((a, b) =>
    (b.score - a.score) ||
    ((TIER_RANK[a.older.tier] ?? 9) - (TIER_RANK[b.older.tier] ?? 9)));
  return candidates.slice(0, cap);
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// ── detector 2: staleness (new heuristic, the quietest section) ─────────────
//
// Candidate = a current component/detail entry older than the horizon that NO
// newer current entry on the same topic reinforces. The idea: an old fact that
// the project never revisited may have quietly drifted out of date. Deliberately
// LOW-CONFIDENCE and capped small — a long-lived foundation truth is SUPPOSED to
// be old, so foundation/fleeting are excluded (foundation is durable by design;
// fleeting is noise). No LLM: it only flags "old and un-reinforced", not "wrong".
function detectStaleness(entries, { horizonDays, cap, now } = {}) {
  horizonDays = horizonDays ?? DEFAULTS.staleness_horizon_days;
  cap = cap ?? DEFAULTS.staleness_cap;
  const nowMs = now != null ? Date.parse(now) : Date.now();

  // For each topic, the timestamp of the NEWEST current entry touching it.
  const newestByTopic = new Map();
  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    for (const t of entryTopics(e)) {
      const prev = newestByTopic.get(t);
      if (prev == null || ts > prev) newestByTopic.set(t, ts);
    }
  }

  const candidates = [];
  for (const e of entries) {
    if (e.tier !== 'component' && e.tier !== 'detail') continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    const ageDays = (nowMs - ts) / 86400000;
    if (ageDays < horizonDays) continue;

    const topics = entryTopics(e);
    // Un-reinforced = no NEWER current entry shares any of its topics. (An entry
    // is the newest on its own topic when newestByTopic === its own ts.)
    const reinforced = topics.some(t => (newestByTopic.get(t) ?? -Infinity) > ts);
    if (reinforced) continue;
    // An entry with no topics can't be reinforced-by-topic, but it's also too
    // weak a signal to flag — skip it to keep this section quiet.
    if (topics.length === 0) continue;

    candidates.push({ dimension: 'staleness', entry: e, ageDays: Math.round(ageDays) });
  }
  // Oldest (highest age) first — the stalest are the most worth a look.
  candidates.sort((a, b) => b.ageDays - a.ageDays);
  return candidates.slice(0, cap);
}

// ── detector 3: missing artifact (REUSE check.js, no new regex) ─────────────
//
// Delegates entirely to check.js's pure checkEntries — doctor adds nothing here
// but the dimension wrapper, so there is no duplicated path/symbol regex (a
// hard Acceptance line). `deep` passes straight through, same meaning as
// `check --deep`.
function detectMissing(entries, repoRoot, { deep = false } = {}) {
  const flagged = checkInternal.checkEntries(entries, repoRoot, { deep });
  return flagged.map(e => ({ dimension: 'missing', entry: e }));
}

// ── compose all three (pure) ────────────────────────────────────────────────
//
// Pure orchestrator over already-loaded current-belief entries: returns the
// three detector result arrays. Kept side-effect-free so tests drive it without
// a real store (the check.js _internal pattern).
function diagnose(entries, repoRoot, opts = {}) {
  return {
    contradictions: detectContradictions(entries, {
      overlap: opts.contradictionOverlap,
      cap: opts.contradictionCap,
      minTerms: opts.minTerms,
    }),
    staleness: detectStaleness(entries, {
      horizonDays: opts.stalenessHorizonDays,
      cap: opts.stalenessCap,
      now: opts.now,
    }),
    missing: detectMissing(entries, repoRoot, { deep: !!opts.deep }),
  };
}

// ── JSON shaping for the future factory caller ──────────────────────────────
//
// Flatten the three detector outputs into a single array of uniform candidate
// objects { dimension, ids, reason, suggested } — the contract the scheduling +
// LLM-judgment follow-up consumes. `suggested` is the exact `pebbl log` command
// to run if the caller decides the entry is wrong.
function toJson(results) {
  const out = [];
  for (const c of results.contradictions) {
    out.push({
      dimension: 'contradiction',
      ids: [c.older.id, c.newer.id],
      reason: `current entries share topic(s) ${c.sharedTopics.join(', ')} with ${(c.score * 100) | 0}% term overlap and are not linked; older #${c.older.id} may be superseded by #${c.newer.id}`,
      suggested: supersedeHint(c.older.id),
    });
  }
  for (const c of results.staleness) {
    out.push({
      dimension: 'staleness',
      ids: [c.entry.id],
      reason: `low-confidence: ${c.ageDays}d old and not reinforced by any newer entry on its topic(s)`,
      suggested: supersedeHint(c.entry.id),
    });
  }
  for (const c of results.missing) {
    const e = c.entry;
    const bits = [];
    if (e.missingPaths && e.missingPaths.length) bits.push(`missing path ${e.missingPaths.join(', ')}`);
    if (e.missingSymbols && e.missingSymbols.length) bits.push(`missing symbol ${e.missingSymbols.join(', ')}`);
    out.push({
      dimension: 'missing',
      ids: [e.id],
      reason: bits.join('; '),
      suggested: supersedeHint(e.id),
    });
  }
  return out;
}

function supersedeHint(id) {
  return `pebbl log "<corrected memory>" --corrects ${id}`;
}

function truncate(msg) {
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
}

function fmtEntry(e) {
  const date = String(e.timestamp || '').slice(0, 10);
  return `#${e.id} [${e.tier}|${e.category}] ${date} — ${truncate(e.message)}`;
}

// ── CLI wrapper (thin, the check.js shape) ──────────────────────────────────

module.exports = function doctor(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const opts = loadDoctorConfig(pebblDir, { all: !!flags.all });
  opts.deep = !!flags.deep;

  // openDb already calls staleness.ensureFresh(pebblDir) on the read path (see
  // db.js openDb), so a just-pulled events.jsonl is materialized before we read.
  const db = openDb(pebblDir);
  // CURRENT BELIEFS ONLY: notCorrected() is valid_to IS NULL (the one definition
  // of "current", db.js), and tier != 'archived' drops compacted history. This
  // is the same current-belief filter context.js uses.
  const entries = db.prepare(
    `SELECT id, timestamp, category, tier, message, topics, relates_to, corrects
       FROM logs
      WHERE tier != 'archived' AND ${notCorrected()}
      ORDER BY timestamp DESC`
  ).all();

  const results = diagnose(entries, repoRoot, opts);

  if (flags.json) {
    console.log(JSON.stringify(toJson(results), null, 2));
    return;
  }

  const total = results.contradictions.length + results.staleness.length + results.missing.length;
  if (total === 0) {
    console.log('pebbl doctor: memory looks consistent — no contradictions, stale beliefs, or missing artifacts flagged.');
    return;
  }

  console.log(`\npebbl doctor — ${total} candidate${total === 1 ? '' : 's'} to review (report only, nothing changed):`);

  if (results.contradictions.length) {
    console.log(`\nContradictions — current entries that look like they conflict and aren't linked:\n`);
    for (const c of results.contradictions) {
      console.log(fmtEntry(c.older));
      console.log(fmtEntry(c.newer));
      console.log(`   reason: share topic(s) ${c.sharedTopics.join(', ')}, ${(c.score * 100) | 0}% term overlap; older #${c.older.id} may be superseded by newer #${c.newer.id}`);
      console.log(`   if wrong, supersede:  ${supersedeHint(c.older.id)}`);
      console.log();
    }
  }

  if (results.missing.length) {
    const n = results.missing.length;
    console.log(`\nMissing artifact — ${n} ${n === 1 ? 'entry cites a' : 'entries cite'} file/symbol that no longer exists:\n`);
    for (const c of results.missing) {
      const e = c.entry;
      console.log(fmtEntry(e));
      if (e.missingPaths && e.missingPaths.length) console.log(`   missing path: ${e.missingPaths.join(', ')}`);
      if (e.missingSymbols && e.missingSymbols.length) console.log(`   missing symbol: ${e.missingSymbols.join(', ')}`);
      console.log(`   if wrong, supersede:  ${supersedeHint(e.id)}`);
      console.log();
    }
  }

  if (results.staleness.length) {
    console.log(`\nStaleness (low confidence) — old beliefs nothing newer reinforces; may be fine:\n`);
    for (const c of results.staleness) {
      console.log(fmtEntry(c.entry));
      console.log(`   reason: ${c.ageDays}d old, not reinforced by any newer entry on its topic(s)`);
      console.log(`   if wrong, supersede:  ${supersedeHint(c.entry.id)}`);
      console.log();
    }
  }
};

module.exports._internal = {
  detectContradictions,
  detectStaleness,
  detectMissing,
  diagnose,
  toJson,
  contentTerms,
  entryTopics,
  jaccard,
  pairKey,
  daysBetween,
  loadDoctorConfig,
  DEFAULTS,
  TIER_RANK,
};
