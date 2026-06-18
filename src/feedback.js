'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { parseArgs } = require('./args');
const { findPebblDir } = require('./find-pebbl');

const FEEDBACK_FILE = 'feedback.jsonl';
const { version } = require('../package.json');

// Resolve where feedback lands. Prefer an existing .pebbl/ found by walking up
// from cwd (feedback rides along with the project it's about). If there is NO
// project tree, fall back to a GLOBAL store at ~/.pebbl/feedback.jsonl rather
// than minting a stray .pebbl/ in whatever directory you happened to be in —
// stray dirs scattered across the filesystem were pure noise and got ignored.
// Returns { dir, global } so callers can warn when feedback went global.
function resolveFeedbackDir() {
  const existing = findPebblDir();
  if (existing) return { dir: existing, global: false };
  const dir = path.join(os.homedir(), '.pebbl');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, global: true };
}

function gitContext() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return branch || null;
  } catch {
    return null;
  }
}

// Read the jsonl and fold the resolve markers into status. A line is either a
// feedback entry ({id, message, ...}) or a resolve marker ({resolves: <id>}).
// Returns entries (each with a derived `resolved` boolean) in write order.
// Markers stay append-only — we never rewrite the file, so resolving is a single
// append, the same jsonl-consistent shape feedback itself uses.
function readFeedback(dir) {
  const file = path.join(dir, FEEDBACK_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  const entries = [];
  const resolved = new Set();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.resolves) {
      resolved.add(String(e.resolves));
      continue;
    }
    if (e && e.message) entries.push(e);
  }
  for (const e of entries) {
    // Back-compat: entries written before stable ids existed have none. Derive
    // one so old feedback is still listable/resolvable instead of orphaned.
    if (!e.id) e.id = shortId(JSON.stringify(e));
    e.resolved = resolved.has(String(e.id));
  }
  return entries;
}

function shortId(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
}

// Read-only surface for `pebbl context`: the unresolved feedback, with a pointer
// to the triage commands. Reads feedback.jsonl DIRECTLY (feedback deliberately
// bypasses SQLite — the db/qmd layers are exactly what's misbehaving when you
// reach for feedback). Resolved items drop off, so this can't become the
// forever-noise the old compaction nag was. Prints nothing when nothing is open.
function showRecentFeedback(pebblDir) {
  const entries = readFeedback(pebblDir).filter(e => !e.resolved);
  if (entries.length === 0) return;

  console.log(`--- UNRESOLVED FEEDBACK (${entries.length}) ---`);
  for (const e of entries.slice(0, 5)) {
    const date = (e.timestamp || '').slice(0, 10);
    console.log(`  [${e.id}] ${date ? date + ' — ' : ''}${e.message}`);
    if (e.branch) console.log(`         branch: ${e.branch}`);
  }
  if (entries.length > 5) console.log(`  … +${entries.length - 5} more`);
  console.log('  → review/resolve: pebbl feedback --list');
  console.log('---');
  console.log('');
}

function listFeedback(dir, isGlobal) {
  const entries = readFeedback(dir).filter(e => !e.resolved);
  if (entries.length === 0) {
    console.log('No unresolved feedback.');
    return;
  }
  const where = isGlobal ? ' (global ~/.pebbl)' : '';
  console.log(`Unresolved feedback${where}:`);
  for (const e of entries) {
    const date = (e.timestamp || '').slice(0, 10);
    console.log(`[${e.id}] ${date} ${e.message}`);
    if (e.branch) console.log(`  branch: ${e.branch}`);
    if (e.cwd) console.log(`  cwd: ${e.cwd}`);
  }
  console.log('');
  console.log('Resolve one with: pebbl feedback --resolve <id>');
}

function resolveFeedback(dir, id) {
  const file = path.join(dir, FEEDBACK_FILE);
  const entries = readFeedback(dir);
  const match = entries.find(e => String(e.id) === String(id));
  if (!match) {
    console.error(`pebbl: no feedback with id "${id}". Run: pebbl feedback --list`);
    process.exit(1);
  }
  if (match.resolved) {
    console.log(`Feedback [${id}] is already resolved.`);
    return;
  }
  const marker = { resolves: String(id), timestamp: new Date().toISOString() };
  fs.appendFileSync(file, JSON.stringify(marker) + '\n');
  console.log(`Resolved feedback [${id}].`);
}

module.exports = function feedback(args) {
  const { flags, positional } = parseArgs(args);
  const { dir, global: isGlobal } = resolveFeedbackDir();

  if (flags.resolve !== undefined) {
    resolveFeedback(dir, flags.resolve);
    return;
  }

  if (flags.list) {
    listFeedback(dir, isGlobal);
    return;
  }

  const message = positional.join(' ').trim();
  if (!message) {
    console.error('Usage: pebbl feedback "[what went wrong]"   (--list to review, --resolve <id> to clear)');
    process.exit(1);
  }

  const entry = {
    id: shortId(message + new Date().toISOString()),
    timestamp: new Date().toISOString(),
    status: 'open',
    message,
    cwd: process.cwd(),
    branch: gitContext(),
    version,
  };

  const file = path.join(dir, FEEDBACK_FILE);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  if (isGlobal) {
    console.log(`pebble dropped — no project .pebbl/ here, saved to global ${file} [${entry.id}]`);
  } else {
    console.log(`pebble dropped — ${path.relative(process.cwd(), file)} [${entry.id}]`);
  }
};

module.exports.showRecentFeedback = showRecentFeedback;
module.exports.readFeedback = readFeedback;
module.exports.resolveFeedbackDir = resolveFeedbackDir;
