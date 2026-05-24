'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');
const { DEFAULT_RUBRIC, DEFAULT_CONFIG } = require('./rubric');

const AGENT_SECTION = `
## Pebbl — Project Memory Protocol

Pebbl stores architecture decisions, conventions, and component facts for this codebase.
Agents use it to avoid burning tokens re-discovering what's already known.

### Start of every session
\`\`\`bash
pebbl context                    # recent entries, all tiers
pebbl context --topic <area>     # entries for a specific component
pebbl search "topic" --cat decision  # search decisions before proposing an approach
\`\`\`

### Logging — ALWAYS use --cat and --topic

Every \`pebbl log\` call **must** include \`--cat\` and \`--topic\`. Entries without
these flags are hard to find and impossible to filter.

| Category    | When to use |
|-------------|-------------|
| decision    | Choices made, rationale, constraints, trade-offs |
| structure   | Component boundaries, module topology, ownership |
| pattern     | Conventions, coding standards, design patterns |
| data        | Models, schemas, storage choices, data flow |
| integration | APIs, contracts, cross-component interfaces |
| quality     | Perf targets, SLAs, security posture |

\`\`\`bash
pebbl log "chose Redis for caching" --cat decision --topic auth
pebbl log "modules split into store and renderer" --cat structure --topic notes,renderer
pebbl log "all dates use ISO 8601" --cat pattern --topic conventions
\`\`\`

### End of every session — required format

Log a session summary using exactly this format (the \`[session]\` prefix is required
for compaction to identify session entries):
\`\`\`bash
pebbl log "[session] built add/list/search commands, chose markdown storage" --cat decision --topic <main-area-worked-on> --source agent --tier fleeting
\`\`\`

### Correcting a past entry
\`\`\`bash
pebbl log "switched from Redis to Postgres" --cat decision --topic auth --corrects <id>
\`\`\`

### Compaction (when notified)
\`\`\`bash
pebbl compact --preview
pebbl compact --execute --resolve 12:signal,15:rollup,18:skip
\`\`\`

### What to log
- Architecture decisions and why (--cat decision)
- Component boundaries and ownership (--cat structure)
- Conventions and patterns adopted (--cat pattern)
- Constraints and failed approaches (--cat decision)

### Entry quality — always explain WHY

The most important part of a decision entry is the rationale. Future agents need to
understand WHY a choice was made, not just WHAT was chosen. Without rationale, agents
may revert decisions or reintroduce already-solved problems.

Bad (mechanics only):
\`\`\`bash
pebbl log "threshold is 0.5, weight is 0.6, W*fit + (1-W)*scorecard formula"
\`\`\`
This reads like a spec sheet. A future agent sees "0.5" and has no idea if it's
arbitrary, empirical, or structural. It will guess or change it.

Good (rationale included):
\`\`\`bash
pebbl log "threshold is 0.5 because Professional Services touches every industry at
0.2-0.4, which is too weak for meaningful knowledge transfer"
\`\`\`
The WHY is included. The future agent knows what problem this solves.

Rule of thumb: if your entry reads like config documentation, you forgot the rationale.
Use "because", "to prevent", "so that", or "the problem is" to connect mechanics to
motivation. Entries that only list parameters (default, threshold, weight, score, blend,
config, param, formula) with numbers get auto-tagged as detail tier — they will
persist but are flagged as lower-authority than signal entries with proper rationale.

### What not to log
- Routine code changes (git hook captures those)
- Anything obvious from reading the code
`;

const AGENT_STANDALONE = `# Agent Guidelines\n${AGENT_SECTION}`;


const HOOK_SCRIPT = `#!/bin/sh
HASH=$(git log -1 --pretty=%H)
MESSAGE=$(git log -1 --pretty=%B)
FILES=$(git diff-tree --no-commit-id -r --name-only HEAD | tr '\\n' ',')
pebbl log-commit "$HASH" "$MESSAGE" "$FILES"
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
}

module.exports = init;
module.exports.AGENT_SECTION = AGENT_SECTION;
