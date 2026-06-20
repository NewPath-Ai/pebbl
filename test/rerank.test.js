'use strict';

// Rerank SCORE evaluation against the audited fixture.
//
// WHAT THIS PROVES (tracer bullet scope)
//   The weighted score in src/rank.js recovers the human-audited labels in
//   test/fixtures/rerank-corpus.json BETTER than a plain recency ordering, on a
//   deliberately adversarial corpus, WITHOUT reading tier as a category and
//   WITHOUT tuning to the answer key.
//
// HOW
//   The fixture's expected_top_k labels were COMPUTED by test/rerank-ground-truth.js
//   (oracle: drop superseded + fleeting, then tier > coarse usage band > recency).
//   For each query we build the candidate set the way the LIVE read path would:
//     candidates = current (valid_to IS NULL) entries whose topics include the
//     query topic. We use the real db.js predicates (topicFilter + notCorrected)
//     against a tmp sqlite loaded from the corpus, so we exercise the same
//     filtering the product uses, not a reimplementation.
//   Then we compute recall@5 against expected_top_k for THREE orderings:
//     - recency baseline: timestamp DESC
//     - live baseline: a faithful replication of what src/context.js ALREADY
//       does on its current-belief reads (tier rank ASC, then id DESC) over the
//       same candidate set. This is the ordering rerank would REPLACE, so it is
//       the real bar: beating recency is not enough to justify wiring rerank live.
//     - rerank: rank.js's rankCandidates (importance/usage/relevance score; recency
//       is a TIEBREAK below id, not a weighted term — see FIX 2 in rank.js)
//
// CONDITIONS
//   [fixture-usage] authored access_count + importance — the eventual WIN: rerank
//       BEATS live once usage has built up (asserted).
//   [fresh-launch]  access_count=0 AND importance=tier-derived — THE no-launch-
//       regression GATE (the real day-one state): rerank >= live (asserted).
//   [zeroed-usage]  access_count=0 but audited importance kept — a hybrid no real
//       store reaches; DIAGNOSTIC only, not the gate (guardrail still asserted).
//
// ASSERTIONS
//   (a) DISCRIMINATION: aggregate rerank recall@5 across the queries is STRICTLY
//       GREATER than the recency baseline's. If rerank cannot beat recency, the
//       feature is not justified. (Kept on RECENCY only.)
//   (b) GUARDRAIL: every time_sensitive entry the recency baseline put in a
//       query's top-5 also appears in rerank's top-5 (do not bury a live hotfix).
//       Asserted in every condition.
//   (c) we print a three-way per-query + aggregate recall@5 table.
//   (d) [fixture-usage] rerank BEATS live (asserted); [fresh-launch] rerank >= live
//       (asserted gate); [zeroed-usage] reported, not margin-asserted.

const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const { topicFilter, notCorrected } = require('../src/db');
const { rankCandidates, importanceForTier } = require('../src/rank');

const CORPUS_PATH = path.join(__dirname, 'fixtures', 'rerank-corpus.json');
const K = 5;

let dir, db, corpus;

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
}

