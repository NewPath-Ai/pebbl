'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { requirePebblDir } = require('./find-pebbl');
const { ensureProjectFiles, DEFAULT_RUBRIC, DEFAULT_CONFIG } = require('./rubric');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');

const HOOK_SCRIPT = `#!/bin/sh
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
`;

function upgradeAgentsMd(cwd) {
  const agentMd = path.join(cwd, 'AGENTS.md');
  const marker = '## Pebbl — Project Memory Protocol';
  const endMarker = '\n## ';

  if (!fs.existsSync(agentMd)) {
    console.log('AGENTS.md not found — run pebbl init first');
    return;
  }

  let content = fs.readFileSync(agentMd, 'utf8');

  if (!content.includes(marker)) {
    fs.appendFileSync(agentMd, '\n' + require('./init').AGENT_SECTION);
    console.log('Added pebbl section to AGENTS.md');
    return;
  }

  const startIdx = content.indexOf(marker);
  const afterStart = content.slice(startIdx + marker.length);
  const endIdx = afterStart.indexOf(endMarker);

  if (endIdx === -1) {
    const before = content.slice(0, startIdx);
    fs.writeFileSync(agentMd, before + require('./init').AGENT_SECTION);
    console.log('Updated pebbl section in AGENTS.md');
    return;
  }

  const before = content.slice(0, startIdx);
  const after = content.slice(startIdx + marker.length + endIdx);
  fs.writeFileSync(agentMd, before + require('./init').AGENT_SECTION + after);
  console.log('Updated pebbl section in AGENTS.md');
}

function mergeRubric(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
    console.log('Updated rubric.yml');
    return;
  }

  const existing = fs.readFileSync(rubricPath, 'utf8');

  if (existing.includes('(default|threshold|weight|score') && existing.includes('.{0,20}')) {
    console.log('rubric.yml already up to date');
    return;
  }

  const newRule = `  - pattern: "\\\\b(default|threshold|weight|score\\\\b|blend|config|param|formula)\\\\b.{0,20}\\\\d+\\\\.?\\\\d*"
    category: decision
    tier: detail
`;
  fs.appendFileSync(rubricPath, `\n${newRule}\n`);
  console.log('rubric.yml: appended 1 new rule');
}

module.exports = function upgrade() {
  const cwd = process.cwd();
  const pebblDir = requirePebblDir();

  ensureProjectFiles(pebblDir);

  openDb(pebblDir);
  console.log('Database migration checked');

  mergeRubric(pebblDir);

  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
    console.log('Created config.yml');
  }

  const gitDir = path.join(cwd, '.git');
  if (fs.existsSync(gitDir)) {
    const hookPath = path.join(gitDir, 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    console.log('Updated post-commit hook');
  }

  upgradeAgentsMd(cwd);

  if (qmdAvailable()) {
    try {
      qmdCollectionCreate(pebblDir);
      console.log('QMD collection refreshed');
    } catch {
      console.warn('QMD collection refresh failed — run manually if needed');
    }
  }

  console.log('\npebbl upgrade complete.');
};
