'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { ensureProjectFiles } = require('./rubric');
const { readPosture } = require('./posture');

const VALID_STATUSES = ['draft', 'approved', 'in_progress', 'closed'];

function createIntent(db, pebblDir, goal, opts) {
  const ts = new Date().toISOString();
  const posture = readPosture(pebblDir);
  const result = db.prepare(`
    INSERT INTO intents (timestamp, topic, status, goal, constraints, posture_snapshot, qa_pairs, spec, source)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, NULL, ?)
  `).run(
    ts,
    opts.topic || null,
    goal,
    opts.constraints || null,
    posture ? JSON.stringify(posture) : null,
    '[]',
    opts.source || 'human'
  );
  return result.lastInsertRowid;
}

function showIntent(intent) {
  const status = intent.status.toUpperCase();
  console.log(`\n== Intent #${intent.id} [${status}] ==`);
  console.log(`Goal: ${intent.goal}`);
  if (intent.topic) console.log(`Topic: ${intent.topic}`);
  if (intent.constraints) console.log(`Constraints: ${intent.constraints}`);

  const qaPairs = JSON.parse(intent.qa_pairs || '[]');
  if (qaPairs.length > 0) {
    console.log('\nQ&A:');
    for (const pair of qaPairs) {
      console.log(`  Q: ${pair.q}`);
      console.log(`  A: ${pair.a}`);
    }
  }

  if (intent.spec) {
    console.log(`\nSpec:\n${intent.spec}`);
  }

  if (intent.posture_snapshot) {
    const posture = JSON.parse(intent.posture_snapshot);
    const parts = [];
    if (posture.maturity) parts.push(posture.maturity);
    if (posture.security) parts.push(`security:${posture.security}`);
    if (parts.length > 0) console.log(`\nPosture at creation: ${parts.join(', ')}`);
  }

  if (intent.linked_handoff_id) {
    console.log(`Linked handoff: #${intent.linked_handoff_id}`);
  }
  console.log(`Created: ${intent.timestamp.slice(0, 10)}`);
  console.log('==');
}

function appendQaPairs(db, id, qaString) {
  const intent = db.prepare('SELECT qa_pairs FROM intents WHERE id = ?').get(id);
  if (!intent) {
    console.error(`pebbl: intent #${id} not found`);
    process.exit(1);
  }
  const existing = JSON.parse(intent.qa_pairs || '[]');

  const parts = qaString.split(/;\s*(?=Q:)/i);
  for (const part of parts) {
    const match = part.match(/^Q:\s*(.+?);\s*A:\s*(.+)$/is);
    if (match) {
      existing.push({ q: match[1].trim(), a: match[2].trim() });
    } else {
      const simpleMatch = part.match(/^Q:\s*(.+)$/i);
      if (simpleMatch) {
        existing.push({ q: simpleMatch[1].trim(), a: '' });
      }
    }
  }

  db.prepare('UPDATE intents SET qa_pairs = ? WHERE id = ?').run(JSON.stringify(existing), id);
  console.log(`Intent #${id}: ${existing.length} Q&A pairs`);
}

module.exports = function intent(args) {
  const { flags, positional } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);

  const subcommand = positional[0];

  if (flags.current) {
    const row = db.prepare(
      "SELECT * FROM intents WHERE status != 'closed' ORDER BY id DESC LIMIT 1"
    ).get();
    if (!row) {
      console.log('pebbl: no open intent');
      return;
    }
    showIntent(row);
    return;
  }

  if (flags.list || subcommand === 'list') {
    const rows = db.prepare(
      "SELECT id, timestamp, topic, status, goal FROM intents WHERE status != 'closed' ORDER BY id DESC LIMIT 10"
    ).all();
    if (rows.length === 0) {
      console.log('pebbl: no open intents');
      return;
    }
    for (const row of rows) {
      const date = (row.timestamp || '').slice(0, 10);
      const topicStr = row.topic ? ` (${row.topic})` : '';
      const trunc = row.goal.length > 70 ? row.goal.slice(0, 69) + '...' : row.goal;
      console.log(`#${row.id} [${row.status}] ${date} ${trunc}${topicStr}`);
    }
    return;
  }

  if (subcommand === 'create') {
    const goal = positional.slice(1).join(' ').trim();
    if (!goal) {
      console.error('Usage: pebbl intent create "goal description" [--topic X]');
      process.exit(1);
    }
    const id = createIntent(db, pebblDir, goal, {
      topic: flags.topic || null,
      constraints: flags.constraints || null,
      source: flags.source || 'human',
    });
    console.log(`Intent #${id} created (draft)`);
    return;
  }

  if (subcommand === 'show') {
    const id = parseInt(positional[1], 10);
    if (!id) {
      console.error('Usage: pebbl intent show <id>');
      process.exit(1);
    }
    const row = db.prepare('SELECT * FROM intents WHERE id = ?').get(id);
    if (!row) {
      console.error(`pebbl: intent #${id} not found`);
      process.exit(1);
    }
    showIntent(row);
    return;
  }

  if (subcommand === 'update') {
    const id = parseInt(positional[1], 10);
    if (!id) {
      console.error('Usage: pebbl intent update <id> --qa "..." / --spec "..." / --constraints "..."');
      process.exit(1);
    }
    const row = db.prepare('SELECT * FROM intents WHERE id = ?').get(id);
    if (!row) {
      console.error(`pebbl: intent #${id} not found`);
      process.exit(1);
    }

    if (flags.qa) {
      appendQaPairs(db, id, flags.qa);
    }
    if (flags.spec) {
      db.prepare('UPDATE intents SET spec = ? WHERE id = ?').run(flags.spec, id);
      console.log(`Intent #${id}: spec updated`);
    }
    if (flags.constraints) {
      const existing = row.constraints ? row.constraints + '; ' : '';
      db.prepare('UPDATE intents SET constraints = ? WHERE id = ?').run(existing + flags.constraints, id);
      console.log(`Intent #${id}: constraints updated`);
    }
    return;
  }

  if (subcommand === 'approve' || flags.approve) {
    const id = parseInt(positional[flags.approve ? 0 : 1], 10);
    if (!id) {
      console.error('Usage: pebbl intent approve <id>');
      process.exit(1);
    }
    db.prepare("UPDATE intents SET status = 'approved' WHERE id = ?").run(id);
    console.log(`Intent #${id} approved`);
    return;
  }

  if (subcommand === 'close') {
    const id = parseInt(positional[1], 10);
    if (!id) {
      console.error('Usage: pebbl intent close <id>');
      process.exit(1);
    }
    db.prepare("UPDATE intents SET status = 'closed' WHERE id = ?").run(id);
    console.log(`Intent #${id} closed`);
    return;
  }

  if (subcommand === 'link') {
    const id = parseInt(positional[1], 10);
    const handoffId = flags.relates ? parseInt(flags.relates, 10) : null;
    if (!id || !handoffId) {
      console.error('Usage: pebbl intent link <id> --relates <handoff-id>');
      process.exit(1);
    }
    db.prepare('UPDATE intents SET linked_handoff_id = ? WHERE id = ?').run(handoffId, id);
    console.log(`Intent #${id} linked to handoff #${handoffId}`);
    return;
  }

  console.error('Usage: pebbl intent <create|show|update|approve|close|list|link> [args]');
  console.error('       pebbl intent --current');
  process.exit(1);
};

module.exports.createIntent = createIntent;
module.exports.showIntent = showIntent;
module.exports.appendQaPairs = appendQaPairs;
