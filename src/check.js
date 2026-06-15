'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { ensureProjectFiles } = require('./rubric');

// `pebbl check` — flag memory entries that cite a file/symbol that no longer
// exists, so recall stays trustworthy. A confidently-wrong entry sends an
// agent down a false path with borrowed authority — worse than no memory.
// REPORT ONLY: never edits or deletes; it points at `--corrects`.

// Known source/text extensions. A path token must carry one to count as a
// HIGH-confidence file reference — this is what keeps the checker quiet enough
// to be trusted (a noisy checker gets ignored, like the thin-entry warning).
const PATH_EXT =
  'js|ts|jsx|tsx|mjs|cjs|sh|bash|py|rb|go|rs|java|kt|c|h|cc|cpp|md|json|ya?ml|toml|sql|txt|html|css|scss|conf|cfg|ini|env|lock';

// Path-like tokens: a slash plus a known extension, repo-relative (not
// absolute, not ~home, not a URL — those can't be verified against this repo).
// Defensive regex sweep over the message, the style of context.js
// findRelatedCommits.
function extractPaths(message) {
  const text = String(message || '').replace(/https?:\/\/\S+/g, ' '); // URLs aren't repo paths
  const re = new RegExp(
    `(?:^|[\\s\\\`'"(\\[])(\\.?[\\w.@-]*(?:/[\\w.@-]+)+\\.(?:${PATH_EXT}))(?=$|[\\s\\\`'".,;:)\\]])`,
    'g'
  );
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1];
    if (tok.startsWith('/') || tok.startsWith('~')) continue; // not repo-relative
    out.add(tok);
  }
  return [...out];
}

// Backtick-wrapped identifiers/calls (`foo`, `myFunc()`) for the opt-in --deep
// symbol grep.
function extractSymbols(message) {
  const out = new Set();
  const re = /`([A-Za-z_$][\w$]{2,})\(?\)?`/g;
  let m;
  while ((m = re.exec(String(message || ''))) !== null) out.add(m[1]);
  return [...out];
}

function symbolExists(repoRoot, sym) {
  try {
    execSync('git grep -qIF -- ' + shq(sym), { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false; // not found, or not a git repo → treat as absent under --deep
  }
}
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const TIER_RANK = { foundation: 0, component: 1, detail: 2, fleeting: 3 };

// Pure: entries + repo root → flagged entries (missing paths, plus missing
// symbols when deep), highest-tier then newest first. Mutates nothing.
function checkEntries(entries, repoRoot, { deep = false } = {}) {
  const flagged = [];
  for (const e of entries) {
    const missingPaths = extractPaths(e.message)
      .filter(p => !fs.existsSync(path.resolve(repoRoot, p)));
    const missingSymbols = deep
      ? extractSymbols(e.message).filter(s => !symbolExists(repoRoot, s))
      : [];
    if (missingPaths.length || missingSymbols.length) {
      flagged.push({ ...e, missingPaths, missingSymbols });
    }
  }
  flagged.sort((a, b) =>
    ((TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)) ||
    String(b.timestamp).localeCompare(String(a.timestamp)));
  return flagged;
}

module.exports = function check(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const db = openDb(pebblDir);
  const entries = db.prepare(
    "SELECT id, timestamp, category, tier, message FROM logs WHERE tier != 'archived' ORDER BY timestamp DESC"
  ).all();
  const flagged = checkEntries(entries, repoRoot, { deep: !!flags.deep });

  if (flagged.length === 0) {
    console.log(`pebbl check: no entry cites a missing file${flags.deep ? ' or symbol' : ''}. Memory looks trustworthy.`);
    return;
  }

  const noun = flagged.length === 1 ? 'entry cites a' : 'entries cite';
  console.log(`\npebbl check — ${flagged.length} ${noun} missing artifact (report only, nothing changed):\n`);
  for (const e of flagged) {
    const date = String(e.timestamp || '').slice(0, 10);
    const msg = e.message.length > 100 ? e.message.slice(0, 100) + '…' : e.message;
    console.log(`#${e.id} [${e.tier}|${e.category}] ${date} — ${msg}`);
    if (e.missingPaths.length) console.log(`   missing path: ${e.missingPaths.join(', ')}`);
    if (e.missingSymbols.length) console.log(`   missing symbol: ${e.missingSymbols.join(', ')}`);
    console.log(`   if wrong, supersede:  pebbl log "<corrected memory>" --corrects ${e.id}`);
    console.log();
  }
};

module.exports._internal = { extractPaths, extractSymbols, checkEntries, TIER_RANK };