// Load the corpus entries into a tmp sqlite that carries every column the score
// and the guardrail read. We insert id explicitly so candidate ids line up with
// expected_top_k. This is a fixture loader, not a migration test.
//
// `transform(entry) -> entry` lets a condition rewrite signal columns BEFORE
// insert without touching the audited fixture file. The zeroed-usage condition
// uses it to force access_count = 0 and importance = tier-derived (the real
// launch state: log.js sets importance from tier at write time and v0.7 backfills
// it, while access_count starts at 0 everywhere). Default is identity.
function setupDb(transform = (e) => e) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-rerank-'));
  const database = new Database(path.join(d, 'db.sqlite'));
  database.exec(`
    CREATE TABLE logs (
      id             INTEGER PRIMARY KEY,
      timestamp      TEXT NOT NULL,
      source         TEXT,
      category       TEXT,
      tier           TEXT,
      message        TEXT NOT NULL,
      topics         TEXT,
      relates_to     INTEGER,
      corrects       INTEGER,
      valid_from     TEXT,
      valid_to       TEXT,
      invalidated_by INTEGER,
      importance     REAL DEFAULT 0,
      access_count   INTEGER DEFAULT 0,
      last_accessed  TEXT DEFAULT NULL,
      time_sensitive INTEGER DEFAULT 0,
      relevance      REAL
    );
  `);
  const ins = database.prepare(`
    INSERT INTO logs
      (id, timestamp, source, category, tier, message, topics, relates_to, corrects,
       valid_to, invalidated_by, importance, access_count, last_accessed, time_sensitive, relevance)
    VALUES
      (@id, @timestamp, @source, @category, @tier, @message, @topics, @relates_to, @corrects,
       @valid_to, @invalidated_by, @importance, @access_count, @last_accessed, @time_sensitive, @relevance)
  `);
  for (const raw of corpus.entries) {
    const e = transform({ ...raw });
    ins.run({
      id: e.id,
      timestamp: e.timestamp,
      source: e.source,
      category: e.category,
      tier: e.tier,
      message: e.message,
      topics: e.topics,
      relates_to: e.relates_to,
      corrects: e.corrects,
      valid_to: e.valid_to,
      invalidated_by: e.invalidated_by,
      importance: e.importance,
      access_count: e.access_count,
      last_accessed: e.last_accessed,
      time_sensitive: e.time_sensitive ? 1 : 0,
      relevance: e.relevance,
    });
  }
  dir = d;
  return database;
}

// FRESH-LAUNCH transform — THE real launch state and the no-launch-regression
// GATE. A brand-new store has BOTH signals at their launch values: access_count=0
// everywhere (nothing has been looked up yet) AND importance = its tier-derived
// default (log.js writes that at log time and the v0.7 backfill produces it; no
// human-audited importance exists yet). With usage flat and importance tier-flat,
// same-tier entries score EXACTLY equal, so the id-DESC tiebreak in rankCandidates
// fires and reproduces the live tier-then-id order — the whole point of FIX 2.
// This is the condition rerank must NOT regress on, so it is the asserted gate
// (rerank >= live). We do NOT touch valid_to / tier / expected labels.
function freshLaunchState(e) {
  e.access_count = 0;
  e.last_accessed = null;
  e.importance = importanceForTier(e.tier);
  return e;
}

// ZEROED-usage transform — a DIAGNOSTIC, NOT the launch state. It zeroes
// access_count but KEEPS the fixture's hand-audited importance. That is a HYBRID
// no real store reaches: a fresh store has no audited importance (it gets the
// tier-derived default, see freshLaunchState), and a store old enough to have
// audited importance has also accrued access_count. It is retained only to show
// that audited per-entry importance, when present, lifts rerank further above the
// live baseline even before usage builds. It is explicitly NOT the no-regression
// gate (freshLaunchState is). We do NOT touch valid_to / tier / labels.
function zeroUsage(e) {
  e.access_count = 0;
  e.last_accessed = null;
  return e;
}

// Candidate set for a query: current + on-topic, via the live predicates. Mirrors
// what context.js / search.js select before any ordering.
function candidatesForTopic(topic) {
  const filter = topicFilter(topic);
  const sql = `
    SELECT id, timestamp, tier, topics, importance, access_count, time_sensitive, relevance
    FROM logs
    WHERE ${notCorrected()} ${filter.clause}
  `;
  return db.prepare(sql).all(...filter.params);
}

function recall(topIds, expected) {
  const got = new Set(topIds);
  const hits = expected.filter(id => got.has(id)).length;
  return hits / expected.length;
}

// Recency baseline ordering: newest timestamp first, id ascending as a stable
// tiebreak. Pure JS so it matches how the harness orders rerank candidates.
function recencyOrder(candidates) {
  return candidates.slice().sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (tb !== ta) return tb - ta;
    return a.id - b.id;
  });
}

