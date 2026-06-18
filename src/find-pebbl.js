'use strict';
const fs = require('fs');
const path = require('path');

// Walk up from cwd until we find .pebbl/, like git finds .git/
function findPebblDir() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.pebbl');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requirePebblDir() {
  const dir = findPebblDir();
  if (!dir) {
    console.error('No .pebbl/ directory found. Run `pebbl init` first.');
    process.exit(1);
  }
  return dir;
}

// P6 coexistence fork lives in its own module (src/store-mode.js) so the pure
// path-picker stays separate from the walk-up discovery here. Re-exported so
// `require('./find-pebbl').storeMode` resolves (the design's "path picked by
// presence of events.jsonl" sits naturally next to findPebblDir).
const { storeMode } = require('./store-mode');

module.exports = { findPebblDir, requirePebblDir, storeMode };
