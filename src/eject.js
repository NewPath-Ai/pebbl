'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');

// Removes a delimited block from a file. Returns true if anything was removed.
function removeBlock(filePath, startMarker, endMarker) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const start = content.indexOf(startMarker);
  if (start === -1) return false;
  // If there's an end marker, remove up to and including it; otherwise remove from start marker to EOF
  const end = endMarker ? content.indexOf(endMarker, start) : -1;
  const trimmed = end !== -1
    ? content.slice(0, start).trimEnd() + '\n' + content.slice(end + endMarker.length)
    : content.slice(0, start).trimEnd() + '\n';
  fs.writeFileSync(filePath, trimmed);
  return true;
}

module.exports = function eject() {
  const cwd = process.cwd();
  let removed = false;

  // Remove pebbl section from AGENT.md
  if (removeBlock(
    path.join(cwd, 'AGENT.md'),
    '\n## Pebbl — Project Memory Protocol',
    '- Things already obvious from the code itself\n'
  )) {
    console.log('Removed pebbl block from AGENT.md');
    removed = true;
  }

  // Remove git hook
  const hookPath = path.join(cwd, '.git', 'hooks', 'post-commit');
  if (fs.existsSync(hookPath)) {
    const hook = fs.readFileSync(hookPath, 'utf8');
    if (hook.includes('pebbl log-commit')) {
      fs.unlinkSync(hookPath);
      console.log('Removed post-commit hook');
      removed = true;
    }
  }

  // Remove .pebbl/ from .gitignore
  const gitignore = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const content = fs.readFileSync(gitignore, 'utf8');
    if (content.includes('.pebbl/')) {
      fs.writeFileSync(gitignore, content.replace(/\n?\.pebbl\/\n?/g, '\n').trim() + '\n');
      console.log('Removed .pebbl/ from .gitignore');
      removed = true;
    }
  }

  // Check for .pebbl/ dir — warn but don't auto-delete (user's data)
  const pebblDir = findPebblDir();
  if (pebblDir) {
    console.log(`\n.pebbl/ still exists at ${pebblDir} — delete it manually if you want to remove your memory data.`);
  }

  if (!removed) {
    console.log('Nothing to eject — pebbl does not appear to be initialized here.');
  } else {
    console.log('\nPebbl ejected. Re-run `pebbl init` to set it up again.');
  }
};
