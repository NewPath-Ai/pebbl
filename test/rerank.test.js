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
//     - rerank: rank.js's rankCandidates (importance/usage/recency/relevance)
//
// ASSERTIONS
//   (a) DISCRIMINATION: aggregate rerank recall@5 across the 8 queries is
//       STRICTLY GREATER than the recency baseline's. If rerank cannot beat
//       recency, the feature is not justified. (Kept on RECENCY only.)
//   (b) GUARDRAIL: every time_sensitive entry the recency baseline put in a
//       query's top-5 also appears in rerank's top-5 (do not bury a live hotfix).
//   (c) we print a three-way per-query + aggregate recall@5 table.
//   (d) we REPORT rerank vs the live baseline (beats / ties / loses, aggregate +
//       per-query regressions). This is NOT force-asserted: the point of the eval
//       is to find the answer, so faking an assertion would defeat it.

const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const { topicFilter, notCorrected } = require('../src/db');
const { rankCandidates } = require('../src/rank');

const CORPUS_PATH = path.join(__dirname, 'fixtures', 'rerank-corpus.json');
const K = 5;

let dir, db, corpus;

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
}

// Load the corpus entries into a tmp sqlite that carries every column the score
// and the guardrail read. We insert id explicitly so candidate ids line up with
// expected_top_k. This is a fixture loader, not a migration test.
function setupDb() {
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
  for (const e of corpus.entries) {
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

describe('rerank score vs audited fixture', () => {
  before(() => {
    corpus = loadCorpus();
    db = setupDb();
  });
  after(() => {
    if (db) db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rerank recall@5 beats recency (discrimination) and never buries a time-sensitive entry (guardrail)', () => {
    const now = corpus.now; // freeze recency to the fixture's NOW
    const rows = [];
    let sumRecency = 0;
    let sumLive = 0;
    let sumRerank = 0;
    let guardrailViolations = [];
    let rerankRegressionsVsLive = []; // queries where rerank < live (reported, not asserted)

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

      rows.push({
        query: q.id,
        expected: q.expected_top_k.length,
        recency: rRec,
        live: rLive,
        rerank: rRr,
        recencyTop,
        liveTop,
        rerankTop,
      });
    }

    const aggRecency = sumRecency / corpus.queries.length;
    const aggLive = sumLive / corpus.queries.length;
    const aggRerank = sumRerank / corpus.queries.length;

    // (c) THREE-WAY per-query recall@5: recency vs live (tier-then-id) vs rerank.
    console.log('\n  rerank evaluation (recall@5, K=' + K + ', NOW=' + corpus.now + ')');
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

    // (d) VERDICT: rerank vs the LIVE baseline (the bar that actually matters).
    // REPORTED, not force-asserted — we do not know the answer in advance and must
    // not fake it. The discrimination assertion below stays on recency only.
    const delta = aggRerank - aggLive;
    let verdict;
    if (delta > 1e-9) verdict = 'BEATS';
    else if (delta < -1e-9) verdict = 'LOSES TO';
    else verdict = 'TIES';
    console.log('  rerank vs LIVE (tier-then-id): rerank ' + verdict + ' live ' +
      '(rerank ' + aggRerank.toFixed(3) + ' vs live ' + aggLive.toFixed(3) +
      ', delta ' + (delta >= 0 ? '+' : '') + delta.toFixed(3) + ')');
    if (rerankRegressionsVsLive.length > 0) {
      console.log('  rerank REGRESSES below live on ' + rerankRegressionsVsLive.length + ' query(ies): ' +
        rerankRegressionsVsLive.map(r => r.query + ' (live ' + r.live.toFixed(3) + ' > rerank ' + r.rerank.toFixed(3) + ')').join(', '));
    } else {
      console.log('  rerank never regresses below live on any single query.');
    }
    console.log('');

    // (b) GUARDRAIL
    assert.deepStrictEqual(
      guardrailViolations,
      [],
      'rerank dropped a time-sensitive entry that recency surfaced: ' +
        JSON.stringify(guardrailViolations)
    );

    // (a) DISCRIMINATION
    assert.ok(
      aggRerank > aggRecency,
      `rerank aggregate recall@5 (${aggRerank.toFixed(3)}) must STRICTLY exceed ` +
        `recency baseline (${aggRecency.toFixed(3)})`
    );
  });
});
