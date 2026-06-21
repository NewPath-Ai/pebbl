'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { ensureProjectFiles } = require('./rubric');
const { displayEntry } = require('./log');
const { mirrorHandoffs, stripHandoffPrefix } = require('./mirror');
// Projection-boundary secret mask. handoffs.md is committed and the promote
// gate scans it; the DB keeps the original summary/item text untouched.
const { redact } = require('./privacy-scan');

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

    // Other machines' handoffs from .pebbl/mirror/<machine>/ — one line per
    // handoff (the summary block), tagged with the machine. Empty until the
    // sync jobs create mirrors, so output is unchanged before then.
    const mirrored = mirrorHandoffs(pebblDir)
      .filter(h => h.field === 'summary')
      .slice(0, 10);

    if (rows.length === 0 && mirrored.length === 0) {
      console.log('pebbl: no handoffs found');
      return;
    }

    for (const row of rows) {
      const date = (row.timestamp || '').slice(0, 10);
      const tag = row.status === 'open' ? 'open' : 'closed';
      const topicStr = row.topics ? ` (${row.topics})` : '';
      console.log(`#${row.id} [${tag}]  ${date} — ${row.summary}${topicStr}`);
    }
    for (const h of mirrored) {
      const topicStr = h.topics ? ` (${h.topics})` : '';
      console.log(`[${h.machine}] #${h.handoffId} [${h.status}]  ${h.date} — ${stripHandoffPrefix(h.message)}${topicStr}`);
    }
    return;
  }

  // Mode 2b: --open / --list-open — every open handoff, no LIMIT. Mirrors the
  // --list block but filters status='open' so stacked opens are drainable.
  if (flags.open || flags['list-open']) {
    const rows = db.prepare(
      "SELECT id, timestamp, summary, topics, status FROM handoffs WHERE status = 'open' ORDER BY id DESC"
    ).all();

    const mirrored = mirrorHandoffs(pebblDir)
      .filter(h => h.field === 'summary' && h.status === 'open');

    if (rows.length === 0 && mirrored.length === 0) {
      console.log('pebbl: no open handoffs');
      return;
    }

    for (const row of rows) {
      const date = (row.timestamp || '').slice(0, 10);
      const topicStr = row.topics ? ` (${row.topics})` : '';
      console.log(`#${row.id} [open]  ${date} — ${row.summary}${topicStr}`);
    }
    for (const h of mirrored) {
      const topicStr = h.topics ? ` (${h.topics})` : '';
      console.log(`[${h.machine}] #${h.handoffId} [open]  ${h.date} — ${stripHandoffPrefix(h.message)}${topicStr}`);
    }
    return;
  }

  // Mode 3: --close [id]. Bare `--close` closes the newest open (back-compat);
  // `--close <id>` closes a specific open out of order. `--close` is a boolean
  // flag, so the id arrives as the lone positional.
  if (flags.close) {
    const idArg = positional[0];
    let row;
    if (idArg !== undefined) {
      if (!/^\d+$/.test(idArg)) {
        console.error(`pebbl: handoff --close expects a numeric id, got "${idArg}"`);
        process.exit(1);
      }
      row = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(parseInt(idArg, 10));
      if (!row) {
        console.error(`pebbl: no handoff #${idArg}`);
        process.exit(1);
      }
      if (row.status !== 'open') {
        console.error(`pebbl: handoff #${idArg} is not open (status: ${row.status})`);
        process.exit(1);
      }
    } else {
      row = db.prepare(
        "SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1"
      ).get();
      if (!row) {
        console.error('pebbl: no open handoff to close');
        process.exit(1);
      }
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
    // blocked item is its own searchable block.
    materializeHandoffsMd(pebblDir, db);

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

  // Display
  console.log(`\n── Handoff #${result.lastInsertRowid} created ──`);
  console.log(`Summary: ${summary}`);
  if (done) console.log(`Done: ${done}`);
  if (todo) console.log(`Todo: ${todo}`);
  if (blocked) console.log(`Blocked: ${blocked}`);
  if (topics) console.log(`Topics: ${topics}`);
  console.log(`Session: ${sessionEntries.length} log entries, ${sessionCommits.length} commits captured`);
  console.log('──');
  // Close-lifecycle reminder: creating a handoff never closes priors, so opens
  // stack silently. Nudge the author to drain finished work out of order.
  console.log(
    `  → this stays open until closed: pebbl handoff --close ${result.lastInsertRowid} ` +
    `(see all open: pebbl handoff --list-open)`
  );
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

// Regenerate handoffs.md from the handoffs table. Both open and closed handoffs
// are included so search finds in-progress work too (open ones carry a
// status:open tag so callers can render them differently). Each handoff becomes
// a summary block plus one block per ';'-split done/todo/blocked item. Overwrites
// the file every time (idempotent) — the table is the authority.
function materializeHandoffsMd(pebblDir, db) {
  const rows = db.prepare(
    "SELECT * FROM handoffs ORDER BY id ASC"
  ).all();

  const out = ['# Handoffs', ''];
  for (const row of rows) {
    const ts = row.closed_at || row.timestamp;
    const topic = row.topics || '';
    const status = row.status || 'open';
    const blocks = [['summary', `handoff #${row.id}: ${redact(row.summary)}`]];
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        blocks.push([field, `handoff #${row.id} ${field}: ${redact(item)}`]);
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

  console.log('══');
}

module.exports.displayHandoff = displayHandoff;
module.exports.splitItems = splitItems;
module.exports.checkFieldQuality = checkFieldQuality;
module.exports.materializeHandoffsMd = materializeHandoffsMd;
