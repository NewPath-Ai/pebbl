'use strict';

// Ground-truth label deriver for the pebbl memory rerank fixture.
//
// WHY THIS EXISTS
// The rerank feature itself (a weighted relevance score) is the NEXT slice and
// is deliberately NOT implemented here. To evaluate it later we need labels:
// for each query, the set of entries that SHOULD float to the top. Hand-picking
// those labels would be circular (we would just be writing down our intuition,
// then grading the model against our intuition). Instead we state ONE explicit,
// readable rule and COMPUTE the labels by running it over the corpus. The rule
// is intentionally COARSER than any score the feature will produce, so it
// describes what an entry IS (its tier, a 3-way usage band, current-or-not)
// rather than what a particular scoring formula outputs. A coarse oracle that a
// human can verify by eye is the point: it lets us catch a future score that is
// "precisely wrong".
//
// THE RULE (keys off the v0.5 bitemporal column valid_to)
//   1. EXCLUDE superseded entries entirely: any row with valid_to !== null is a
//      belief we stopped holding. It never appears in expected_top_k, no matter
//      how recent or high-tier it is. (This is the same predicate the live code
//      uses for "current belief": valid_to IS NULL.)
//   1b. EXCLUDE fleeting-tier entries: an unacted-on idle thought is not a
//      "should-surface" target (human audit decision, 2026-06-18). Rerank must
//      not learn to float musings to the top, so fleeting rows are never labels.
//   2. From the CURRENT, non-fleeting entries whose topics include the query
//      topic, order by:
//        a. TIER, categorical: foundation > component > detail > fleeting.
//        b. USAGE BAND, a COARSE 3-way bucket of access_count (high/med/low),
//           NOT the raw count. Bucketing is what keeps the oracle describing the
//           entry rather than smuggling a fine-grained score back in.
//        c. RECENCY, newest timestamp first, as the final tiebreak only.
//   3. expected_top_k = the first K of that order (K = 5).
//
// Note on the flat `relevance` field in the fixture: it is held NEUTRAL (equal)
// across competing entries on a topic on purpose, so it cannot do the
// discriminating. This rule does not read it at all; the signals that decide
// order are tier, usage band, and recency. The rule also does not read
// `time_sensitive` or `importance`: time_sensitive feeds a separate guardrail
// the NEXT slice must honor, and importance is a future score input. Keeping
// the oracle blind to them keeps it simple and auditable.

const K = 5;

// Categorical tier rank. Lower number sorts first. Anything unknown sorts last.
const TIER_RANK = { foundation: 0, component: 1, detail: 2, fleeting: 3 };

function tierRank(tier) {
  return TIER_RANK[tier] !== undefined ? TIER_RANK[tier] : 99;
}

// COARSE 3-way usage band from access_count. The exact thresholds are chosen so
// the corpus's intended bands (zero/low details vs mid components vs heavily-hit
// foundations) fall cleanly into low/med/high. We return a rank where lower
// sorts first (high usage first).
//   high: access_count >= 15
//   med:  access_count >= 5
//   low:  access_count <  5  (includes zero)
function usageBand(accessCount) {
  if (accessCount >= 15) return 'high';
  if (accessCount >= 5) return 'med';
  return 'low';
}

const BAND_RANK = { high: 0, med: 1, low: 2 };

function usageBandRank(accessCount) {
  return BAND_RANK[usageBand(accessCount)];
}

// Does a comma-joined topics string include the query topic as a whole element?
// Mirrors how the live topicFilter matches: exact element, not substring, so
// "api" does not match "rapid".
function topicsInclude(topicsCsv, topic) {
  if (!topicsCsv) return false;
  return topicsCsv
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .includes(topic);
}

// An entry is the CURRENT belief iff valid_to is null. This is the same test the
// live code centralizes as notCorrected() => 'valid_to IS NULL'.
function isCurrent(entry) {
  return entry.valid_to === null || entry.valid_to === undefined;
}

// Compute the ordered candidate list for one topic. Exported so the audit report
// can show the full ranked slate, not just the top K.
function rankForTopic(entries, topic) {
  return entries
    .filter(e => isCurrent(e))
    .filter(e => e.tier !== 'fleeting')
    .filter(e => topicsInclude(e.topics, topic))
    .slice()
    .sort((a, b) => {
      const t = tierRank(a.tier) - tierRank(b.tier);
      if (t !== 0) return t;
      const u = usageBandRank(a.access_count) - usageBandRank(b.access_count);
      if (u !== 0) return u;
      // recency: newest first
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (tb !== ta) return tb - ta;
      // total order guard so output is deterministic across runs
      return a.id - b.id;
    });
}

// expected_top_k for one query = the top K ids of the ranked slate.
function expectedTopK(entries, topic, k = K) {
  return rankForTopic(entries, topic)
    .slice(0, k)
    .map(e => e.id);
}

// Run the rule over every query in a corpus and return a fresh queries array
// with expected_top_k filled in. Pure: does not mutate the input.
function deriveLabels(corpus) {
  return corpus.queries.map(q => ({
    ...q,
    expected_top_k: expectedTopK(corpus.entries, q.topic, K),
  }));
}

module.exports = {
  K,
  TIER_RANK,
  tierRank,
  usageBand,
  usageBandRank,
  topicsInclude,
  isCurrent,
  rankForTopic,
  expectedTopK,
  deriveLabels,
};
