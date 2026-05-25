'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb, topicFilter } = require('./db');
const { loadConfig, ensureProjectFiles } = require('./rubric');
const { displayEntry } = require('./log');
const { isThinEntry } = require('./detect-thin');

// ── helpers ──────────────────────────────────────────────────────────────────

function findRelatedCommits(cwd, message) {
  try {
    const { execSync } = require('child_process');
    const gitDir = path.join(cwd, '.git');
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

function relativeDate(isoTimestamp) {
  if (!isoTimestamp) return '';
  const d = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getNarrativeUpdated(pebblDir) {
  try {
    const narrativePath = path.join(pebblDir, 'narrative.md');
    const content = fs.readFileSync(narrativePath, 'utf8');
    const match = content.match(/<!--\s*updated:\s*(\S+)/);
    if (match) return match[1];
  } catch {}
  return null;
}

// ── shared UI ────────────────────────────────────────────────────────────────

function showOpenHandoff(db) {
  const hasHandoffsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'").get();
  if (!hasHandoffsTable) return;

  const openHandoff = db.prepare("SELECT * FROM handoffs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
  if (!openHandoff) return;

  const ago = Math.round((Date.now() - new Date(openHandoff.timestamp).getTime()) / 3600000);
  const agoText = ago < 1 ? 'just now' : `${ago}h ago`;
  console.log(`── Open handoff (#${openHandoff.id}, ${agoText}) ──`);
  console.log(openHandoff.summary);
  if (openHandoff.done) console.log(`  done: ${openHandoff.done}`);
  if (openHandoff.todo) console.log(`  todo: ${openHandoff.todo}`);
  if (openHandoff.blocked) console.log(`  blocked: ${openHandoff.blocked}`);
  if (openHandoff.topics) console.log(`  topics: ${openHandoff.topics}`);
  console.log('──');
  console.log('');
}

function showEntryWithThinCheck(row, cwd) {
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

function showCompactionNotifications(db, pebblDir) {
  const config = loadConfig(pebblDir) || {};
  const threshold = (config.compaction && config.compaction.threshold) || 10;

  const compactable = db.prepare(`
    SELECT topics, COUNT(*) as cnt FROM logs
    WHERE tier IN ('component','detail','fleeting')
      AND topics IS NOT NULL AND topics != ''
    GROUP BY topics HAVING cnt >= ?
  `).all(threshold);

  for (const row of compactable) {
    const topicList = (row.topics || '').split(',').map(t => t.trim());
    for (const t of topicList) {
      if (!t) continue;
      const filter = topicFilter(t);
      const topicCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM logs
        WHERE tier IN ('component','detail','fleeting')
          ${filter.clause}
      `).get(...filter.params);
      if (topicCount && topicCount.cnt >= threshold) {
        console.log(`[pebbl] ${topicCount.cnt} entries on '${t}' ready for compaction. Run: pebbl compact --preview`);
      }
    }
  }
}

// ── mode: default (new 3-section format) ────────────────────────────────────

function contextDefault(pebblDir, db) {
  const cwd = process.cwd();

  showOpenHandoff(db);

  // ── Section 1: NARRATIVE ──

  const { readNarrative } = require('./narrative');
  const narrative = readNarrative(pebblDir);
  if (narrative) {
    const narrUpdated = getNarrativeUpdated(pebblDir);
    const dateStr = narrUpdated ? relativeDate(narrUpdated) : '';
    // Strip HTML comments and the # Project Narrative heading for cleaner display
    const cleaned = narrative
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^# Project Narrative\n*/m, '')
      .trim();
    console.log('--- NARRATIVE ---');
    console.log(cleaned);
    if (dateStr) console.log(`(updated: ${dateStr})`);
    console.log('');
  } else {
    console.log('hint: no project narrative set. Run: pebbl narrative "..."');
    console.log('');
  }

  // ── Section 2: TOPIC INDEX ──

  // Query: non-fleeting entries by topic+tier, excluding corrected entries
  const topicRows = db.prepare(`
    SELECT topics, tier, COUNT(*) as cnt, MAX(timestamp) as last_updated
    FROM logs
    WHERE tier IN ('foundation', 'component')
      AND topics IS NOT NULL AND topics != ''
      AND id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)
    GROUP BY topics, tier
    ORDER BY last_updated DESC
  `).all();

  // Aggregate by topic — split comma-separated topics and count per-tier
  const topicMap = new Map();
  for (const row of topicRows) {
    const topicList = row.topics.split(',').map(t => t.trim()).filter(Boolean);
    for (const t of topicList) {
      if (!topicMap.has(t)) {
        topicMap.set(t, { maxTs: null, foundation: 0, component: 0 });
      }
      const entry = topicMap.get(t);
      if (row.tier === 'foundation') entry.foundation += row.cnt;
      if (row.tier === 'component') entry.component += row.cnt;
      if (!entry.maxTs || row.last_updated > entry.maxTs) {
        entry.maxTs = row.last_updated;
      }
    }
  }

  // Sort by most recently updated
  const sortedTopics = [...topicMap.entries()].sort((a, b) => {
    const aTs = a[1].maxTs || '';
    const bTs = b[1].maxTs || '';
    return bTs.localeCompare(aTs);
  });

  if (sortedTopics.length > 0) {
    const totalAreas = sortedTopics.length;
    const totalDecisions = sortedTopics.reduce((sum, [, v]) => sum + v.foundation + v.component, 0);
    console.log(`--- TOPICS (${totalAreas} areas, ${totalDecisions} decisions) ---`);
    for (const [topic, data] of sortedTopics) {
      const parts = [];
      if (data.foundation > 0) parts.push(`${data.foundation} foundation`);
      if (data.component > 0) parts.push(`${data.component} component`);
      const dateStr = data.maxTs ? relativeDate(data.maxTs) : '';
      console.log(`  ${topic.padEnd(14)}${parts.join(', ')} decisions (updated ${dateStr})`);
    }
    console.log('');
  } else {
    console.log('--- TOPICS ---');
    console.log('  (no topics yet)');
    console.log('');
  }

  // ── Section 3: RECENT ACTIVITY ──

  const recentRows = db.prepare(`
    SELECT id, timestamp, source, category, tier, message, topics
    FROM logs
    WHERE tier IN ('foundation', 'component', 'detail')
      AND id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)
    ORDER BY id DESC
    LIMIT 5
  `).all();

  console.log('--- RECENT ---');
  if (recentRows.length === 0) {
    console.log('  (no entries yet)');
  } else {
    for (const row of recentRows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');

  showCompactionNotifications(db, pebblDir);
}

// ── mode: full (legacy flat list, activated via --full) ─────────────────────

function contextFull(pebblDir, db, flags) {
  const cwd = process.cwd();

  showOpenHandoff(db);

  let sql = 'SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL) AND 1=1';
  const params = [];

  if (flags.cat) {
    sql += ' AND category = ?';
    params.push(flags.cat);
  }
  if (flags.tier) {
    sql += ' AND tier = ?';
    params.push(flags.tier);
  }
  if (flags.source) {
    sql += ' AND source = ?';
    params.push(flags.source);
  }
  if (flags.topic) {
    const filter = topicFilter(flags.topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  sql += ` ORDER BY CASE tier WHEN 'foundation' THEN 0 WHEN 'component' THEN 1 WHEN 'detail' THEN 2 WHEN 'fleeting' THEN 3 ELSE 4 END, id DESC LIMIT 10`;

  const rows = db.prepare(sql).all(...params);

  console.log('--- PROJECT MEMORY ---');
  if (rows.length === 0) {
    console.log('(no entries yet)');
  } else {
    for (const row of rows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');

  showCompactionNotifications(db, pebblDir);
}

// ── mode: topic-scoped (activated via --topic) ─────────────────────────────

function contextTopic(pebblDir, db, topic, flags) {
  const cwd = process.cwd();

  showOpenHandoff(db);

  const filter = topicFilter(topic);

  // 1. ALL foundation entries (regardless of topic)
  let sql = `SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE tier = 'foundation' AND id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)`;
  const fParams = [];
  if (flags.cat) { sql += ' AND category = ?'; fParams.push(flags.cat); }
  sql += ' ORDER BY id DESC';
  const foundationRows = db.prepare(sql).all(...fParams);

  // 2. ALL component entries matching the topic
  sql = `SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE tier = 'component' AND id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL) ${filter.clause}`;
  const cParams = [...filter.params];
  if (flags.cat) { sql += ' AND category = ?'; cParams.push(flags.cat); }
  sql += ' ORDER BY id DESC';
  const componentRows = db.prepare(sql).all(...cParams);

  // 3. Recent detail entries matching the topic (limit 5)
  sql = `SELECT id, timestamp, source, category, tier, message, topics FROM logs WHERE tier = 'detail' AND id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL) ${filter.clause}`;
  const dParams = [...filter.params];
  if (flags.cat) { sql += ' AND category = ?'; dParams.push(flags.cat); }
  sql += ' ORDER BY id DESC LIMIT 5';
  const detailRows = db.prepare(sql).all(...dParams);

  // Combine and sort: foundation first, then component, then detail; newest first within each tier
  const allRows = [...foundationRows, ...componentRows, ...detailRows];
  const tierOrder = { foundation: 0, component: 1, detail: 2 };
  allRows.sort((a, b) => {
    const ta = tierOrder[a.tier] !== undefined ? tierOrder[a.tier] : 3;
    const tb = tierOrder[b.tier] !== undefined ? tierOrder[b.tier] : 3;
    if (ta !== tb) return ta - tb;
    return b.id - a.id;
  });

  console.log(`--- TOPIC: ${topic} ---`);
  if (allRows.length === 0) {
    console.log('(no entries)');
  } else {
    for (const row of allRows) {
      showEntryWithThinCheck(row, cwd);
    }
  }
  console.log('---');

  showCompactionNotifications(db, pebblDir);
}

// ── exported entry point ─────────────────────────────────────────────────────

module.exports = function context(args) {
  const { flags } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);
  const db = openDb(pebblDir);

  // Check raw args for --full since it is not in KNOWN_FLAGS
  const isFull = args.includes('--full');

  if (isFull) {
    contextFull(pebblDir, db, flags);
  } else if (flags.topic) {
    contextTopic(pebblDir, db, flags.topic, flags);
  } else if (flags.cat || flags.tier || flags.source) {
    // Filter flags without --topic or --full fall through to full view
    // for backward compatibility
    contextFull(pebblDir, db, flags);
  } else {
    contextDefault(pebblDir, db);
  }
};
