'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdAvailable, qmdQuery } = require('./qmd');
const { displayEntry } = require('./log');

function parseQmdResults(raw, cat, topic) {
  const blocks = raw.split('\nqmd://');
  const results = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = (i === 0 ? '' : '\n') + blocks[i];
    const commentMatch = block.match(/<!--\s*cat:(\S+)\s+topic:(\S*)\s+tier:(\S+)\s+source:(\S+)\s*-->/);

    if (commentMatch) {
      const entryCat = commentMatch[1];
      const entryTopics = commentMatch[2];
      const entryTier = commentMatch[3];

      if (cat && entryCat !== cat) continue;
      if (topic) {
        const topicParts = (entryTopics || '').split(',').map(t => t.trim());
        if (!topicParts.includes(topic)) continue;
      }

      const dateMatch = block.match(/##\s+(\S+)\s+-\s+(.+)/);
      const date = dateMatch ? dateMatch[1].slice(0, 10) : 'unknown';
      const message = dateMatch ? dateMatch[2] : block.split('\n')[1] || '(unknown)';

      let out = `[${entryTier}|${entryCat}] ${date} — ${message}`;
      if (entryTopics) out += `\n  topics: ${entryTopics}`;

      results.push(out);
    } else {
      results.push(block.trim());
    }
  }

  return results;
}

function searchSqlite(pebblDir, query, cat, topic) {
  const db = openDb(pebblDir);

  let sql = 'SELECT timestamp, source, category, tier, message, topics FROM logs WHERE message LIKE ?';
  const params = [`%${query}%`];

  if (cat) {
    sql += ' AND category = ?';
    params.push(cat);
  }
  if (topic) {
    sql += " AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)";
    const pat = `%,${topic},%`;
    params.push(pat, topic, topic, topic);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 20';
  const rows = db.prepare(sql).all(...params);

  if (rows.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  for (const row of rows) {
    console.log(displayEntry(row));
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

  if (qmdAvailable()) {
    const raw = qmdQuery(pebblDir, query);

    if (!raw.trim()) {
      console.log('No results found.');
      return;
    }

    const results = parseQmdResults(raw, flags.cat, flags.topic);

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`\n--- SEARCH: ${query} ---`);
    for (const r of results) {
      console.log(r);
      console.log();
    }
    console.log('---\n');
  } else {
    searchSqlite(pebblDir, query, flags.cat, flags.topic);
  }
};
