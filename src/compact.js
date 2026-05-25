'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadConfig, ensureProjectFiles } = require('./rubric');
const { qmdUpdate } = require('./qmd');

function buildGroups(db, threshold, componentThreshold) {
  const rows = db.prepare(`
    SELECT * FROM logs
    WHERE tier IN ('component', 'detail', 'fleeting')
    ORDER BY timestamp
  `).all();

  const groups = new Map();
  const ambiguous = [];
  const fleeting = [];

  for (const row of rows) {
    if (row.tier === 'fleeting') {
      fleeting.push(row);
      continue;
    }

    if (row.category === 'uncategorized') {
      ambiguous.push(row);
      continue;
    }

    const primaryTopic = (row.topics || 'general').split(',')[0].trim();
    const month = (row.timestamp || '').slice(0, 7);
    const key = `${row.category}/${primaryTopic}/${month}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const qualified = new Map();
  for (const [key, entries] of groups) {
    const componentCount = entries.filter(e => e.tier === 'component').length;
    const isComponentGroup = componentCount > entries.length / 2;
    const effectiveThreshold = isComponentGroup ? componentThreshold : threshold;

    if (entries.length >= effectiveThreshold) {
      qualified.set(key, entries);
    }
  }

  return { groups: qualified, ambiguous, fleeting };
}

function generateRollupMessage(entries) {
  const category = entries[0].category;
  const topic = (entries[0].topics || 'general').split(',')[0].trim();
  const month = (entries[0].timestamp || '').slice(0, 7);
  const messages = entries.map(e => e.message.replace(/^\[rollup\]\s*/i, ''));
  return `[rollup] ${category} notes on ${topic} (${month}): ${messages.join('; ')}.`;
}

function archiveEntries(pebblDir, entries, archiveTs) {
  const archiveDir = path.join(pebblDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  const month = archiveTs.slice(0, 7);
  const archiveFile = path.join(archiveDir, `${month}.txt`);

  let content = `=== Archived ${archiveTs} ===\n`;
  for (const e of entries) {
    content += `[id:${e.id}] [${e.tier}|${e.category}] topics:${e.topics || ''} — ${e.message}\n`;
  }
  content += '---\n';

  fs.appendFileSync(archiveFile, content);
}

function regenerateMarkdown(pebblDir) {
  const db = openDb(pebblDir);
  const rows = db.prepare(`
    SELECT timestamp, source, category, tier, message, topics
    FROM logs ORDER BY timestamp ASC
  `).all();

  let md = '# Manual Logs\n\n';
  for (const row of rows) {
    const topicStr = row.topics || '';
    md += `## ${row.timestamp} - ${row.message}\n`;
    md += `<!-- cat:${row.category} topic:${topicStr} tier:${row.tier} source:${row.source} -->\n\n`;
  }

  const manualLogsPath = path.join(pebblDir, 'manual-logs.md');
  fs.writeFileSync(manualLogsPath, md);
}

function parseResolve(raw) {
  if (!raw) return new Map();
  const map = new Map();
  const VALID_ACTIONS = ['foundation', 'rollup', 'skip'];

  for (const item of raw.split(',')) {
    const parts = item.split(':');
    const id = parseInt(parts[0], 10);
    const action = parts[1];

    if (!VALID_ACTIONS.includes(action)) {
      console.error(`Invalid resolve action "${action}" for ID ${id}. Valid: foundation, rollup, skip`);
      process.exit(1);
    }

    if (map.has(id)) {
      console.error(`Duplicate resolve for ID ${id}`);
      process.exit(1);
    }

    map.set(id, action);
  }
  return map;
}

module.exports = function compact(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);
  const config = loadConfig(pebblDir) || {};
  const threshold = (config.compaction && config.compaction.threshold) || 10;
  const componentThreshold = (config.compaction && config.compaction.component_threshold) || 15;

  if (flags.preview) {
    return previewMode(db, threshold, componentThreshold);
  }

  if (flags.execute) {
    return executeMode(db, pebblDir, config, flags.resolve);
  }

  console.error('Usage: pebbl compact --preview | pebbl compact --execute [--resolve id:action,...]');
  process.exit(1);
};

module.exports.buildGroups = buildGroups;
module.exports.archiveEntries = archiveEntries;
module.exports.regenerateMarkdown = regenerateMarkdown;
module.exports.generateRollupMessage = generateRollupMessage;

