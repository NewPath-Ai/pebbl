'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadConfig } = require('./rubric');
const { displayEntry } = require('./log');

module.exports = function context(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  const db = openDb(pebblDir);

  let sql = 'SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE 1=1';
  const params = [];

  if (flags.cat) {
    sql += ' AND category = ?';
    params.push(flags.cat);
  }
  if (flags.topic) {
    sql += " AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)";
    const p = `%,${flags.topic},%`;
    params.push(p, flags.topic, flags.topic, flags.topic);
  }

  sql += ' ORDER BY id DESC LIMIT 10';
  const rows = db.prepare(sql).all(...params);

  console.log('--- PROJECT MEMORY ---');
  if (rows.length === 0) {
    console.log('(no entries yet)');
  } else {
    for (const row of rows) {
      console.log(displayEntry(row));
    }
  }
  console.log('---');

  const config = loadConfig(pebblDir) || {};
  const threshold = (config.compaction && config.compaction.threshold) || 10;

  const compactable = db.prepare(`
    SELECT topics, COUNT(*) as cnt FROM logs
    WHERE tier IN ('detail','fleeting')
      AND topics IS NOT NULL AND topics != ''
    GROUP BY topics HAVING cnt >= ?
  `).all(threshold);

  for (const row of compactable) {
    const topicList = (row.topics || '').split(',').map(t => t.trim());
    for (const t of topicList) {
      const topicCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM logs
        WHERE tier IN ('detail','fleeting')
          AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)
      `).get(`%,${t},%`, t, t, t);
      if (topicCount && topicCount.cnt >= threshold) {
        console.log(`[pebbl] ${topicCount.cnt} entries on '${t}' ready for compaction. Run: pebbl compact --preview`);
      }
    }
  }
};
