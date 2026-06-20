'use strict';

const CATEGORIES = `Categories (--cat):
  decision     a choice with rationale: trade-offs, constraints, failed alternatives
  structure    module boundaries, dependency direction, ownership
  pattern      a convention that applies repeatedly (naming, error shapes, async rules)
  data         schemas, field meanings, formats, storage layout
  integration  external systems, contracts, auth flows, API shapes
  quality      targets, measurements, SLAs, eval results
  correction   something went wrong and what was learned: failures, regressions, parked work

Corrections pair with --corrects <id>: the category says "this entry records
a failure"; the flag links it to the entry it supersedes. Use either or both.

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
  mirror/<machine>/  other machines' synced memory (read-only — the sync job
                     owns it; context, search, and handoff --list show these
                     entries tagged [machine])

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
  check: `pebbl check — flag entries that cite files that no longer exist

Scans memory for high-confidence path references (a slash + a known
extension) and reports any entry whose cited file is missing from the repo,
highest-tier and newest first. Report only — never edits or deletes; it
points you at \`--corrects\` so you can supersede a wrong entry yourself.

Flags:
  --deep    also grep the repo for backtick-wrapped symbols (slower, opt-in)
`,
  doctor: `pebbl doctor — report-only memory-health check (memory vs memory)

Surfaces CURRENT beliefs that are probably wrong so you can correct them,
grouped into three dimensions: contradictions (two unlinked current entries on
a shared topic with high term-overlap), staleness (an old entry nothing newer
reinforces — low confidence), and missing artifact (reuses \`check\`). Report
only — never edits; it points you at \`--corrects\`. Conservative and capped by
default; a clean store prints a single reassuring line.

Flags:
  --json    emit candidates as a JSON array (for tooling)
  --all     widen past the conservative caps / thresholds
  --deep    also grep the repo for backtick-wrapped symbols (same as check)
`,
  'scan-commits': `pebbl scan-commits — nudge to log decisions never captured

Scans recent commits for decision-shaped changes (the rubric's decision-verb
patterns) that have NO near-matching entry, and prints a ready-to-edit
\`pebbl log "..." --cat decision\` line for each. NEVER auto-logs — every line
is a suggestion you confirm. Dedupes against existing entries so an
already-logged decision is not re-nudged.

Flags:
  --n <count>    how many recent commits to scan (default 30)
`,
  'audit-history': `pebbl audit-history — one-time read-only scan of committed .md history

Walks ALL committed .md blobs across \`git log --all\` (not just the working
tree) and flags three leak classes that append-only memory could never
un-leak once shared: non-RFC1918 IPs and host:port pairs, credential file
paths (.env / .claude-env / /etc/*-bot.env), token shapes, and PII names from
the repo's anon name-map. Emits a per-finding rotation checklist (file,
commit, line, class, ROTATE/ACCEPT prompt).

READ-ONLY: it never edits, redacts, force-pushes, or stages anything. A real
leaked secret must be ROTATED at its source — this tool only surfaces it.
Run it before taking any store \`--shared\`, and pair it with the pre-commit /
pre-push gate that scans every new commit/push going forward.
`,
  init: `pebbl init — set up .pebbl/ in current project

Creates .pebbl/ with sqlite store, writes PEBBL.md at project root,
and adds a pebbl block (sentinel-marked) to AGENTS.md if present.
`,

  log: `pebbl log "[message]" — record a decision or note

Flags:
  --cat <category>     ${'decision|structure|pattern|data|integration|quality|correction'}
  --topic <topic>      free-form topic (e.g. "auth,api")
  --tier <tier>        foundation|component|detail|fleeting
  --scope foundation   shortcut: promote to foundation tier
  --source <source>    human|agent|hook (default: human)
  --relates <id>       link to a related entry ID
  --corrects <id>      supersede a prior entry (old entry stays searchable, marked corrected)
  --share              publish a foundation entry to the SHARED (committed) log
                       even on a public remote. Foundation entries are
                       PRIVATE-BY-DEFAULT on a PUBLIC remote (they land in the
                       gitignored events.local.jsonl); --share opts one into
                       the committed events.jsonl. On a private remote
                       foundation shares freely and --share is a no-op.

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
  --include-archive    also show compacted/archived history (ranked last)

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
  --open               list every open handoff (alias: --list-open)
  --list-open          list every open handoff
  --close [id]         close an open handoff (a specific id if given);
                       session detail entries become compaction-eligible;
                       done/todo/blocked stay searchable in handoffs.md

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

  rebuild: `pebbl rebuild — force a rebuild of the view from events.jsonl

Re-folds the canonical .pebbl/events.jsonl into the disposable view
(view.sqlite + the markdown projections) and refreshes the qmd index in
the background. The view is normally kept current automatically on every
command, so you rarely need this — reach for it after hand-editing or
repairing events.jsonl, or to force a refresh in a script. Runs under the
per-store lock so it can't interleave with a concurrent write.
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

  'privacy-scan': `pebbl privacy-scan — called by the pre-commit / pre-push git hooks

Scans staged (\`--staged\`) or to-be-pushed (\`--push\`) content for the three
leak classes (non-RFC1918 IP+port, credential file paths, denylisted PII
names) plus token shapes, and exits non-zero on a hit to refuse the
commit/push. On \`--push\` to a PUBLIC remote it also enforces the hard gate:
a clean full-history .md scan must pass. Not meant for direct invocation;
\`PEBBL_SKIP_SCAN=1\` bypasses it. See also: pebbl audit-history.
`,

  'migrate-to-events': `pebbl migrate-to-events — lift db.sqlite into events.jsonl

Reads the binary store once in (timestamp, id) order, mints time-seeded
ULIDs, builds the oldInt->ULID map BEFORE remapping any reference, and
remaps every foreign-key site (logs.relates_to, logs.corrects,
handoffs.promoted_log_id, and per-element session_entries / session_commits)
into append-only events — aborting the whole store if any reference dangles.

DRY-RUN by default: prints the audit + plan and writes nothing. Idempotent:
a second run on an already-migrated store is a safe no-op.

Flags:
  --apply        actually migrate: write events.jsonl and rename
  --write        db.sqlite -> legacy-db.sqlite (rollback artifact)

Without a flag, nothing on disk changes. db.sqlite is NEVER deleted.
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
  doctor      report-only memory-health check (contradictions, staleness, missing files)
  audit-history  read-only scan of committed .md history for leaks
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
