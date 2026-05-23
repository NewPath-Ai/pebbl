'use strict';
const fs = require('fs');
const path = require('path');

// Walk up from cwd until we find .mem/, like git finds .git/
function findMemDir() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.mem');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requireMemDir() {
  const dir = findMemDir();
  if (!dir) {
    console.error('No .mem/ directory found. Run `pebbl init` first.');
    process.exit(1);
  }
  return dir;
}

module.exports = { findMemDir, requireMemDir };
