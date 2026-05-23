'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { openDb } = require('./db');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');

const HOOK_SCRIPT = `#!/bin/sh
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
mem log-commit "$HASH" "$MESSAGE" "$FILES"
`;

module.exports = function init() {
  const cwd = process.cwd();
  const memDir = path.join(cwd, '.mem');

  if (fs.existsSync(memDir)) {
    console.log('.mem/ already exists — skipping directory creation.');
  } else {
    fs.mkdirSync(memDir, { recursive: true });
    console.log('Created .mem/');
  }

  // Seed empty markdown files
  const manualLogs = path.join(memDir, 'manual-logs.md');
  const commitLog  = path.join(memDir, 'commit-log.md');
  if (!fs.existsSync(manualLogs)) fs.writeFileSync(manualLogs, '# Manual Logs\n\n');
  if (!fs.existsSync(commitLog))  fs.writeFileSync(commitLog,  '# Commit Log\n\n');

  // Initialize SQLite
  openDb(memDir);
  console.log('Initialized db.sqlite');

  // Git hook
  const gitDir = path.join(cwd, '.git');
  if (fs.existsSync(gitDir)) {
    const hookPath = path.join(gitDir, 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    console.log('Installed post-commit hook');
  } else {
    console.log('No .git/ found — skipping git hook (run inside a git repo to enable).');
  }

  // .gitignore
  const gitignore = path.join(cwd, '.gitignore');
  const entry = '.mem/\n';
  if (fs.existsSync(gitignore)) {
    const existing = fs.readFileSync(gitignore, 'utf8');
    if (!existing.includes('.mem/')) {
      fs.appendFileSync(gitignore, `\n${entry}`);
      console.log('Added .mem/ to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignore, entry);
    console.log('Created .gitignore with .mem/');
  }

  // QMD index
  if (qmdAvailable()) {
    try {
      qmdCollectionCreate(memDir);
      console.log('QMD collection created');
    } catch {
      console.warn('QMD collection create failed — you may need to run it manually.');
    }
  } else {
    console.warn('qmd not found — semantic search disabled until you run: npm install -g qmd');
  }

  console.log('\npebbl ready. Run `mem log "[your first note]"` to start stacking.');
};
