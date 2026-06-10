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
    // Reconcile before reading so any file-only rows are visible.
    reconcileHandoffsMd(pebblDir, db);
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
    // Reconcile before reading so any file-only rows are visible.
    reconcileHandoffsMd(pebblDir, db);
    const rows = db.prepare(
      'SELECT id, timestamp, summary, topics, status FROM handoffs ORDER BY id DESC LIMIT 20'
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

    const ts = new Date().toISOString();

    // A. Mark the handoff closed. The handoffs table is the authority for
    // summary/done/todo/blocked — we no longer flatten those fields into a
    // single foundation log row (that produced unsearchable multi-KB blobs).
    db.prepare(
      "UPDATE handoffs SET status = 'closed', closed_at = ? WHERE id = ?"
    ).run(ts, row.id);

    // B. Demote session detail entries to fleeting (compaction-eligible).
    const entryIds = JSON.parse(row.session_entries || '[]');
    if (entryIds.length > 0) {
      const placeholders = entryIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE logs SET tier = 'fleeting' WHERE id IN (${placeholders}) AND tier = 'detail'`
      ).run(...entryIds);
    }

    // C. Re-materialize handoffs.md at item granularity so each done/todo/
    // blocked item is its own searchable block, then refresh the index.
    materializeHandoffsMd(pebblDir, db);
    qmdUpdate(pebblDir);

    // D. Display result
    console.log(`Handoff #${row.id} closed.`);
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

  // Warn on fields that will materialize as one unsearchable block. Each field
  // becomes ';'-split items on close — a long field with no separators stays a
  // wall of text that search can't localize within.
  checkFieldQuality(done, 'done');
  checkFieldQuality(todo, 'todo');
  checkFieldQuality(blocked, 'blocked');
  const docs = flags.docs
    ? JSON.stringify(flags.docs.split(',').map(s => s.trim()).filter(Boolean))
    : null;

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
    INSERT INTO handoffs (timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status, docs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(ts, summary, done, todo, blocked, topics, source, JSON.stringify(sessionEntries), JSON.stringify(sessionCommits), docs);

  // Re-materialize so the new (open) handoff is searchable immediately.
  materializeHandoffsMd(pebblDir, db);
  qmdUpdate(pebblDir);

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

// Split a handoff field into atomic items on ';'.
function splitItems(field) {
  if (!field) return [];
  return field.split(';').map(s => s.trim()).filter(Boolean);
}

// Warn (non-fatal) when a field is long but has no separators, so it would
// materialize as a single unsearchable block.
const FIELD_BLOCK_WARN_CHARS = 280;
function checkFieldQuality(field, name) {
  if (field && field.length > FIELD_BLOCK_WARN_CHARS && splitItems(field).length < 2) {
    console.error(
      `pebbl: --${name} is ${field.length} chars with no ';' separators — it will ` +
      `materialize as one big block search can't localize. Split it into ';'-separated items.`
    );
  }
}

// Parse handoffs.md and reconcile the DB against it before materializing.
// Any handoff ID that appears in the file as a summary block but is absent from
// the DB is inserted so a subsequent materialize doesn't silently drop it.
// Any existing row whose status in the file is 'closed' but is 'open' in the DB
// is also updated — the file is the human-visible record and its status wins when
// the two disagree (this handles the case where an agent manually wrote a close).
//
// The function is called at the top of materializeHandoffsMd so all write paths
// (create, close, --close) automatically heal any prior drift.
function reconcileHandoffsMd(pebblDir, db) {
  const mdPath = require('path').join(pebblDir, 'handoffs.md');
  if (!fs.existsSync(mdPath)) return;

  const text = fs.readFileSync(mdPath, 'utf8');
  const lines = text.split('\n');

  // Collect per-ID: { id, timestamp, status, summary, done:[], todo:[], blocked:[], topics }
  // We only need to import the summary row (one per ID). We accumulate done/todo/blocked items.
  const byId = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for comment tags: <!-- handoff:N field:F topic:T status:S -->
    const tagMatch = line.match(/<!--\s*handoff:(\d+)\s+field:(\w+)\s+topic:(.*?)\s+status:(open|closed)\s*-->/);
    if (!tagMatch) continue;

    const id = parseInt(tagMatch[1], 10);
    const field = tagMatch[2];
    const topics = tagMatch[3].trim();
    const status = tagMatch[4];

    if (!byId.has(id)) {
      byId.set(id, { id, timestamp: null, status, summary: null, done: [], todo: [], blocked: [], topics });
    }
    const entry = byId.get(id);
    // Last-seen status wins (consistent across all blocks for a given ID in practice)
    entry.status = status;
    if (topics) entry.topics = topics;

    // The heading line is the line just above the comment
    const heading = i > 0 ? lines[i - 1] : '';
    // ## <timestamp> - handoff #N: <summary>
    // ## <timestamp> - handoff #N done: <item>
    // ## <timestamp> - handoff #N todo: <item>
    // ## <timestamp> - handoff #N blocked: <item>
    const headMatch = heading.match(/^##\s+(\S+)\s+-\s+(.+)$/);
    if (!headMatch) continue;

    const ts = headMatch[1];
    const body = headMatch[2];

    if (field === 'summary') {
      entry.timestamp = ts;
      // "handoff #N: <summary text>"
      const sumMatch = body.match(/^handoff #\d+:\s+(.+)$/);
      if (sumMatch) entry.summary = sumMatch[1];
    } else if (field === 'done') {
      const itemMatch = body.match(/^handoff #\d+ done:\s+(.+)$/);
      if (itemMatch) entry.done.push(itemMatch[1]);
    } else if (field === 'todo') {
      const itemMatch = body.match(/^handoff #\d+ todo:\s+(.+)$/);
      if (itemMatch) entry.todo.push(itemMatch[1]);
    } else if (field === 'blocked') {
      const itemMatch = body.match(/^handoff #\d+ blocked:\s+(.+)$/);
      if (itemMatch) entry.blocked.push(itemMatch[1]);
    }
  }

  if (byId.size === 0) return;

  // Build a set of IDs already in the DB
  const dbIds = new Set(
    db.prepare('SELECT id FROM handoffs').all().map(r => r.id)
  );

  const insertStmt = db.prepare(`
    INSERT INTO handoffs (id, timestamp, summary, done, todo, blocked, topics, source, session_entries, session_commits, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'agent', '[]', '[]', ?)
  `);

  const closeStmt = db.prepare(
    "UPDATE handoffs SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'"
  );

  for (const [id, entry] of byId) {
    if (!dbIds.has(id)) {
      // Missing from DB entirely — insert it. Skip rows with no summary (parse failure).
      if (!entry.summary || !entry.timestamp) continue;
      const done = entry.done.length > 0 ? entry.done.join('; ') : null;
      const todo = entry.todo.length > 0 ? entry.todo.join('; ') : null;
      const blocked = entry.blocked.length > 0 ? entry.blocked.join('; ') : null;
      insertStmt.run(id, entry.timestamp, entry.summary, done, todo, blocked, entry.topics || null, entry.status);
    } else if (entry.status === 'closed') {
      // In DB but file says closed — sync the status
      closeStmt.run(entry.timestamp || new Date().toISOString(), id);
    }
  }
}

// Regenerate handoffs.md from the handoffs table. Both open and closed handoffs
// are included so search finds in-progress work too (open ones carry a
// status:open tag so callers can render them differently). Each handoff becomes
// a summary block plus one block per ';'-split done/todo/blocked item. Overwrites
// the file every time (idempotent) — the table is the authority.
//
// Calls reconcileHandoffsMd first so any rows that were written directly into the
// file (bypassing the DB) are imported before we overwrite the file.
function materializeHandoffsMd(pebblDir, db) {
  reconcileHandoffsMd(pebblDir, db);

  const rows = db.prepare(
    "SELECT * FROM handoffs ORDER BY id ASC"
  ).all();

  const out = ['# Handoffs', ''];
  for (const row of rows) {
    const ts = row.closed_at || row.timestamp;
    const topic = row.topics || '';
    const status = row.status || 'open';
    const blocks = [['summary', `handoff #${row.id}: ${row.summary}`]];
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        blocks.push([field, `handoff #${row.id} ${field}: ${item}`]);
      }
    }
    for (const [field, message] of blocks) {
      out.push(`## ${ts} - ${message}`);
      out.push(`<!-- handoff:${row.id} field:${field} topic:${topic} status:${status} -->`);
      out.push('');
    }
  }

  fs.writeFileSync(path.join(pebblDir, 'handoffs.md'), out.join('\n'));
}

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

  // Show referenced docs sorted by freshness
  if (row.docs) {
    const docList = JSON.parse(row.docs || '[]');
    if (docList.length > 0) {
      const withAge = docList.map(d => {
        try {
          const stat = fs.statSync(d);
          return { path: d, mtime: stat.mtime };
        } catch {
          return { path: d, mtime: null };
        }
      }).sort((a, b) => {
        if (!a.mtime && !b.mtime) return 0;
        if (!a.mtime) return 1;
        if (!b.mtime) return -1;
        return b.mtime - a.mtime;
      });

      console.log('\nDocs:');
      for (const d of withAge) {
        const age = d.mtime
          ? `updated ${d.mtime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
          : 'file not found';
        console.log(`  ${d.path}  (${age})`);
      }
    }
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
module.exports.splitItems = splitItems;
module.exports.checkFieldQuality = checkFieldQuality;
module.exports.materializeHandoffsMd = materializeHandoffsMd;
module.exports.reconcileHandoffsMd = reconcileHandoffsMd;
