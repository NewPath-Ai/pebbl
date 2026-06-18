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
//   Then we compute recall@5 against expected_top_k for two orderings:
//     - recency baseline: timestamp DESC
//     - rerank: rank.js's rankCandidates (importance/usage/recency/relevance)
//
// ASSERTIONS
//   (a) DISCRIMINATION: aggregate rerank recall@5 across the 8 queries is
//       STRICTLY GREATER than the recency baseline's. If rerank cannot beat
//       recency, the feature is not justified.
//   (b) GUARDRAIL: every time_sensitive entry the recency baseline put in a
//       query's top-5 also appears in rerank's top-5 (do not bury a live hotfix).
//   (c) we print per-query recall@5 for both orderings.

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
    let sumRerank = 0;
    let guardrailViolations = [];

    for (const q of corpus.queries) {
      const candidates = candidatesForTopic(q.topic);

      const recencyTop = recencyOrder(candidates).slice(0, K).map(e => e.id);
      const rerankTop = rankCandidates(candidates, { now }).slice(0, K).map(e => e.id);

      const rRec = recall(recencyTop, q.expected_top_k);
      const rRr = recall(rerankTop, q.expected_top_k);
      sumRecency += rRec;
      sumRerank += rRr;

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
        rerank: rRr,
        recencyTop,
        rerankTop,
      });
    }

    const aggRecency = sumRecency / corpus.queries.length;
    const aggRerank = sumRerank / corpus.queries.length;

    // (c) print per-query recall@5 for both orderings
    console.log('\n  rerank evaluation (recall@5, K=' + K + ', NOW=' + corpus.now + ')');
    console.log('  query           | expected | recency | rerank');
    console.log('  ----------------|----------|---------|-------');
    for (const r of rows) {
      console.log(
        '  ' + r.query.padEnd(15) +
        ' | ' + String(r.expected).padStart(8) +
        ' | ' + r.recency.toFixed(3).padStart(7) +
        ' | ' + r.rerank.toFixed(3).padStart(6)
      );
    }
    console.log('  ----------------|----------|---------|-------');
    console.log(
      '  ' + 'AGGREGATE'.padEnd(15) +
      ' | ' + ''.padStart(8) +
      ' | ' + aggRecency.toFixed(3).padStart(7) +
      ' | ' + aggRerank.toFixed(3).padStart(6)
    );
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
