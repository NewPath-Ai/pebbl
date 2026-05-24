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

const VALID_TIERS = ['signal', 'detail', 'fleeting'];

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

  if (!flags.cat) {
    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, message);
    if (classified) {
      category = classified.category;
      if (!flags.tier) tier = classified.tier;
    }
  }

  if (!category) category = 'uncategorized';
  if (!tier) tier = 'detail';

  const source = flags.source || 'human';
  const topics = flags.topic || null;
  const relatesTo = flags.relates ? parseInt(flags.relates, 10) : null;
  const corrects = flags.corrects ? parseInt(flags.corrects, 10) : null;

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