// LIVE baseline ordering: a faithful replication of what src/context.js ALREADY
// does on its current-belief reads, applied to the SAME candidate set (current +
// on-topic). This is the ordering rerank would REPLACE, so it is the bar rerank
// must clear to justify wiring it live. Beating recency is not enough.
//
// What context.js does (verbatim sources in the repo at the eval branch):
//   contextFull / contextAsOf (SQL):
//     ORDER BY CASE tier WHEN 'foundation' THEN 0 WHEN 'component' THEN 1
//              WHEN 'detail' THEN 2 WHEN 'fleeting' THEN 3 ELSE 4 END, id DESC
//   contextTopic (JS sort over the combined foundation+component+detail set):
//     tierOrder {foundation:0, component:1, detail:2} else 3, then b.id - a.id
// Both reduce to the same rule: tier rank ASC, then id DESC. contextTopic is the
// read most comparable to a ranked "what is relevant on this topic" retrieval
// (it is the --topic path), so its ordering is the one replicated here. The tier
// map below matches the SQL CASE exactly (fleeting=3, unknown=4) so any tier in
// the candidate set is ordered the way the live path would order it.
const LIVE_TIER_RANK = { foundation: 0, component: 1, detail: 2, fleeting: 3 };

function liveTierRank(tier) {
  return LIVE_TIER_RANK[tier] !== undefined ? LIVE_TIER_RANK[tier] : 4;
}

function liveOrder(candidates) {
  return candidates.slice().sort((a, b) => {
    const ra = liveTierRank(a.tier);
    const rb = liveTierRank(b.tier);
    if (ra !== rb) return ra - rb; // tier rank ascending
    return b.id - a.id;            // then id DESC, exactly like context.js
  });
}

