'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');

const AGENT_SECTION = `
## Pebbl — Project Memory Protocol

Pebbl is a local CLI memory tool scoped to this repository. It stores decisions, failed approaches, and commit context as searchable entries. Use it to avoid repeating mistakes and to understand why the codebase is the way it is.

### When to use it

- At the start of every session, before touching any code
- Before suggesting an approach you aren't certain about
- After any decision, failure, or pivot worth remembering

### How to use it

\`\`\`bash
pebbl context              # always run this first
pebbl search "auth"        # before working on any feature
pebbl search "why did we"  # before suggesting an approach
pebbl log "message"        # after any significant decision or failure
\`\`\`

### What to log

- Approaches that failed and why
- Decisions made and the reasoning behind them
- Constraints discovered during implementation
- Anything you'd want to know at the start of the next session

### What not to log

- Every small code change — the git hook handles that automatically
- Things already obvious from the code itself
`;

const AGENT_STANDALONE = `# Agent Guidelines\n${AGENT_SECTION}`;


const HOOK_SCRIPT = `#!/bin/sh
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
`;

module.exports = function init() {
  const cwd = process.cwd();
  const pebblDir = path.join(cwd, '.pebbl');

  if (fs.existsSync(pebblDir)) {
    console.log('.pebbl/ already exists — skipping directory creation.');
  } else {
    fs.mkdirSync(pebblDir, { recursive: true });
    console.log('Created .pebbl/');
  }

  // Seed empty markdown files
  const manualLogs = path.join(pebblDir, 'manual-logs.md');
  const commitLog  = path.join(pebblDir, 'commit-log.md');
  if (!fs.existsSync(manualLogs)) fs.writeFileSync(manualLogs, '# Manual Logs\n\n');
  if (!fs.existsSync(commitLog))  fs.writeFileSync(commitLog,  '# Commit Log\n\n');

  // Initialize SQLite
  openDb(pebblDir);
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
  const entry = '.pebbl/\n';
  if (fs.existsSync(gitignore)) {
    const existing = fs.readFileSync(gitignore, 'utf8');
    if (!existing.includes('.pebbl/')) {
      fs.appendFileSync(gitignore, `\n${entry}`);
      console.log('Added .pebbl/ to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignore, entry);
    console.log('Created .gitignore with .pebbl/');
  }

  // AGENTS.md — create or append, never overwrite
  const agentMd = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentMd)) {
    fs.writeFileSync(agentMd, AGENT_STANDALONE);
    console.log('Created AGENTS.md with pebbl guidance');
  } else {
    const existing = fs.readFileSync(agentMd, 'utf8');
    if (!existing.includes('Pebbl — Project Memory Protocol')) {
      fs.appendFileSync(agentMd, AGENT_SECTION);
      console.log('Appended pebbl guidance to existing AGENTS.md');
    } else {
      console.log('AGENTS.md already contains pebbl guidance — skipping');
    }
  }

  // QMD index
  if (qmdAvailable()) {
    try {
      qmdCollectionCreate(pebblDir);
      console.log('QMD collection created');
    } catch {
      console.warn('QMD collection create failed — you may need to run it manually.');
    }
  } else {
    console.warn('qmd not found — semantic search disabled until you run: npm install -g qmd');
  }

  console.log('\npebbl ready. Run `pebbl log "[your first note]"` to start stacking.');
};
