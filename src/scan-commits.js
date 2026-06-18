'use strict';
const { execSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { ensureProjectFiles, loadRubric } = require('./rubric');

// `pebbl scan-commits` — raise the CAPTURE ceiling. pebbl can only recall what
// someone remembered to log; the worst failures come from decisions never
// captured at all. Scan recent commits for decision-shaped changes that have
// NO near-matching entry, and print ready-to-edit `pebbl log` lines. NEVER
// auto-logs — every line is a human/agent-confirmable suggestion.

// Fallback decision-verb pattern, mirroring the rubric's `decision` rule, for
// a repo whose rubric.yml isn't present.
const DEFAULT_DECISION_RE =
  /chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated/i;

// Distinctive words of a message, the style of context.js findRelatedCommits
// (lowercase, strip punctuation, drop short + stop words, dedupe).
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were',
  'they', 'will', 'would', 'could', 'should', 'which', 'their', 'about', 'into',
  'over', 'after', 'before', 'between', 'under', 'also', 'other', 'some', 'such',
  'only', 'then', 'than', 'like', 'just', 'much', 'more', 'most', 'very', 'when',
  'what', 'where', 'there', 'here', 'does', 'and', 'the', 'for', 'was', 'its']);

function words(s) {
  return [...new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w))
  )];
}

// Highest distinctive-word overlap of a commit subject against any entry.
// This is findRelatedCommits' scoring, inverted: a high overlap means the
// decision is already logged, so we do NOT re-nudge it.
function bestEntryOverlap(subject, entryWordSets) {
  const cw = words(subject);
  if (cw.length === 0) return 0;
  let best = 0;
  for (const ew of entryWordSets) {
    let n = 0;
    for (const w of cw) if (ew.has(w)) n++;
    if (n > best) best = n;
  }
  return best;
}

// Pure: decision-shaped commits with no near-matching entry. minOverlap = an
// entry sharing this many distinctive words counts as "already captured".
function uncapturedDecisions(commits, entryMessages, decisionPattern, minOverlap = 2) {
  const entryWordSets = entryMessages.map(m => new Set(words(m)));
  const out = [];
  for (const c of commits) {
    if (!decisionPattern.test(c.subject)) continue;                 // not a decision
    if (bestEntryOverlap(c.subject, entryWordSets) >= minOverlap) continue; // already logged
    out.push(c);
  }
  return out;
}

function decisionRe(pebblDir) {
  const rule = loadRubric(pebblDir).find(r => r.category === 'decision');
  return rule ? rule.pattern : DEFAULT_DECISION_RE;
}

function recentCommits(repoRoot, n) {
  try {
    const out = execSync(`git log --no-merges --format=%h%x09%s -${n}`, { cwd: repoRoot, encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const i = line.indexOf('\t');
      return { hash: line.slice(0, i), subject: line.slice(i + 1) };
    });
  } catch {
    return []; // not a git repo, or git unavailable
  }
}

function shq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = function scanCommits(args) {
  const { flags } = parseArgs(args);
  const n = parseInt(flags.n, 10) > 0 ? parseInt(flags.n, 10) : 30;
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const db = openDb(pebblDir);
  // Dedupe only against INTENTIONAL entries. The post-commit hook auto-logs
  // every commit verbatim (source='hook', fleeting); deduping against those
  // would make a commit always "match itself" and suppress every nudge. The
  // whole point is to promote a decision-shaped commit into a distilled entry.
  const entryMessages = db
    .prepare("SELECT message FROM logs WHERE tier != 'archived' AND source != 'hook'")
    .all().map(r => r.message);
  const commits = recentCommits(repoRoot, n);
  const missed = uncapturedDecisions(commits, entryMessages, decisionRe(pebblDir));

  if (missed.length === 0) {
    console.log(`pebbl scan-commits: no un-captured decision in the last ${n} commits.`);
    return;
  }
  const plural = missed.length === 1 ? '' : 's';
  console.log(`\npebbl scan-commits — ${missed.length} decision-shaped commit${plural} with no matching entry.`);
  console.log(`Log the ones that are real decisions (nothing was written):\n`);
  for (const c of missed) {
    console.log(`# ${c.hash}  ${c.subject}`);
    console.log(`pebbl log ${shq(c.subject)} --cat decision`);
    console.log();
  }
};

module.exports._internal = { words, bestEntryOverlap, uncapturedDecisions, decisionRe, DEFAULT_DECISION_RE };
