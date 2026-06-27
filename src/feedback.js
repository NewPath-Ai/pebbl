'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseArgs } = require('./args');
const { findPebblDir } = require('./find-pebbl');

const FEEDBACK_FILE = 'feedback.jsonl';
const { version } = require('../package.json');

// Resolve where feedback lands: an existing .pebbl/ if there is one, else
// create .pebbl/ in the current directory. Deliberately avoids the SQLite db —
// feedback often gets dropped because that layer is misbehaving.
function resolvePebblDir() {
  const existing = findPebblDir();
  if (existing) return existing;
  const dir = path.join(process.cwd(), '.pebbl');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

function listFeedback(pebblDir) {
  const file = path.join(pebblDir, FEEDBACK_FILE);
  if (!fs.existsSync(file)) {
    console.log('No feedback recorded yet.');
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) {
    console.log('No feedback recorded yet.');
    return;
  }
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const date = (e.timestamp || '').slice(0, 10);
    let out = `[${date}] ${e.message}`;
    if (e.branch) out += `\n  branch: ${e.branch}`;
    if (e.cwd) out += `\n  cwd: ${e.cwd}`;
    console.log(out);
  }
}

module.exports = function feedback(args) {
  const { flags, positional } = parseArgs(args);
  const pebblDir = resolvePebblDir();

  if (flags.list) {
    listFeedback(pebblDir);
    return;
  }

  const message = positional.join(' ').trim();
  if (!message) {
    console.error('Usage: pebbl feedback "[what went wrong]"   (--list to review)');
    process.exit(1);
  }

  const entry = {
    timestamp: new Date().toISOString(),
    message,
    cwd: process.cwd(),
    branch: gitContext(),
    version,
  };

  fs.appendFileSync(path.join(pebblDir, FEEDBACK_FILE), JSON.stringify(entry) + '\n');
  console.log(`pebble dropped — ${path.relative(process.cwd(), path.join(pebblDir, FEEDBACK_FILE))}`);
};
