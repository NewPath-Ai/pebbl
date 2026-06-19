'use strict';

// Freeze computed labels into the corpus and emit a human-readable audit report.
//
// This is the build step for the rerank fixture. It:
//   1. loads test/fixtures/rerank-corpus.json
//   2. runs the documented oracle in rerank-ground-truth.js over it
//   3. writes the computed expected_top_k back into the corpus (so the JSON a
//      test consumes carries frozen labels, not labels recomputed at test time)
//   4. writes test/fixtures/rerank-labels-audit.md: one table per query so a
//      human can eyeball every label in a single sitting.
//
// Run: node test/build-rerank-labels.js
// It is deterministic; re-running with an unchanged corpus produces no diff.

const fs = require('fs');
const path = require('path');
const gt = require('./rerank-ground-truth');

const CORPUS_PATH = path.join(__dirname, 'fixtures', 'rerank-corpus.json');
const AUDIT_PATH = path.join(__dirname, 'fixtures', 'rerank-labels-audit.md');
const NOW = '2026-06-18T12:00:00.000Z';

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
}

// Coarse human-readable age bucket from a timestamp relative to NOW.
function ageLabel(timestamp) {
  const days = (Date.parse(NOW) - Date.parse(timestamp)) / 86400000;
  if (days < 7) return `${Math.round(days)}d (fresh)`;
  if (days < 35) return `${Math.round(days)}d`;
  const months = days / 30;
  return `~${months.toFixed(1)}mo`;
}

function shortMsg(message, max = 60) {
  return message.length <= max ? message : message.slice(0, max - 3) + '...';
}

function entryById(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.id, e);
  return m;
}

// Freeze labels into the corpus JSON in place (preserving key order and the
// _README block) and write it back with a trailing newline for clean diffs.
function freezeLabels(corpus) {
  const labeled = gt.deriveLabels(corpus);
  const byId = new Map(labeled.map(q => [q.id, q.expected_top_k]));
  for (const q of corpus.queries) {
    q.expected_top_k = byId.get(q.id);
  }
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
}

function buildAudit(corpus) {
  const byId = entryById(corpus.entries);
  const lines = [];
  lines.push('# Rerank label audit');
  lines.push('');
  lines.push(`Fixture: \`test/fixtures/rerank-corpus.json\` (${corpus.entries.length} entries). NOW = ${NOW}.`);
  lines.push('');
  lines.push('Labels below are COMPUTED by `test/rerank-ground-truth.js`, not hand-picked.');
  lines.push('Oracle rule: drop superseded (valid_to set), then order current entries on the');
  lines.push('query topic by tier (foundation>component>detail>fleeting), then a coarse 3-way');
  lines.push('usage band (high>=15, med>=5, low<5 access_count), then recency. Top 5 = the label.');
  lines.push('');
  lines.push('A human should be able to scan each table and agree the top rows belong on top.');
  lines.push('The "excluded (superseded)" note under each query lists rows the rule dropped, so');
  lines.push('you can confirm a superseded row was meant to be hidden (not lost by accident).');
  lines.push('');

  for (const q of corpus.queries) {
    lines.push(`## ${q.id} - topic: \`${q.topic}\``);
    lines.push('');
    if (q.intent) lines.push(`Intent: ${q.intent}`);
    lines.push('');
    lines.push(`Computed expected_top_k: [${q.expected_top_k.join(', ')}]`);
    lines.push('');
    lines.push('| rank | id | message | tier | usage band (count) | age | state |');
    lines.push('| ---- | -- | ------- | ---- | ------------------ | --- | ----- |');
    q.expected_top_k.forEach((id, i) => {
      const e = byId.get(id);
      const band = `${gt.usageBand(e.access_count)} (${e.access_count})`;
      const state = gt.isCurrent(e) ? 'current' : 'superseded';
      const ts = e.time_sensitive ? ' [TIME-SENSITIVE]' : '';
      lines.push(`| ${i + 1} | ${e.id} | ${shortMsg(e.message)} | ${e.tier} | ${band} | ${ageLabel(e.timestamp)} | ${state}${ts} |`);
    });
    lines.push('');

    // Show what the rule dropped on this topic, split into superseded vs
    // ranked-but-below-K, so the auditor can see the full picture.
    const onTopic = corpus.entries.filter(e => gt.topicsInclude(e.topics, q.topic));
    const superseded = onTopic.filter(e => !gt.isCurrent(e));
    if (superseded.length) {
      const parts = superseded.map(e => `#${e.id} (${e.tier}, → superseded by #${e.invalidated_by})`);
      lines.push(`Excluded as superseded: ${parts.join('; ')}.`);
      lines.push('');
    }
    const ranked = gt.rankForTopic(corpus.entries, q.topic);
    const belowK = ranked.slice(gt.K).map(e => `#${e.id} (${e.tier}, ${gt.usageBand(e.access_count)})`);
    if (belowK.length) {
      lines.push(`Current but below top-${gt.K}: ${belowK.join('; ')}.`);
      lines.push('');
    }
  }

  fs.writeFileSync(AUDIT_PATH, lines.join('\n'), 'utf8');
  return lines.join('\n');
}

function main() {
  const corpus = loadCorpus();
  freezeLabels(corpus);
  // reload so the audit reflects exactly what landed on disk
  const frozen = loadCorpus();
  const report = buildAudit(frozen);
  process.stdout.write(report + '\n');
  process.stdout.write(`\nWrote labels into ${path.relative(process.cwd(), CORPUS_PATH)}\n`);
  process.stdout.write(`Wrote audit to ${path.relative(process.cwd(), AUDIT_PATH)}\n`);
}

// Only write when invoked directly (node test/build-rerank-labels.js), never
// when the test runner loads this file. node --test runs each test-dir file as
// main, so the require.main guard alone is not enough; re-freezing during a test
// run would silently overwrite the human-audited labels.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) main();

module.exports = { ageLabel, freezeLabels, buildAudit };
