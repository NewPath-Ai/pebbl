'use strict';

const CATEGORIES = `Categories (--cat):
  decision     a choice with rationale: trade-offs, constraints, failed alternatives
  structure    module boundaries, dependency direction, ownership
  pattern      a convention that applies repeatedly (naming, error shapes, async rules)
  data         schemas, field meanings, formats, storage layout
  integration  external systems, contracts, auth flows, API shapes
  quality      targets, measurements, SLAs, eval results

Omitting --cat triggers .pebbl/rubric.yml auto-classification. Prefer explicit --cat.`;

const TIERS = `Tiers (--tier):
  foundation   permanent; never compacted; project-wide truths
  component    kept until threshold; subsystem-level decisions; compacts at 15+ entries on a topic
  detail       kept until threshold; narrow facts; compacts at 10+ entries on a topic
  fleeting     ephemeral; auto-deleted after 30 days

Default tier is 'detail'. --scope foundation promotes to foundation tier in one flag.
Entries that read as parameter dumps (numbers with no "because") auto-demote to detail
regardless of --tier.`;

const TOPICS = {
  categories: CATEGORIES,
  tiers: TIERS,
  compaction: `Compaction:
  pebbl compact --preview              show candidate groups ready for compaction
  pebbl compact --execute              merge them
  pebbl compact --resolve <id:action>  resolve ambiguous entries

--resolve actions:
  foundation   promote the entry to foundation tier
  rollup       merge into a summary entry
  skip         leave as-is

Rules:
  fleeting entries are pruned after 30 days
  foundation entries are always kept
  only run compact when 'pebbl context' flags entries as ready`,
  'file-layout': `File layout (.pebbl/):
  db.sqlite          authoritative store — source of truth
  rubric.yml         auto-classification rules
  config.yml         thresholds, defaults
  manual-logs.md     markdown projection of logs (qmd-indexed)
  commit-log.md      auto-captured git commits (qmd-indexed)
  handoffs.md        materialized handoffs (one block per item)
  narrative.md       project narrative
  archive/           compacted entries
  qmd/               quote-aware full-text index

db.sqlite is the source of truth. The .md files are projections — regenerable,
safe to delete (they'll re-materialize on the next pebbl write).`,
  'entry-ids': `Entry IDs:
  Every log entry has an integer ID, printed at log time.
  Find an ID with 'pebbl search' or 'pebbl context'.

  Use IDs with:
    --relates <id>    link this entry to a related one (bidirectional reference)
    --corrects <id>   supersede a prior entry — the old one stays searchable
                      but is marked as corrected
    --resolve <id:action>  (compact) decide what to do with an ambiguous entry`,
};

const SUBCOMMANDS = {
  init: `pebbl init — set up .pebbl/ in current project

Creates .pebbl/ with sqlite store, writes PEBBL.md at project root,
and adds a pebbl block (sentinel-marked) to AGENTS.md if present.
`,

  log: `pebbl log "[message]" — record a decision or note

Flags:
  --cat <category>     ${'decision|structure|pattern|data|integration|quality'}
  --topic <topic>      free-form topic (e.g. "auth,api")
  --tier <tier>        foundation|component|detail|fleeting
  --scope foundation   shortcut: promote to foundation tier
  --source <source>    human|agent|hook (default: human)
  --relates <id>       link to a related entry ID
  --corrects <id>      supersede a prior entry (old entry stays searchable, marked corrected)

${CATEGORIES}

${TIERS}

Examples:
  pebbl log "threshold is 0.5 because Professional Services touches everything at 0.2" --cat decision
  pebbl log "uses SQLite for the log store" --cat structure --tier foundation

Tip: if you omit --cat, the rubric tries to classify. If it falls
back to 'uncategorized', pebbl prints a loud warning.
`,

  search: `pebbl search "[query]" — semantic + keyword search

Flags:
  --cat <category>     filter by category
  --topic <topic>      filter by topic

${CATEGORIES}
`,

  context: `pebbl context — recent entries with rationale warnings & git context

Flags:
  --cat <category>     filter by category
  --topic <topic>      filter by topic
`,

  handoff: `pebbl handoff "[summary]" — create a session handoff for the next agent

Flags:
  --done <items>       semicolon-separated completed items
  --todo <items>       semicolon-separated remaining items
  --blocked <items>    semicolon-separated blockers
  --topic <topic>      free-form topic
  --source <source>    human|agent (default: agent)
  --latest             show the most recent handoff
  --list               list recent handoffs
  --close [id]         close the open handoff; with id, close that specific handoff

Handoffs materialize one block per --done/--todo/--blocked item into
handoffs.md so each item is independently searchable.
`,

  narrative: `pebbl narrative — view or set the project narrative

  pebbl narrative              show current narrative
  pebbl narrative "..."        set narrative description

Flags:
  --show               show current narrative
  --generate           guide on writing a narrative from foundation entries
`,

  compact: `pebbl compact — compact entries on a topic

Flags:
  --preview                show groups ready for compaction
  --execute                execute compaction
  --resolve <id:action,...>  resolve ambiguous entries

${TIERS}

fleeting entries are pruned; foundation entries are always kept.
`,

  feedback: `pebbl feedback "[message]" — drop feedback when pebbl misbehaves here

Flags:
  --list               review feedback recorded in this repo
`,

  upgrade: `pebbl upgrade — update .pebbl/ to the latest version

Auto-migrates the AGENTS.md pebbl block to the current sentinel format
and overwrites PEBBL.md at project root.
`,

  eject: `pebbl eject — remove pebbl config from this project

Strips the pebbl sentinel block from AGENTS.md and removes PEBBL.md.
Leaves .pebbl/ in place (delete it yourself if you want a clean slate).
`,

  'log-commit': `pebbl log-commit — called by git post-commit hook
Not meant for direct invocation.
`,
};

const TOPLEVEL = `pebbl — local project memory

Usage:
  pebbl <command> [args]
  pebbl <command> --help        details for one command
  pebbl help <topic>            topic guide (${Object.keys(TOPICS).join(', ')})

Commands:
  init        set up .pebbl/ in current project
  log         record a decision or note
  search      semantic + keyword search
  context     recent entries with git context
  handoff     create a session handoff
  narrative   view or set project narrative
  compact     compact entries
  feedback    record feedback about pebbl
  upgrade     update .pebbl/ to latest
  eject       remove pebbl config
  log-commit  (git hook only)
`;

function printToplevel() {
  console.log(TOPLEVEL);
}

function printSubcommand(name) {
  const text = SUBCOMMANDS[name];
  if (!text) {
    console.error(`pebbl: no help for '${name}'`);
    process.exit(1);
  }
  console.log(text);
}

function printTopic(name) {
  const text = TOPICS[name];
  if (!text) {
    console.error(`pebbl help: unknown topic '${name}'`);
    console.error(`  topics: ${Object.keys(TOPICS).join(', ')}`);
    process.exit(1);
  }
  console.log(text);
}

module.exports = { printToplevel, printSubcommand, printTopic, SUBCOMMANDS, TOPICS };
