'use strict';
const fs = require('fs');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, topicFilter } = require('./db');
const { loadConfig, ensureProjectFiles } = require('./rubric');
const { displayEntry } = require('./log');
const { isThinEntry } = require('./detect-thin');

function findRelatedCommits(cwd, message) {
  try {
    const { execSync } = require('child_process');
    const gitDir = require('path').join(cwd, '.git');
    if (!fs.existsSync(gitDir)) return [];

    const output = execSync('git log --format="%h %s" -50', { cwd, encoding: 'utf8' });
    const lines = output.trim().split('\n').filter(Boolean);

    const stopWords = new Set([
      'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'will',
      'would', 'could', 'should', 'which', 'their', 'about', 'into', 'over',
      'after', 'before', 'between', 'under', 'also', 'other', 'some', 'such',
      'only', 'then', 'than', 'like', 'just', 'much', 'more', 'most', 'very',
      'when', 'what', 'where', 'there', 'here', 'does',
    ]);

    const words = message.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    const uniqueWords = [...new Set(words)];
    if (uniqueWords.length === 0) return [];

    const scored = lines.map(line => {
      const spaceIdx = line.indexOf(' ');
      const hash = line.slice(0, spaceIdx);
      const msg = line.slice(spaceIdx + 1).toLowerCase();
      const score = uniqueWords.filter(w => msg.includes(w)).length;
      return { hash, message: line.slice(spaceIdx + 1), score };
    }).filter(c => c.score >= 2)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, 2);
  } catch {
    return [];
  }
}

module.exports = function context(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);

  let sql = 'SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE 1=1';
  const params = [];

  if (flags.cat) {
    sql += ' AND category = ?';
    params.push(flags.cat);
  }
  if (flags.topic) {
    const filter = topicFilter(flags.topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  sql += ` ORDER BY CASE tier WHEN 'signal' THEN 0 WHEN 'detail' THEN 1 WHEN 'fleeting' THEN 2 ELSE 3 END, id DESC LIMIT 10`;
  const rows = db.prepare(sql).all(...params);

  const cwd = process.cwd();

  console.log('--- PROJECT MEMORY ---');
  if (rows.length === 0) {
    console.log('(no entries yet)');
  } else {
    for (const row of rows) {
      console.log(displayEntry(row));

      const msg = row.message || '';
      if (isThinEntry(msg)) {
        const commits = findRelatedCommits(cwd, msg);
        for (const c of commits) {
          console.log(`  └─ git: ${c.hash} ${c.message}`);
        }
        if (commits.length > 0) {
          console.log('  ⚠ no explicit rationale found — commit shows implementation detail, not decision reasoning');
        } else {
          console.log('  ⚠ no explicit rationale found — consider correcting with: pebbl log "because..." --corrects ' + row.id);
        }
      }
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
      const filter = topicFilter(t);
      const topicCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM logs
        WHERE tier IN ('detail','fleeting')
          ${filter.clause}
      `).get(...filter.params);
      if (topicCount && topicCount.cnt >= threshold) {
        console.log(`[pebbl] ${topicCount.cnt} entries on '${t}' ready for compaction. Run: pebbl compact --preview`);
      }
    }
  }
};
