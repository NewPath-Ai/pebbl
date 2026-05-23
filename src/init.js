'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { qmdAvailable, qmdCollectionCreate } = require('./qmd');

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

### Logging (use --cat always)

| Category    | When to use |
|-------------|-------------|
| decision    | Choices made, rationale, constraints, trade-offs |
| structure   | Component boundaries, module topology, ownership |
| pattern     | Conventions, coding standards, design patterns |
| data        | Models, schemas, storage choices, data flow |
| integration | APIs, contracts, cross-component interfaces |
| quality     | Perf targets, SLAs, security posture |

\`\`\`bash
pebbl log "message" --cat decision --topic auth
pebbl log "message" --cat structure --topic clipforge,hammy
pebbl log "message" --cat decision --tier signal  # force permanent tier
\`\`\`

### End of every session
\`\`\`bash
pebbl log "[session] one-line summary of what changed" --source agent --tier fleeting
\`\`\`

### Correcting a past entry
\`\`\`bash
pebbl log "new decision" --cat decision --corrects <id>
\`\`\`

### Compaction (when notified)
\`\`\`bash
pebbl compact --preview
pebbl compact --execute --resolve 12:signal,15:rollup,18:skip
\`\`\`

### What to log
- Architecture decisions and why
- Component boundaries and ownership
- Conventions and patterns adopted
- Constraints and failed approaches

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

  // Rubric
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, `# Pebbl classification rubric — edit to tune auto-tagging
# Rules are evaluated top-to-bottom; first match wins.
# Pattern is matched case-insensitively against the entry message.

rules:
  - pattern: "\\[session\\]"
    category: uncategorized
    tier: fleeting

  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint"
    category: decision
    tier: signal

  - pattern: "module|component|boundary|owns|ownership|depends on|architecture"
    category: structure
    tier: signal

  - pattern: "convention|pattern|standard|always|never|rule:|style"
    category: pattern
    tier: signal

  - pattern: "schema|model|table|column|migration|data flow|storage"
    category: data
    tier: detail

  - pattern: "api|endpoint|contract|integration|webhook|external"
    category: integration
    tier: detail

  - pattern: "perf|latency|SLA|security|posture|target|benchmark"
    category: quality
    tier: detail
`);
    console.log('Created rubric.yml');
  }

  // Config
  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `compaction:
  threshold: 10
  fleeting_retention: 30
`);
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
};
