'use strict';
const fs = require('fs');
const path = require('path');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');

module.exports = function log(message) {
  if (!message || !message.trim()) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  const ts = new Date().toISOString();
  const entry = `## ${ts} - ${message.trim()}\n\n`;

  fs.appendFileSync(path.join(pebblDir, 'manual-logs.md'), entry);

  const db = openDb(pebblDir);
  db.prepare('INSERT INTO logs (timestamp, source, message) VALUES (?, ?, ?)').run(ts, 'manual', message.trim());

  qmdUpdate(pebblDir);

  console.log(`[${ts.slice(0, 10)}] ${message.trim()}`);
};