function previewMode(db, threshold, componentThreshold) {
  const { groups, ambiguous, fleeting } = buildGroups(db, threshold, componentThreshold);

  if (groups.size === 0 && ambiguous.length === 0 && fleeting.length === 0) {
    console.log('No entries ready for compaction.');
    return;
  }

  for (const [key, entries] of groups) {
    const [, topic, month] = key.split('/');
    const componentCount = entries.filter(e => e.tier === 'component').length;
    const isComponentGroup = componentCount > entries.length / 2;
    const label = isComponentGroup
      ? `[component / ${topic} / ${month} — ${entries.length} entries] (consolidation)`
      : `[detail / ${topic} / ${month} — ${entries.length} entries]`;
    console.log(label);
    for (const e of entries) {
      console.log(`  [id:${e.id}] ${e.message}`);
    }
    console.log(`  Proposed rollup: "${generateRollupMessage(entries)}"\n`);
  }

  if (ambiguous.length > 0) {
    console.log(`AMBIGUOUS — ${ambiguous.length} entries (no rubric match, need judgment):`);
    for (const e of ambiguous) {
      console.log(`  [id:${e.id}] "${e.message}"  → foundation / rollup / skip`);
    }
    console.log();
  }

  if (fleeting.length > 0) {
    console.log(`FLEETING — ${fleeting.length} entries (will be deleted on execute)\n`);
  }

  console.log('Run: pebbl compact --execute');
  if (ambiguous.length > 0) {
    const resolveIds = ambiguous.map(e => `${e.id}:foundation`).join(',');
    console.log(`Resolve ambiguous: pebbl compact --execute --resolve ${resolveIds}`);
  }
}

function executeMode(db, pebblDir, config, resolveRaw) {
  const resolveMap = parseResolve(resolveRaw);
  const threshold = (config.compaction && config.compaction.threshold) || 10;
  const componentThreshold = (config.compaction && config.compaction.component_threshold) || 15;
  const retentionDays = (config.compaction && config.compaction.fleeting_retention) || 30;

  // Validate resolve IDs exist
  for (const [id] of resolveMap) {
    const row = db.prepare('SELECT id, category FROM logs WHERE id = ?').get(id);
    if (!row) {
      console.warn(`Warning: ID ${id} not found in database — skipping.`);
      resolveMap.delete(id);
      continue;
    }
    if (row.category !== 'uncategorized') {
      console.warn(`Warning: ID ${id} already categorized as "${row.category}" — skipping.`);
      resolveMap.delete(id);
      continue;
    }
  }

  const { groups, ambiguous, fleeting } = buildGroups(db, threshold, componentThreshold);
  const archiveTs = new Date().toISOString();

  // Archive entries to disk first (safe operation)
  const allToArchive = [];
  for (const [, entries] of groups) {
    allToArchive.push(...entries);
  }

  // Filter fleeting by retention
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const expiredFleeting = fleeting.filter(e => (e.timestamp || '') < cutoff);

  if (allToArchive.length > 0) {
    archiveEntries(pebblDir, allToArchive, archiveTs);
  }
  if (expiredFleeting.length > 0) {
    archiveEntries(pebblDir, expiredFleeting, archiveTs);
  }

  // SQLite transaction
  const compacted = db.transaction(() => {
    for (const [key, entries] of groups) {
      const first = entries[0];
      const rollupMsg = generateRollupMessage(entries);
      const ts = new Date().toISOString();

      db.prepare(`
        INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects)
        VALUES (?, 'agent', ?, 'detail', ?, ?, NULL, NULL)
      `).run(ts, first.category, rollupMsg, first.topics);

      const ids = entries.map(e => e.id);
      db.prepare(`DELETE FROM logs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }

    for (const [id, action] of resolveMap) {
      if (action === 'foundation') {
        db.prepare("UPDATE logs SET tier = 'foundation' WHERE id = ?").run(id);
      } else if (action === 'rollup') {
        db.prepare('DELETE FROM logs WHERE id = ?').run(id);
      }
    }

    if (expiredFleeting.length > 0) {
      const ids = expiredFleeting.map(e => e.id);
      db.prepare(`DELETE FROM logs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
  });

  try {
    compacted();
  } catch (err) {
    console.error('Compaction transaction failed:', err.message);
    console.error('Archive files may have extra lines, but SQLite is unchanged.');
    process.exit(1);
  }

  regenerateMarkdown(pebblDir);
  qmdUpdate(pebblDir);

  console.log(`Compacted ${allToArchive.length} detail/component entries into rollups.`);
  if (resolveMap.size > 0) {
    const foundationCount = [...resolveMap.values()].filter(a => a === 'foundation').length;
    const rollupCount = [...resolveMap.values()].filter(a => a === 'rollup').length;
    console.log(`Resolved ${foundationCount + rollupCount} ambiguous entries (${foundationCount} foundation, ${rollupCount} rollup).`);
  }
  if (expiredFleeting.length > 0) {
    console.log(`Deleted ${expiredFleeting.length} expired fleeting entries.`);
  }
  console.log('Done.');
}
