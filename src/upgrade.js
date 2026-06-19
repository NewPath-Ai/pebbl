'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { requirePebblDir } = require('./find-pebbl');
const { ensureProjectFiles, DEFAULT_RUBRIC, DEFAULT_CONFIG } = require('./rubric');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');

// The post-commit hook template now lives in ONE place — src/init.js
// (postCommitHook). `pebbl upgrade` rewrites the hook from that same function so
// re-init and upgrade can never drift (DRY). It's required lazily inside
// upgrade() to avoid a require cycle with init.js. Embed bypass + background +
// per-store lock are documented at the init.js definition (incident 2026-06-18).

function upgradeAgentsMd(cwd) {
  const agentMd = path.join(cwd, 'AGENTS.md');
  const { AGENT_SECTION, AGENT_BEGIN, AGENT_END } = require('./init');

  if (!fs.existsSync(agentMd)) {
    console.log('AGENTS.md not found — run pebbl init first');
    return;
  }

  const content = fs.readFileSync(agentMd, 'utf8');

  // New format: sentinel-delimited block — replace in place.
  const beginIdx = content.indexOf(AGENT_BEGIN);
  if (beginIdx !== -1) {
    const endIdx = content.indexOf(AGENT_END, beginIdx);
    if (endIdx !== -1) {
      const before = content.slice(0, beginIdx).trimEnd();
      const after = content.slice(endIdx + AGENT_END.length).trimStart();
      const tail = after ? '\n\n' + after : '\n';
      fs.writeFileSync(agentMd, before + AGENT_SECTION.trimEnd() + tail);
      console.log('Updated pebbl section in AGENTS.md');
      return;
    }
  }

  // Old format: header `## Pebbl — Project Memory Protocol` to next `## ` or EOF.
  const oldMarker = '## Pebbl — Project Memory Protocol';
  const oldStart = content.indexOf(oldMarker);
  if (oldStart !== -1) {
    const afterStart = content.slice(oldStart + oldMarker.length);
    const oldEnd = afterStart.indexOf('\n## ');
    const before = content.slice(0, oldStart).trimEnd();
    const after = oldEnd === -1 ? '' : content.slice(oldStart + oldMarker.length + oldEnd);
    fs.writeFileSync(agentMd, before + AGENT_SECTION + after);
    console.log('Migrated pebbl section in AGENTS.md to sentinel format');
    return;
  }

  // No prior block — append.
  fs.appendFileSync(agentMd, AGENT_SECTION);
  console.log('Added pebbl section to AGENTS.md');
}

function removeLegacyPebblMd(cwd) {
  const pebblMd = path.join(cwd, 'PEBBL.md');
  if (fs.existsSync(pebblMd)) {
    fs.unlinkSync(pebblMd);
    console.log('Removed legacy PEBBL.md (semantics now live in `pebbl help <topic>`)');
  }
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
    // Reuse init's pinned template (lazy require avoids an init<->upgrade cycle),
    // pinning THIS pebbl's bin so the upgraded hook runs the installed code (with
    // the embed bypass + background), not a stale `pebbl` first on $PATH.
    const { postCommitHook } = require('./init');
    const pinnedBin = path.resolve(__dirname, '..', 'bin', 'pebbl.js');
    fs.writeFileSync(hookPath, postCommitHook(pinnedBin), { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755); // mode only applies on create; force +x on rewrite
    console.log('Updated post-commit hook');
  }

  upgradeAgentsMd(cwd);
  removeLegacyPebblMd(cwd);

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
