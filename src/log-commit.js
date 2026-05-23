'use strict';
const fs = require('fs');
const path = require('path');
const { findMemDir } = require('./find-mem');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function logCommit(hash, message, files) {
  // Called from post-commit hook — fail silently so it never blocks git
  try {
    const memDir = findMemDir();
    if (!memDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0]; // first line only
    const fileList = (files || '').replace(/,$/, '');

    const entry = `## ${ts} - ${shortHash}: ${msg}\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(memDir, 'commit-log.md'), entry);

    const db = openDb(memDir);
    db.prepare('INSERT INTO commits (timestamp, hash, message, files) VALUES (?, ?, ?, ?)').run(ts, hash, msg, fileList);

    qmdUpdate(memDir);
  } catch {
    // Never block a commit
  }
};
