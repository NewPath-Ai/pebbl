'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, topicFilter } = require('./db');
const { qmdAvailable, qmdQuery } = require('./qmd');
const { displayEntry } = require('./log');
const { ensureProjectFiles } = require('./rubric');
const { splitItems } = require('./handoff');

// Normalize a message for near-duplicate comparison.
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Strip the deterministic "handoff #N field: " prefix from a materialized item.
function stripHandoffPrefix(message) {
  const m = message.match(/^handoff #\d+ (?:summary|done|todo|blocked): (.+)$/i);
  return m ? m[1] : message.replace(/^handoff #\d+: /i, '');
}

// Render a structured result object to a display line.
function formatResult(r) {
  if (r.isHandoff) {
    const open = r.status === 'open' ? ' · OPEN' : '';
    let out = `[handoff #${r.handoffId}${open} · ${r.field}] ${r.date} — ${stripHandoffPrefix(r.message)}`;
    if (r.topics) out += `\n  topics: ${r.topics}`;
    return out;
  }
  let out = `[${r.tier}|${r.cat}] ${r.date} — ${r.message}`;
  if (r.topics) out += `\n  topics: ${r.topics}`;
  return out;
}

// Drop handoff items that near-duplicate a log entry already in the results —
// the atomic log entry is the authority, the handoff item is a recap of it.
function dedupeResults(results) {
  const logKeys = new Set(
    results.filter(r => !r.isHandoff && r.message).map(r => normalize(r.message))
  );
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = normalize(stripHandoffPrefix(r.message || ''));
    if (r.isHandoff) {
      if (logKeys.has(key)) continue;       // suppressed by an authoritative log entry
      if (seen.has('h:' + key)) continue;    // collapse repeats across handoffs
      seen.add('h:' + key);
    }
    out.push(r);
  }
  return out;
}

function parseQmdResults(raw, cat, topic) {
  const blocks = raw.split('\nqmd://');
  const results = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = (i === 0 ? '' : '\n') + blocks[i];

    const handoffMatch = block.match(/<!--\s*handoff:(\d+)\s+field:(\S+)\s+topic:(\S*)(?:\s+status:(\S+))?\s*-->/);
    const logMatch = block.match(/<!--\s*cat:(\S+)\s+topic:(\S*)\s+tier:(\S+)\s+source:(\S+)\s*-->/);

    if (handoffMatch) {
      const entryTopics = handoffMatch[3];
      if (topic) {
        const topicParts = (entryTopics || '').split(',').map(t => t.trim());
        if (!topicParts.includes(topic)) continue;
      }
      const dateMatch = block.match(/##\s+(\S+)\s+-\s+(.+)/);
      results.push({
        isHandoff: true,
        handoffId: handoffMatch[1],
        field: handoffMatch[2],
        topics: entryTopics,
        status: handoffMatch[4] || 'closed',
        date: dateMatch ? dateMatch[1].slice(0, 10) : 'unknown',
        message: dateMatch ? dateMatch[2] : '(unknown)',
      });
    } else if (logMatch) {
      const entryCat = logMatch[1];
      const entryTopics = logMatch[2];
      const entryTier = logMatch[3];

      if (cat && entryCat !== cat) continue;
      if (topic) {
        const topicParts = (entryTopics || '').split(',').map(t => t.trim());
        if (!topicParts.includes(topic)) continue;
      }
      const dateMatch = block.match(/##\s+(\S+)\s+-\s+(.+)/);
      results.push({
        isHandoff: false,
        tier: entryTier,
        cat: entryCat,
        topics: entryTopics,
        date: dateMatch ? dateMatch[1].slice(0, 10) : 'unknown',
        message: dateMatch ? dateMatch[2] : (block.split('\n')[1] || '(unknown)'),
      });
    } else {
      const trimmed = block.trim();
      if (trimmed) results.push({ raw: trimmed, message: '' });
    }
  }

  return results;
}

// SQLite fallback: scan closed-handoff fields for the query and emit matching items.
function searchHandoffsSqlite(db, query, topic) {
  const like = `%${query}%`;
  const rows = db.prepare(`
    SELECT id, summary, done, todo, blocked, topics, status, closed_at, timestamp
    FROM handoffs
    WHERE summary LIKE ? OR done LIKE ? OR todo LIKE ? OR blocked LIKE ?
  `).all(like, like, like, like);

  const q = query.toLowerCase();
  const results = [];
  for (const row of rows) {
    if (topic) {
      const topicParts = (row.topics || '').split(',').map(t => t.trim());
      if (!topicParts.includes(topic)) continue;
    }
    const date = (row.closed_at || row.timestamp || '').slice(0, 10);
    const status = row.status || 'open';
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        if (item.toLowerCase().includes(q)) {
          results.push({
            isHandoff: true, handoffId: String(row.id), field, status,
            topics: row.topics, date, message: item,
          });
        }
      }
    }
    if ((row.summary || '').toLowerCase().includes(q)) {
      results.push({
        isHandoff: true, handoffId: String(row.id), field: 'summary', status,
        topics: row.topics, date, message: row.summary,
      });
    }
  }
  return results;
}

function searchSqlite(pebblDir, query, cat, topic) {
  const db = openDb(pebblDir);

  let sql = "SELECT timestamp, source, category, tier, message, topics FROM logs WHERE tier != 'archived' AND message LIKE ?";
  const params = [`%${query}%`];

  if (cat) {
    sql += ' AND category = ?';
    params.push(cat);
  }
  if (topic) {
    const filter = topicFilter(topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 20';
  const rows = db.prepare(sql).all(...params);

  const logResults = rows.map(row => ({
    isHandoff: false,
    tier: row.tier,
    cat: row.category,
    topics: row.topics,
    date: (row.timestamp || '').slice(0, 10),
    message: row.message,
  }));

  const handoffResults = searchHandoffsSqlite(db, query, topic);
  const results = dedupeResults([...logResults, ...handoffResults]);

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  for (const r of results) {
    console.log(r.raw || formatResult(r));
    console.log();
  }
  console.log('---\n');
}

module.exports = function search(args) {
  const { flags, positional } = parseArgs(args);
  const query = positional.join(' ').trim();

  if (!query) {
    console.error('Usage: pebbl search "[query]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);

  if (qmdAvailable()) {
    const raw = qmdQuery(pebblDir, query);

    if (!raw.trim()) {
      console.log('No results found.');
      return;
    }

    const results = dedupeResults(parseQmdResults(raw, flags.cat, flags.topic));

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`\n--- SEARCH: ${query} ---`);
    for (const r of results) {
      console.log(r.raw || formatResult(r));
      console.log();
    }
    console.log('---\n');
  } else {
    searchSqlite(pebblDir, query, flags.cat, flags.topic);
  }
};

module.exports._internal = { parseQmdResults, dedupeResults, formatResult, stripHandoffPrefix, normalize, searchHandoffsSqlite };
