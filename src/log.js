'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');
const { loadRubric, classifyEntry, ensureProjectFiles } = require('./rubric');
const { isThinEntry } = require('./detect-thin');

const VALID_CATEGORIES = [
  'decision', 'structure', 'pattern', 'data', 'integration', 'quality',
];

const VALID_TIERS = ['foundation', 'component', 'detail', 'fleeting'];

const VALID_SOURCES = ['human', 'agent', 'hook'];

function validate(flags) {
  if (flags.cat && !VALID_CATEGORIES.includes(flags.cat)) {
    console.error(`Invalid category "${flags.cat}". Valid: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (flags.tier && !VALID_TIERS.includes(flags.tier)) {
    console.error(`Invalid tier "${flags.tier}". Valid: ${VALID_TIERS.join(', ')}`);
    process.exit(1);
  }
  if (flags.source && !VALID_SOURCES.includes(flags.source)) {
    console.error(`Invalid source "${flags.source}". Valid: ${VALID_SOURCES.join(', ')}`);
    process.exit(1);
  }
}

function formatEntry(timestamp, message, category, tier, source, topics) {
  const comment = `<!-- cat:${category} topic:${topics || ''} tier:${tier} source:${source} -->`;

  const date = timestamp.slice(0, 10);
  let out = `[${date}] [${tier}|${category}] ${message}`;
  if (topics) out += `\n  topics: ${topics}`;
  return { comment, out };
}

module.exports = function log(args) {
  const { flags, positional } = parseArgs(args);

  const message = positional.join(' ').trim();
  if (!message) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  validate(flags);

  const pebblDir = requirePebblDir();

  if (isThinEntry(message)) {
    console.error('pebbl: this reads like a spec sheet — consider adding "because..." to explain the rationale');
  }
  ensureProjectFiles(pebblDir);
  const ts = new Date().toISOString();

  let category = flags.cat || null;
  let tier = flags.tier || null;

  // [session] entries are always uncategorized/fleeting — rubric owns this,
  // manual --cat cannot override it. This prevents agents from accidentally
  // tagging session summaries as decisions.
  const isSession = /^\[session\]/i.test(message);
  if (isSession) {
    if (flags.cat && flags.cat !== 'uncategorized') {
      console.error(`pebbl: [session] entries are auto-classified as uncategorized/fleeting — ignoring --cat ${flags.cat}`);
    }
    category = 'uncategorized';
    tier = 'fleeting';
    console.error('pebbl: tip — consider `pebbl handoff` for structured session handoffs with --done/--todo/--blocked');
  } else {
    // --scope foundation explicitly marks an entry as foundational
    if (flags.scope === 'foundation') {
      tier = 'foundation';
    }
    // Always consult rubric for classification. Manual --cat overrides
    // rubric category, but rubric still informs tier when --tier is absent.
    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, message);
    if (!flags.cat && classified) {
      category = classified.category;
    }
    if (!flags.tier && !flags.scope && classified) {
      tier = classified.tier;
    }
  }

  // If --corrects is set, inherit category/tier from the corrected entry
  // as a fallback when neither manual flags nor rubric provided them.
  if (flags.corrects) {
    const origDb = openDb(pebblDir);
    const origId = parseInt(flags.corrects, 10);
    const original = origDb.prepare('SELECT category, tier FROM logs WHERE id = ?').get(origId);
    if (original) {
      if (!category) category = original.category;
      if (!tier) tier = original.tier;
    }
  }

  // Auto-detect foundation scope from message language.
  // Fires when tier hasn't been explicitly set by the user.
  if (!flags.scope && !flags.tier) {
    const FOUNDATION_PATTERNS = /\b(the\s+(system|project|codebase|repo|app|application)\s+(uses?|is|was|will|requires?)|all\s+(modules?|services?|components?)|everywhere|project-?wide|system-?wide|monorepo|tech\s*stack)\b/i;
    if (FOUNDATION_PATTERNS.test(message)) {
      tier = 'foundation';
      // System-wide statements like "the project uses X because Y" are
      // decisions even when the rubric doesn't match a decision verb.
      // "uses" is too broad for the general rubric, but scoped to
      // system/project/app language it's a reliable signal.
      if (!category || category === 'uncategorized') {
        category = 'decision';
      }
    }
    // Entries with no topic + decision/structure category are likely project-wide
    if (!tier && !flags.topic) {
      if (category === 'decision' || category === 'structure') {
        tier = 'foundation';
      }
    }
  }

  // When rubric didn't match and no manual tier, use category-based defaults:
  // decision/structure/pattern are architectural → component tier.
  // Everything else → detail.
  if (!category) category = 'uncategorized';
  if (!tier) {
    const SIGNAL_CATEGORIES = ['decision', 'structure', 'pattern'];
    tier = SIGNAL_CATEGORIES.includes(category) ? 'component' : 'detail';
  }

  const source = flags.source || 'human';
  const topics = flags.topic || null;
  const relatesTo = flags.relates ? parseInt(flags.relates, 10) : null;
  const corrects = flags.corrects ? parseInt(flags.corrects, 10) : null;

  if (!isSession && !flags.cat && category === 'uncategorized') {
    console.error(`pebbl: no --cat given and rubric didn't match — entry stored as 'uncategorized'`);
    console.error(`       pick one: ${VALID_CATEGORIES.join(', ')}`);
  }

  const mdEntry = formatEntry(ts, message, category, tier, source, topics);
  const md = `## ${ts} - ${message}\n${mdEntry.comment}\n\n`;
  fs.appendFileSync(path.join(pebblDir, 'manual-logs.md'), md);

  const db = openDb(pebblDir);
  db.prepare(`
    INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ts, source, category, tier, message, topics, relatesTo, corrects);

  qmdUpdate(pebblDir);

  console.log(mdEntry.out);
};

module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.VALID_TIERS = VALID_TIERS;
module.exports.VALID_SOURCES = VALID_SOURCES;

function displayEntry(e) {
  const date = (e.timestamp || '').slice(0, 10);
  let out = `[${e.tier}|${e.category}] ${date} — ${e.message}`;
  if (e.topics) out += `\n  topics: ${e.topics}`;
  return out;
}

module.exports.displayEntry = displayEntry;
