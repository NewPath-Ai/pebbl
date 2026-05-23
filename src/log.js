'use strict';
const fs = require('fs');
const path = require('path');
const { requireMemDir } = require('./find-mem');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function log(message) {
  if (!message || !message.trim()) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  const memDir = requireMemDir();
  const ts = new Date().toISOString();
  const entry = `## ${ts} - ${message.trim()}\n\n`;

  fs.appendFileSync(path.join(memDir, 'manual-logs.md'), entry);

  const db = openDb(memDir);
  db.prepare('INSERT INTO logs (timestamp, source, message) VALUES (?, ?, ?)').run(ts, 'manual', message.trim());

  qmdUpdate(memDir);

  console.log(`[${ts.slice(0, 10)}] ${message.trim()}`);
};