// One evaluation pass over all queries against whatever rows `db` currently
// holds. Pure of assertions: it computes the three-way recall@5, prints the
// table, and RETURNS the aggregates + per-query regressions so the caller (each
// condition's it-block) decides what to assert. `label` names the condition in
// the printed header so the two passes are distinguishable in the log.
function runEval(label) {
  const now = corpus.now; // freeze recency to the fixture's NOW
  const rows = [];
  let sumRecency = 0;
  let sumLive = 0;
  let sumRerank = 0;
  const guardrailViolations = [];
  const rerankRegressionsVsLive = []; // queries where rerank < live

  for (const q of corpus.queries) {
    const candidates = candidatesForTopic(q.topic);

    const recencyTop = recencyOrder(candidates).slice(0, K).map(e => e.id);
    const liveTop = liveOrder(candidates).slice(0, K).map(e => e.id);
    const rerankTop = rankCandidates(candidates, { now }).slice(0, K).map(e => e.id);

    const rRec = recall(recencyTop, q.expected_top_k);
    const rLive = recall(liveTop, q.expected_top_k);
    const rRr = recall(rerankTop, q.expected_top_k);
    sumRecency += rRec;
    sumLive += rLive;
    sumRerank += rRr;

    if (rRr < rLive) {
      rerankRegressionsVsLive.push({ query: q.id, live: rLive, rerank: rRr });
    }

    // Guardrail: a time_sensitive entry the recency baseline surfaced in its
    // top-5 must also be in rerank's top-5.
    const recencySet = new Set(recencyTop);
    const rerankSet = new Set(rerankTop);
    for (const e of candidates) {
      if (e.time_sensitive && recencySet.has(e.id) && !rerankSet.has(e.id)) {
        guardrailViolations.push({ query: q.id, id: e.id });
      }
    }

    rows.push({ query: q.id, expected: q.expected_top_k.length, recency: rRec, live: rLive, rerank: rRr });
  }

  const aggRecency = sumRecency / corpus.queries.length;
  const aggLive = sumLive / corpus.queries.length;
  const aggRerank = sumRerank / corpus.queries.length;

  // (c) THREE-WAY per-query recall@5: recency vs live (tier-then-id) vs rerank.
  console.log('\n  rerank evaluation [' + label + '] (recall@5, K=' + K + ', NOW=' + corpus.now + ')');
  console.log('  three-way: RECENCY (timestamp DESC) | LIVE (context.js tier-then-id) | RERANK (rank.js)');
  console.log('  query           | expected | recency |   live | rerank');
  console.log('  ----------------|----------|---------|--------|-------');
  for (const r of rows) {
    console.log(
      '  ' + r.query.padEnd(15) +
      ' | ' + String(r.expected).padStart(8) +
      ' | ' + r.recency.toFixed(3).padStart(7) +
      ' | ' + r.live.toFixed(3).padStart(6) +
      ' | ' + r.rerank.toFixed(3).padStart(6)
    );
  }
  console.log('  ----------------|----------|---------|--------|-------');
  console.log(
    '  ' + 'AGGREGATE'.padEnd(15) +
    ' | ' + ''.padStart(8) +
    ' | ' + aggRecency.toFixed(3).padStart(7) +
    ' | ' + aggLive.toFixed(3).padStart(6) +
    ' | ' + aggRerank.toFixed(3).padStart(6)
  );
  console.log('');

  // VERDICT: rerank vs the LIVE baseline (the bar that actually matters).
  const delta = aggRerank - aggLive;
  let verdict;
  if (delta > 1e-9) verdict = 'BEATS';
  else if (delta < -1e-9) verdict = 'LOSES TO';
  else verdict = 'TIES';
  console.log('  [' + label + '] rerank vs LIVE (tier-then-id): rerank ' + verdict + ' live ' +
    '(rerank ' + aggRerank.toFixed(3) + ' vs live ' + aggLive.toFixed(3) +
    ', delta ' + (delta >= 0 ? '+' : '') + delta.toFixed(3) + ')');
  if (rerankRegressionsVsLive.length > 0) {
    console.log('  [' + label + '] rerank REGRESSES below live on ' + rerankRegressionsVsLive.length + ' query(ies): ' +
      rerankRegressionsVsLive.map(r => r.query + ' (live ' + r.live.toFixed(3) + ' > rerank ' + r.rerank.toFixed(3) + ')').join(', '));
  } else {
    console.log('  [' + label + '] rerank never regresses below live on any single query.');
  }
  console.log('');

  return { aggRecency, aggLive, aggRerank, delta, guardrailViolations, rerankRegressionsVsLive };
}

// CONDITION (a): FIXTURE-USAGE — the corpus's authored access_count/importance.
// This is the eventual-win proof: once real usage has built up, rerank BEATS the
// live tier-then-id baseline on the within-tier cases.
describe('rerank score vs audited fixture [fixture-usage]', () => {
  before(() => {
    corpus = loadCorpus();
    db = setupDb(); // identity transform — authored signals
  });
  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rerank beats recency (discrimination), beats live (eventual win), never buries time-sensitive (guardrail)', () => {
    const r = runEval('fixture-usage');

    // (b) GUARDRAIL: a hotfix recency surfaced is never buried by rerank.
    assert.deepStrictEqual(
      r.guardrailViolations,
      [],
      'rerank dropped a time-sensitive entry that recency surfaced: ' + JSON.stringify(r.guardrailViolations)
    );

    // (a) DISCRIMINATION: rerank must strictly beat the recency baseline.
    assert.ok(
      r.aggRerank > r.aggRecency,
      `rerank aggregate recall@5 (${r.aggRerank.toFixed(3)}) must STRICTLY exceed recency baseline (${r.aggRecency.toFixed(3)})`
    );

    // EVENTUAL-WIN: with real usage built up, rerank must strictly beat the live
    // tier-then-id baseline it replaces. This is the justification for wiring it.
    assert.ok(
      r.aggRerank > r.aggLive,
      `[fixture-usage] rerank (${r.aggRerank.toFixed(3)}) must beat live tier-then-id (${r.aggLive.toFixed(3)})`
    );
  });
});

