'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');
const { ensureProjectFiles } = require('./rubric');
const { displayEntry } = require('./log');

module.exports = function handoff(args) {
  const { flags, positional } = parseArgs(args);

  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);

  // Mode 1: --latest
  if (flags.latest) {
    const row = db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT 1').get();
    if (!row) {
      console.log('pebbl: no handoffs found');
      return;
    }
    displayHandoff(row, db);
    return;
  }

  // Mode 2: --list
  if (flags.list) {
    const rows = db.prepare(
      'SELECT id, timestamp, summary, topics, status FROM handoffs ORDER BY id DESC LIMIT 10'
    ).all();

    if (rows.length === 0) {
      console.log('pebbl: no handoffs found');
      return;
    }

    for (const row of rows) {
      const date = (row.timestamp || '').slice(0, 10);
      const tag = row.status === 'open' ? 'open' : 'closed';
      const topicStr = row.topics ? ` (${row.topics})` : '';
      console.log(`#${row.id} [${tag}]  ${date} — ${row.summary}${topicStr}`);
    }
    return;
  }

  // Mode 3: --close
  if (flags.close) {
    const row = db.prepare(
      "SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    ).get();

    if (!row) {
      console.error('pebbl: no open handoff to close');
      process.exit(1);
    }

    // A. Build promoted summary for foundation-tier log entry
    const parts = [`handoff #${row.id} closed: ${row.summary}`];
    if (row.done) parts.push(`done: ${row.done}`);
    if (row.todo) parts.push(`remaining: ${row.todo}`);
    if (row.blocked) parts.push(`blocked: ${row.blocked}`);
    const promotedMessage = parts.join('. ');

    // B. Insert foundation-tier log entry
    const ts = new Date().toISOString();
    const logResult = db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'agent', 'decision', 'foundation', ?, ?)
    `).run(ts, promotedMessage, row.topics || null);
    const promotedLogId = logResult.lastInsertRowid;

    // C. Close the handoff
    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ?, promoted_log_id = ? WHERE id = ?"
    ).run(ts, promotedLogId, row.id);

    // D. Demote session detail entries to fleeting (compaction-eligible)
    const entryIds = JSON.parse(row.session_entries || '[]');
    if (entryIds.length > 0) {
      const placeholders = entryIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
      ).run(...entryIds);
    }

    // E. Also write the promoted entry to manual-logs.md
    const mdComment = `<!-- cat:decision topic:${row.topics || ''} tier:foundation source:agent -->`;
    const md = `## ${ts} - ${promotedMessage}\n${mdComment}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'manual-logs.md'), md);

    // F. QMD update
    qmdUpdate(pebblDir);

    // G. Display result
    console.log(`Handoff #${row.id} closed. Foundation entry #${promotedLogId} created.`);
    if (entryIds.length > 0) {
      console.log(`${entryIds.length} session entries marked for compaction.`);
    }
    return;
  }

  // Mode 4: Create a new handoff (default)
  const summary = positional.join(' ').trim();
  if (!summary) {
    console.error('Usage: pebbl handoff "[summary]" --done "..." --todo "..."');
    process.exit(1);
  }

  const ts = new Date().toISOString();
  const source = flags.source || 'agent';
  const topics = flags.topic || null;
  const done = flags.done || null;
  const todo = flags.todo || null;
  const blocked = flags.blocked || null;

  // Auto-collect: find all log entries since the last handoff (or last 2 hours)
  const lastHandoff = db.prepare(
    "SELECT timestamp FROM handoffs ORDER BY id DESC LIMIT 1"
  ).get();
  const cutoff = lastHandoff
    ? lastHandoff.timestamp
    : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const sessionLogs = db.prepare("SELECT id FROM logs WHERE timestamp > ?").all(cutoff);
  const sessionEntries = sessionLogs.map(r => r.id);

  // Auto-collect commits too
  let sessionCommits = [];
  try {
    const { execSync } = require('child_process');
    // Find the project root (parent of .pebbl/)
    const projectRoot = path.dirname(pebblDir);
    const gitLog = execSync(`git log --after="${cutoff}" --format="%H"`, {
      cwd: projectRoot, encoding: 'utf8'
    }).trim();
    if (gitLog) sessionCommits = gitLog.split('\n').filter(Boolean);
  } catch {
    // no git or no commits
  }

  // Insert the handoff
  const result = db.prepare(`
    INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(ts, summary, done, todo, blocked, topics, source, JSON.stringify(sessionEntries), JSON.stringify(sessionCommits));

  // Display
  console.log(`\n── Handoff #${result.lastInsertRowid} created ──`);
  console.log(`Summary: ${summary}`);
  if (done) console.log(`Done: ${done}`);
  if (todo) console.log(`Todo: ${todo}`);
  if (blocked) console.log(`Blocked: ${blocked}`);
  if (topics) console.log(`Topics: ${topics}`);
  console.log(`Session: ${sessionEntries.length} log entries, ${sessionCommits.length} commits captured`);
  console.log('──');
};

function displayHandoff(row, db) {
  const date = (row.timestamp || '').slice(0, 10);
  const statusTag = row.status === 'open' ? '[OPEN]' : '[CLOSED]';

  console.log(`\n══ Handoff #${row.id} ${statusTag} — ${date} ══`);
  if (row.topics) console.log(`Topics: ${row.topics}`);
  console.log(`Source: ${row.source}`);
  console.log(`\nSummary: ${row.summary}`);

  if (row.done) {
    console.log('\nDone:');
    row.done.split(';').map(s => s.trim()).filter(Boolean).forEach(item => console.log(`  - ${item}`));
  }
  if (row.todo) {
    console.log('\nTodo:');
    row.todo.split(';').map(s => s.trim()).filter(Boolean).forEach(item => console.log(`  - ${item}`));
  }
  if (row.blocked) {
    console.log('\nBlocked:');
    row.blocked.split(';').map(s => s.trim()).filter(Boolean).forEach(item => console.log(`  - ${item}`));
  }

  // Show auto-collected session activity
  const entryIds = JSON.parse(row.session_entries || '[]');
  const commitHashes = JSON.parse(row.session_commits || '[]');

  if (entryIds.length > 0) {
    console.log(`\nSession entries (${entryIds.length}):`);
    const placeholders = entryIds.map(() => '?').join(',');
    const entries = db.prepare(`SELECT * FROM logs WHERE id IN (${placeholders})`).all(...entryIds);
    for (const e of entries) {
      console.log(`  ${displayEntry(e)}`);
    }
  }
  if (commitHashes.length > 0) {
    console.log(`\nSession commits: ${commitHashes.length}`);
    commitHashes.slice(0, 5).forEach(h => console.log(`  ${h.slice(0, 7)}`));
    if (commitHashes.length > 5) console.log(`  ... and ${commitHashes.length - 5} more`);
  }

  if (row.status === 'closed' && row.promoted_log_id) {
    console.log(`\nPromoted to log entry #${row.promoted_log_id}`);
  }
  console.log('══');
}

module.exports.displayHandoff = displayHandoff;
