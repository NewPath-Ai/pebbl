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
//   recency    — newer is higher. Exponential decay on age so a months-old note
//                still scores well below a same-week one but not to zero.
//   usage      — access_count, log-compressed then squashed. A coarse "has this
//                been pulled up a lot" signal, matching the oracle's usage band.
//   importance — the human/heuristic worth of the entry (0..5 in the fixture),
//                normalized to 0..1. This is the dominant signal: it is what
//                separates a foundation decision from a fleeting musing.
//   relevance  — lexical match to the query (0..1). The fixture holds this FLAT
//                across competitors on purpose, so it cannot discriminate here;
//                it is wired in for the live path where it will vary.
//
// WEIGHTS live in one named const so they are the single tuning surface. They are
// round and sane (no overfit to exact corpus thresholds). importance and usage
// together dominate recency, which is the whole point: a genuine worth/usage
// weighting must beat a recency baseline on an adversarial corpus.

const RANK_WEIGHTS = {
  importance: 0.5,
  usage: 0.25,
  recency: 0.15,
  relevance: 0.1,
};

// Reference "now". The caller may override via opts.now for deterministic tests.
const DEFAULT_NOW = () => Date.now();

// Recency: exponential decay with a half-life. Age 0 -> 1; one half-life -> 0.5;
// old notes asymptote toward 0 but never go negative. Half-life in days controls
// how fast recency fades; 45d means a ~6-week-old note is worth half a fresh one.
const RECENCY_HALF_LIFE_DAYS = 45;
const MS_PER_DAY = 86400000;

function recencyScore(timestamp, nowMs) {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

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
// which is correct — an entry with no assigned importance leans on usage/recency.
const IMPORTANCE_MAX = 5;

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

// score(entry, opts) -> number. Higher is better. Pure.
//   opts.now: ms epoch or ISO string to measure recency against (default: now).
function score(entry, opts = {}) {
  const nowMs = opts.now === undefined
    ? DEFAULT_NOW()
    : (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now));
  const w = opts.weights || RANK_WEIGHTS;

  const parts = {
    importance: importanceScore(entry.importance),
    usage: usageScore(entry.access_count),
    recency: recencyScore(entry.timestamp, nowMs),
    relevance: relevanceScore(entry.relevance),
  };

  return (
    w.importance * parts.importance +
    w.usage * parts.usage +
    w.recency * parts.recency +
    w.relevance * parts.relevance
  );
}

// rankCandidates(entries, opts) -> entries sorted by score descending. The caller
// supplies the candidate set (already topic-filtered and current); this function
// does not filter. Stable, deterministic: ties break by id ascending so output
// does not wobble between runs. Does not mutate the input array.
function rankCandidates(entries, opts = {}) {
  return entries
    .slice()
    .map(e => ({ e, s: score(e, opts) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      const ia = a.e.id !== undefined ? a.e.id : 0;
      const ib = b.e.id !== undefined ? b.e.id : 0;
      return ia - ib;
    })
    .map(x => x.e);
}

module.exports = {
  RANK_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS,
  USAGE_REFERENCE,
  IMPORTANCE_MAX,
  score,
  rankCandidates,
};
