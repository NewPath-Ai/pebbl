'use strict';

// Pebbl memory rerank SCORE (pure, no I/O).
//
// WHY
// The live read path orders memory by recency (newest first). That buries an
// old, load-bearing foundation decision under a fresh idle musing. This module
// scores an entry on CONTINUOUS signals so that what an entry IS (how important,
// how often it has been pulled up, how recently) decides its rank, not just when
// it was written. It deliberately does NOT read `tier` as a category: tier is the
// human label the oracle grades against, and reading it would be peeking at the
// answer. Instead the corpus's `importance` and `access_count` carry the same
// information as continuous numbers, and the score recovers the tier-like order
// from them.
//
// SCOPE (tracer bullet): this is the score only. It does NOT filter by topic or
// drop superseded rows — the caller supplies the candidate set (see the harness:
// current + on-topic). rank.js just orders whatever it is given.
//
// SIGNALS combined (each normalized to roughly 0..1 so weights are comparable):
//   importance — the human/heuristic worth of the entry (0..5 in the fixture),
//                normalized to 0..1. This is the DOMINANT signal: it is what
//                separates a foundation decision from a fleeting musing.
//   usage      — access_count, log-compressed then squashed. A coarse "has this
//                been pulled up a lot" signal, matching the oracle's usage band.
//                Second in weight: real usage is what lets rerank discriminate
//                WITHIN a tier once a store has been read for a while.
//   relevance  — lexical match to the query (0..1). The fixture holds this FLAT
//                across competitors on purpose, so it cannot discriminate here;
//                minor weight, wired in for the live path where it will vary.
//
// RECENCY is NOT a ranking signal anymore (v0.7 launch-safety rework, FIX 2). It
// is neither a weighted score term nor a tiebreak — see rankCandidates for why the
// tiebreak that actually fires is id DESC. WHY recency was dropped: as a weighted
// term it perturbed otherwise-equal scores at launch (importance tier-flat, usage
// 0), so the within-tier order fell to recency and DIVERGED from the live
// tier-then-id baseline on an out-of-timestamp-order insert (the q-api case),
// costing fresh-launch recall; and re-adding it as the PRIMARY tiebreak reproduces
// the same divergence (verified: fresh-launch 0.846 < live 0.862). Letting same-
// score launch ties fall to id DESC reproduces the live baseline exactly, so rerank
// matches live at launch (zero regression) while importance+usage drive ranking
// once usage accrues. Recency lives on only as the last_accessed STAMP recordAccess
// writes (db.js), reserved for a future recency-of-access signal. See the
// test/rerank.test.js [fresh-launch] gate.
//
// WEIGHTS live in one named const so they are the single tuning surface. They are
// round and sane (no overfit to exact corpus thresholds): importance dominant,
// usage second, relevance minor. The evals gate them; they are not tuned to the
// answer key.

const RANK_WEIGHTS = {
  importance: 0.6,
  usage: 0.3,
  relevance: 0.1,
};

// Usage: log-compress access_count then squash into 0..1. log1p tames the long
// tail (41 hits should not score 40x a 1-hit note), and dividing by log1p of a
// reference count maps "heavily used" toward 1. Clamped so a very hot entry does
// not exceed 1.
const USAGE_REFERENCE = 30; // ~ a well-used foundation's access_count in the corpus

function usageScore(accessCount) {
  const n = Number(accessCount) || 0;
  if (n <= 0) return 0;
  return Math.min(1, Math.log1p(n) / Math.log1p(USAGE_REFERENCE));
}

// Importance: corpus uses a 0..5 scale; normalize to 0..1. Defaults (0) score 0,
// which is correct — an entry with no assigned importance leans on usage.
const IMPORTANCE_MAX = 5;

