'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function logCommit(hash, message, files) {
  try {
    const pebblDir = findPebblDir();
    if (!pebblDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0];
    const fileList = (files || '').replace(/,$/, '');

    const md = `## ${ts} - ${shortHash}: ${msg}\n<!-- cat:uncategorized topic: tier:fleeting source:hook -->\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'commit-log.md'), md);

    const db = openDb(pebblDir);
    db.prepare(`
      INSERT INTO commits (timestamp, hash, message, files)
      VALUES (?, ?, ?, ?)
    `).run(ts, hash, msg, fileList);

    db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'hook', 'uncategorized', 'fleeting', ?, NULL)
    `).run(ts, msg);

    qmdUpdate(pebblDir);
  } catch {
    // Never block a commit
  }
};