// CONDITION (b): FRESH-LAUNCH — THE no-launch-regression GATE (the real launch
// state: access_count=0 AND importance=tier-derived, see freshLaunchState). With
// usage flat and importance tier-flat, same-tier entries score equal and the
// id-DESC tiebreak reproduces the live tier-then-id order, so rerank must NOT
// regress below live on day one. Before FIX 2 (recency was a weighted score term)
// this REGRESSED to 0.846 < live 0.862 on the q-api out-of-order insert; demoting
// recency to a tiebreak below id closed it (rerank ties live at 0.862). If this
// asserts false, the launch ordering regressed and the wiring is NOT safe to ship.
describe('rerank no-launch-regression [fresh-launch] (THE GATE)', () => {
  before(() => {
    corpus = loadCorpus();
    db = setupDb(freshLaunchState); // access_count=0 AND importance=tier-derived
  });
  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('at fresh launch (zero usage, tier-derived importance), rerank does NOT regress below live', () => {
    const r = runEval('fresh-launch');

    // Guardrail still holds at launch.
    assert.deepStrictEqual(
      r.guardrailViolations,
      [],
      'rerank dropped a time-sensitive entry that recency surfaced: ' + JSON.stringify(r.guardrailViolations)
    );

    // THE NO-LAUNCH-REGRESSION GATE: rerank aggregate recall must be >= live.
    // Tolerance: a tiny epsilon so float noise does not trip an exact tie.
    assert.ok(
      r.aggRerank >= r.aggLive - 1e-9,
      `[fresh-launch] LAUNCH REGRESSION: rerank (${r.aggRerank.toFixed(3)}) fell below live tier-then-id (${r.aggLive.toFixed(3)}). ` +
        'FIX 2 (recency as a tiebreak below id, not a score term) is supposed to prevent this. DO NOT SHIP.'
    );

    // Also pin the specific within-tier case FIX 2 fixed: q-api (an out-of-
    // timestamp-order insert) must be at full recall, proving the id-DESC tiebreak
    // — not recency — decides same-score order at launch.
    const qApi = corpus.queries.find(q => q.id === 'q-api');
    if (qApi) {
      const cands = candidatesForTopic(qApi.topic);
      const top = rankCandidates(cands, { now: corpus.now }).slice(0, K).map(e => e.id);
      assert.strictEqual(
        recall(top, qApi.expected_top_k), 1,
        '[fresh-launch] q-api regressed: id-DESC tiebreak should reproduce the live order exactly'
      );
    }
  });
});

// DIAGNOSTIC [zeroed-usage] — NOT the launch state, NOT a hard gate. A hybrid no
// real store reaches (audited importance kept but access_count zeroed, see
// zeroUsage). Retained only to show that audited per-entry importance, when it
// exists, lifts rerank further above the live baseline even before usage builds.
// REPORTED, not asserted on the >= live margin (the fresh-launch gate above owns
// that). The guardrail IS asserted (a hotfix must never be buried, in any state).
describe('rerank diagnostic [zeroed-usage] (NOT the launch state)', () => {
  before(() => {
    corpus = loadCorpus();
    db = setupDb(zeroUsage); // access_count=0; importance kept as authored
  });
  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports rerank vs live with audited importance but zero usage (diagnostic, guardrail asserted)', () => {
    const r = runEval('zeroed-usage');
    console.log('  [zeroed-usage] DIAGNOSTIC (not a gate): rerank ' + r.aggRerank.toFixed(3) +
      ' vs live ' + r.aggLive.toFixed(3) + '. The launch gate is [fresh-launch].');

    // Guardrail must hold in every condition (this IS asserted).
    assert.deepStrictEqual(
      r.guardrailViolations,
      [],
      'rerank dropped a time-sensitive entry that recency surfaced: ' + JSON.stringify(r.guardrailViolations)
    );
  });
});
