'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');
const { DEFAULT_RUBRIC, DEFAULT_CONFIG } = require('./rubric');

const AGENT_BEGIN = '<!-- pebbl:begin -->';
const AGENT_END = '<!-- pebbl:end -->';

const AGENT_SECTION = `
${AGENT_BEGIN}
## Pebbl — Memory

Local CLI for project memory. Flag details: \`pebbl <cmd> --help\`. Concepts: \`pebbl help <topic>\` (categories, tiers, compaction, file-layout, entry-ids).

**Every session, before code:** \`pebbl context\` (read open handoff + recent decisions). An open handoff's \`done\` field is what the *previous* agent finished — don't claim it as your own. The \`todo\` field is what's left for you. Close the handoff with \`pebbl handoff --close\` when you complete the remaining work.

**Before any non-trivial decision:** \`pebbl search "<area>"\` — don't re-litigate prior choices.

**Log the moment a decision or failed approach lands.** Always include \`--cat\` and \`--topic\`. Always explain *why*, not just *what* — entries without rationale get auto-demoted.

\`\`\`bash
pebbl log "chose bcrypt over argon2 because team already operates bcrypt in prod" --cat decision --topic auth
\`\`\`

**End of session:** \`pebbl handoff "<summary>" --done "a; b" --todo "c; d" --topic <area>\`. Use \`;\` to split atomic items — one run-on becomes one unsearchable blob.

**Don't log:** routine code changes (the git hook captures commits), or anything obvious from reading the code.
${AGENT_END}
`;

const AGENT_STANDALONE = `# Agent Guidelines\n${AGENT_SECTION}`;

const HOOK_SCRIPT = `#!/bin/sh
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
`;

// P4 — post-merge / post-checkout rebuild trigger. A `git merge` or
// `git checkout` can pull NEW events.jsonl lines into the store (the whole
// point of committed, shared memory), but the view (view.sqlite + markdown) is
// derived and gitignored, so it would be stale until something rebuilt it.
// These hooks DO NOT fold inline — folding the whole log inside a git hook
// would make every pull/checkout slow and could block on the lock. They only
// TOUCH a sentinel; the actual rebuild is LAZY, done by the staleness check
// (src/staleness.js, wired into openDb) on the very next pebbl command. The
// sentinel is a cheap, idempotent marker that a rebuild is due. mkdir -p guards
// the case where .pebbl/ isn't present in the checked-out tree yet.
const REBUILD_HOOK_SCRIPT = `#!/bin/sh
# pebbl P4: mark the view stale after a merge/checkout pulled new events.
# The rebuild itself is lazy — it happens on the next \`pebbl\` command, never
# here (folding inline would make every pull/checkout slow).
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -d "$ROOT/.pebbl" ] || exit 0
: > "$ROOT/.pebbl/.rebuild-needed" 2>/dev/null || true
exit 0
`;

function init() {
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

  // Rubric
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
    console.log('Created rubric.yml');
  }

  // Config
  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
    console.log('Created config.yml');
  }

  // Initialize SQLite
  openDb(pebblDir);
  console.log('Initialized db.sqlite');

  // Git hooks
  const gitDir = path.join(cwd, '.git');
  if (fs.existsSync(gitDir)) {
    const hooksDir = path.join(gitDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // writeFileSync's `mode` only applies on CREATE — an existing hook keeps its
    // old mode — so chmod explicitly after writing to guarantee +x on re-init.
    const writeHook = (name, body) => {
      const p = path.join(hooksDir, name);
      fs.writeFileSync(p, body, { mode: 0o755 });
      fs.chmodSync(p, 0o755);
    };
    writeHook('post-commit', HOOK_SCRIPT);
    console.log('Installed post-commit hook');
    // P4: post-merge + post-checkout mark the view stale (sentinel touch only);
    // the rebuild is lazy on the next pebbl command, never inside the hook.
    writeHook('post-merge', REBUILD_HOOK_SCRIPT);
    writeHook('post-checkout', REBUILD_HOOK_SCRIPT);
    console.log('Installed post-merge and post-checkout rebuild hooks');
  } else {
    console.log('No .git/ found — skipping git hooks (run inside a git repo to enable).');
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

  // .gitattributes — install the union merge driver for events.jsonl.
  // MANDATORY for clean multi-contributor merge: without `merge=union`,
  // two appends after the same last line conflict. Idempotent: only add
  // the line if it isn't already present (don't duplicate on re-init).
  const gitattributes = path.join(cwd, '.gitattributes');
  const attrLine = '.pebbl/events.jsonl merge=union';
  if (fs.existsSync(gitattributes)) {
    const existing = fs.readFileSync(gitattributes, 'utf8');
    if (!existing.split('\n').some((l) => l.trim() === attrLine)) {
      const sep = existing.endsWith('\n') || existing === '' ? '' : '\n';
      fs.appendFileSync(gitattributes, `${sep}${attrLine}\n`);
      console.log('Added events.jsonl merge=union to .gitattributes');
    }
  } else {
    fs.writeFileSync(gitattributes, `${attrLine}\n`);
    console.log('Created .gitattributes with events.jsonl merge=union');
  }

  // AGENTS.md — create or append, never overwrite user content outside the sentinels
  const agentMd = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentMd)) {
    fs.writeFileSync(agentMd, AGENT_STANDALONE);
    console.log('Created AGENTS.md with pebbl guidance');
  } else {
    const existing = fs.readFileSync(agentMd, 'utf8');
    const hasNewBlock = existing.includes(AGENT_BEGIN);
    const hasOldBlock = existing.includes('Pebbl — Project Memory Protocol');
    if (!hasNewBlock && !hasOldBlock) {
      fs.appendFileSync(agentMd, AGENT_SECTION);
      console.log('Appended pebbl guidance to existing AGENTS.md');
    } else {
      console.log('AGENTS.md already contains pebbl guidance — run `pebbl upgrade` to refresh');
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

  // Create empty narrative.md placeholder
  const narrativePath = path.join(pebblDir, 'narrative.md');
  if (!fs.existsSync(narrativePath)) {
    fs.writeFileSync(narrativePath, '# Project Narrative\n');
  }

  console.log('');
  console.log('This project needs a narrative — a short description of what');
  console.log('it does and key architectural context. This helps agents');
  console.log('understand the project without reading all decisions.');
  console.log('');
  console.log('Set one with:  pebbl narrative "Your description here"');

  console.log('\npebbl ready. Run `pebbl log "[your first note]"` to start stacking.');
}

module.exports = init;
module.exports.AGENT_SECTION = AGENT_SECTION;
module.exports.AGENT_BEGIN = AGENT_BEGIN;
module.exports.AGENT_END = AGENT_END;