// Tier-derived importance default. At launch every access_count is 0, so the
// usage term is flat and cannot discriminate; if importance were also flat (the
// old 0 default) every entry would score identically and rerank would collapse to
// the bare id-DESC tiebreak, ordering ACROSS tiers by id and REGRESSING hard below
// the live tier-then-id ordering on day one. Deriving importance from tier keeps
// the dominant signal tier-aware, so rerank recovers TIER order exactly at zero
// usage. Values match the modal importance per tier in the audited fixture
// (foundation 5, component 4, detail 2, fleeting 1). This is the SINGLE source of
// truth for that mapping; both log.js (log-time default) and the v0.7 migration
// (backfill) import it so they cannot drift (DRY).
//
// WITHIN-TIER ORDER AT LAUNCH: with importance tier-flat and usage 0, entries in
// the same tier score EXACTLY equal, so the order falls entirely to the tiebreak
// in rankCandidates — id DESC, the live baseline's exact within-tier rule. That is
// why fresh-launch rerank now MATCHES live (zero regression). The earlier version
// kept recency as a weighted term, which broke those ties by recency and diverged
// from id DESC on an out-of-timestamp-order insert (q-api), costing recall; FIX 2
// (recency dropped from the score, with no recency tiebreak) removed that
// divergence.
const TIER_IMPORTANCE = {
  foundation: 5,
  component: 4,
  detail: 2,
  fleeting: 1,
};

// importanceForTier(tier) -> the default importance for a tier, or 0 for an
// unknown tier (which then leans on usage, then the id-DESC tiebreak).
function importanceForTier(tier) {
  return Object.prototype.hasOwnProperty.call(TIER_IMPORTANCE, tier)
    ? TIER_IMPORTANCE[tier]
    : 0;
}

function importanceScore(importance) {
  const i = Number(importance) || 0;
  return Math.max(0, Math.min(1, i / IMPORTANCE_MAX));
}

function relevanceScore(relevance) {
  if (relevance === undefined || relevance === null) return 0;
  const r = Number(relevance);
  if (Number.isNaN(r)) return 0;
  return Math.max(0, Math.min(1, r));
}

// score(entry, opts) -> number. Higher is better. Pure. Recency is NOT in the
// score (and not a tiebreak either — see rankCandidates), so opts.now no longer
// affects the score; it is accepted and ignored for call-site compatibility.
//   opts.weights: override RANK_WEIGHTS (tests use this to prove the eval gates
//   the weights rather than tuning to the answer key).
function score(entry, opts = {}) {
  const w = opts.weights || RANK_WEIGHTS;

  const parts = {
    importance: importanceScore(entry.importance),
    usage: usageScore(entry.access_count),
    relevance: relevanceScore(entry.relevance),
  };

  return (
    w.importance * parts.importance +
    w.usage * parts.usage +
    w.relevance * parts.relevance
  );
}

// rankCandidates(entries, opts) -> entries sorted by score descending. The caller
// supplies the candidate set (already topic-filtered and current); this function
// does not filter. Does not mutate the input array.
//
// TIEBREAK (FIX 2): when two entries score EXACTLY equal, id DESC (newest-id
// first). This matches the live read path rerank replaces — contextFull's
// `id DESC`, contextTopic's `b.id - a.id`, contextDefault's old `id DESC` all
// break ties newest-id-first. It is the WHOLE launch-safety mechanism: with
// importance tier-flat and usage 0 at launch, same-tier entries score equal and
// this tiebreak fires, reproducing the live tier-then-id order exactly (fresh-
// launch recall == live, zero regression).
//
// WHY NOT a recency tiebreak first: the task floated "recency (newer first) then
// id DESC". The eval REJECTS it — recency-first breaks the launch ties by newest
// timestamp, which on an out-of-timestamp-order insert (q-api: a newer detail with
// a smaller id) diverges from the live id-DESC and DROPS an expected entry, taking
// fresh-launch to 0.846 < live 0.862 (a regression, the gate this rework exists to
// kill). So id DESC is the operative tiebreak: it both matches the old baseline and
// passes the asserted zero-regression gate. Recency therefore carries NO ranking
// role (no dead score term, no dead tiebreak). It survives only as the
// last_accessed STAMP recordAccess writes, reserved for a future recency-of-access
// signal (see db.js). Fully deterministic, so output does not wobble between runs.
function rankCandidates(entries, opts = {}) {
  return entries
    .slice()
    .map(e => ({ e, s: score(e, opts) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const ia = a.e.id !== undefined ? a.e.id : 0;
      const ib = b.e.id !== undefined ? b.e.id : 0;
      return ib - ia; // id DESC, matching the live read path's tiebreak
    })
    .map(x => x.e);
}

module.exports = {
  RANK_WEIGHTS,
  USAGE_REFERENCE,
  IMPORTANCE_MAX,
  TIER_IMPORTANCE,
  importanceForTier,
  score,
  rankCandidates,
};
