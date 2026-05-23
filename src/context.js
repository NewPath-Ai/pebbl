'use strict';
const fs = require('fs');
const path = require('path');
const { requirePebblDir } = require('./find-pebbl');

module.exports = function context() {
  const pebblDir = requirePebblDir();
  const logFile = path.join(pebblDir, 'manual-logs.md');

  if (!fs.existsSync(logFile)) {
    console.log('--- PROJECT MEMORY ---\n(no entries yet)\n---');
    return;
  }

  const lines = fs.readFileSync(logFile, 'utf8').split('\n');
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^## (\S+) - (.+)$/);
    if (match) {
      const date = match[1].slice(0, 10);
      entries.push(`[${date}] ${match[2]}`);
    }
  }

  const last5 = entries.slice(-5);
  console.log('--- PROJECT MEMORY ---');
  if (last5.length === 0) {
    console.log('(no entries yet)');
  } else {
    last5.forEach(e => console.log(e));
  }
  console.log('---');
};
