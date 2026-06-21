'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { loadRubric, classifyEntry } = require('./rubric');
// Projection-boundary secret mask: commit-log.md is committed + gate-scanned;
// the DB (commits/logs tables below) keeps the original commit message.
const { redact } = require('./privacy-scan');

module.exports = function logCommit(hash, message, files) {
  try {
    const pebblDir = findPebblDir();
    if (!pebblDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0];
    const fileList = (files || '').replace(/,$/, '');

    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, msg);
    const category = classified ? classified.category : 'uncategorized';
    const tier = 'fleeting';

    const md = `## ${ts} - ${shortHash}: ${redact(msg)}\n<!-- cat:${category} topic: tier:${tier} source:hook -->\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'commit-log.md'), md);

    const db = openDb(pebblDir);
    db.prepare(`
      INSERT INTO commits (timestamp, hash, message, files)
      VALUES (?, ?, ?, ?)
    `).run(ts, hash, msg, fileList);

    db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'hook', ?, 'fleeting', ?, NULL)
    `).run(ts, category, msg);
  } catch {
    // Never block a commit
  }
};
