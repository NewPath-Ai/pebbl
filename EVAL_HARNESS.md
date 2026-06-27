# Pebbl Eval Harness

You are an orchestrator testing whether pebbl (a project memory CLI) works correctly
when an AI agent uses it during real work. You simulate a user giving high-level
directions to worker agents, then evaluate pebbl's output by querying SQLite.

**Your roles:**
1. **Setup** — scaffold the test repo and init pebbl
2. **User simulator** — give worker agents tasks via intent, not implementation details
3. **Evaluator** — query `.pebbl/db.sqlite` to score results after each phase

**You do NOT use pebbl yourself.** You only read `.pebbl/db.sqlite` to score.

---

## Setup (do this first)

```bash
mkdir -p /Users/ashley/Documents/pebbl-eval && cd /Users/ashley/Documents/pebbl-eval
git init
pebbl init
```

Verify: `.pebbl/` exists with `db.sqlite`, `rubric.yml`, `config.yml`, `manual-logs.md`.

Copy the AGENTS.md from ashley-forge as a starting point (it has the pebbl protocol):
```bash
cp /Users/ashley/Documents/ashley-forge/AGENTS.md /Users/ashley/Documents/pebbl-eval/AGENTS.md
```

---

## Phase 1: Worker Agent — Build

Spawn a subagent with this prompt:

```
You are building an app in /Users/ashley/Documents/pebbl-eval.

The user wants: a note-taking tool called "qnotes" — think Bear app but CLI-based.
Notes are markdown files stored on disk. It should feel like a proper database — fast,
searchable, well-organized — but the underlying storage is just markdown files.

Core requirements (from the user, non-negotiable):
- Notes stored as markdown files (one file per note)
- A full-text search index over the notes (your choice of approach)
- A markdown viewer/renderer for reading notes in the terminal (render headings,
  bold, lists, code blocks — not just cat the raw file)
- Commands: add, list, search, show (with rendered output), edit
- Node.js, CommonJS, no build step

Everything else is your call — directory structure, metadata approach, CLI parsing,
how the viewer renders, how notes are named/organized. You are the engineer. Make
decisions, commit to them, and document your reasoning.

Read AGENTS.md in this repo and follow the pebbl protocol throughout your work.
Log every design decision with pebbl. At the end, log a session summary.

Build a working MVP that feels good to use.
```

### If the worker asks questions

The worker may come back with questions. Be prescriptive on product intent,
leave implementation to them:

| Worker asks | You respond with |
|---|---|
| "How should I store notes?" | "Markdown files, one per note. That's a hard requirement." |
| "Should I use a database or files?" | "Markdown files ARE the database. Like Bear — files on disk but it feels like an app." |
| "What fields/metadata should a note have?" | "Title, tags, created date at minimum. I want to be able to organize and filter." |
| "How should search work?" | "Full-text search over the markdown files — that's the whole point. Search by content." |
| "What markdown rendering library?" | "Your call, pick something that looks good in the terminal. I want headings, bold, lists, code blocks to render properly." |
| "How should notes be named on disk?" | "You decide — whatever makes the system feel solid and avoids conflicts." |
| "Should I use library X for Y?" | "Your call as the engineer, just keep dependencies minimal and document why." |
| Any other implementation question | "You're the engineer, pick what makes sense and log why to pebbl" |

The goal: product requirements are clear (markdown storage, full-text search, terminal viewer),
but the worker makes all engineering decisions and logs them to pebbl.

After the subagent finishes, run Phase 1 scoring.

---

## Phase 1 Scoring

```bash
cd /Users/ashley/Documents/pebbl-eval

# TEST 1.1: Did the agent create any pebbl entries?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE source != 'hook';"
# PASS: >= 3 entries. FAIL: 0-2 entries (agent ignored pebbl).

# TEST 1.2: Did the agent use --cat flags?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE category != 'uncategorized' AND source != 'hook';"
# PASS: >= 2 categorized entries. FAIL: all uncategorized.

# TEST 1.3: Did the agent use --topic flags?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE topics IS NOT NULL AND topics != '' AND source != 'hook';"
# PASS: >= 2 entries with topics. FAIL: no topics used.

# TEST 1.4: Did the agent log a session summary?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE message LIKE '%[session]%';"
# PASS: >= 1. FAIL: 0.

# TEST 1.5: Are decisions logged as decisions?
sqlite3 .pebbl/db.sqlite "SELECT id, category, tier, message FROM logs WHERE category = 'decision';"
# PASS: at least 1 decision entry that describes an actual choice.
# FAIL: no decisions, or decisions are generic/meaningless.

# TEST 1.6: Did the app actually get built?
ls /Users/ashley/Documents/pebbl-eval/bin/ 2>/dev/null || ls /Users/ashley/Documents/pebbl-eval/*.js 2>/dev/null
# PASS: CLI exists. FAIL: nothing built.

# TEST 1.7: Does the markdown viewer render (not just raw cat)?
# Add a test note with formatting, then show it
# PASS: headings, bold, lists render with formatting/color. FAIL: raw markdown dumped.

# TEST 1.8: Is SQLite FTS5 integrated for search?
grep -rE "fts5Available|searchFts5|buildFtsIndex" /Users/ashley/Documents/pebbl-eval/src/ /Users/ashley/Documents/pebbl-eval/*.js 2>/dev/null
# PASS: FTS5 search referenced in search code. FAIL: no FTS5 integration.

# FULL DUMP (for review):
sqlite3 .pebbl/db.sqlite "SELECT id, category, tier, source, topics, substr(message,1,100) FROM logs ORDER BY id;"
```

Record each test as PASS/FAIL with actual values.

---

## Phase 2: Worker Agent — Handoff

This tests the core value prop: does memory survive across agent sessions?

Spawn a **new** subagent (fresh context, no memory of Phase 1):

```
You are continuing work on a note-taking CLI called "qnotes" in /Users/ashley/Documents/pebbl-eval.

The user wants two new features:
1. Delete — remove a note by name
2. Tag filtering — list notes filtered by tag (e.g. qnotes list --tag work)

And one improvement:
3. The markdown viewer could look better — add color/styling if it's not already polished

Read AGENTS.md in this repo and follow the pebbl protocol throughout your work.

CRITICAL: This project was started by a previous engineer. Before writing any code,
use pebbl context and pebbl search to understand what was already built and what
decisions were already made. Do NOT re-decide things that were already decided.
Follow existing patterns and conventions.

You are the engineer. Make technical decisions yourself for the new features.
Log decisions to pebbl. Log a session summary at the end.
```

### If the worker asks questions

| Worker asks | You respond with |
|---|---|
| "How should delete work?" | "By note title or filename, simple and direct" |
| "Should delete have confirmation?" | "No, keep it simple. Maybe just print what got deleted." |
| "How should tag filtering work?" | "Like Bear — I pick a tag, I see all notes with that tag" |
| "Should I change the storage format?" | "No. Check pebbl for what was decided. Keep it consistent." |
| "What colors/styling for the viewer?" | "Your call — just make it look good in the terminal" |
| Any other question | "Check what the previous engineer decided, follow that pattern" |

After the subagent finishes, run Phase 2 scoring.

---

## Phase 2 Scoring

```bash
cd /Users/ashley/Documents/pebbl-eval

# TEST 2.1: Consistency — did the agent follow Phase 1 patterns?
# Check: does the new code use the same storage format, directory structure,
# and conventions as Phase 1? If the agent re-chose a storage format or
# restructured the app, the handoff failed.
# Read the code and compare to Phase 1 decisions in pebbl:
sqlite3 .pebbl/db.sqlite "SELECT category, message FROM logs WHERE category = 'decision' ORDER BY id;"
# PASS: Phase 2 decisions extend Phase 1, no contradictions.
# FAIL: agent re-decided storage format or ignored prior decisions.

# TEST 2.2: Did the agent add new entries?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE source != 'hook';"
# Compare to Phase 1 count. PASS: count increased by >= 2. FAIL: no new entries.

# TEST 2.3: Session summary logged?
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE message LIKE '%[session]%';"
# PASS: >= 2 (one from each phase). FAIL: still just 1.

# TEST 2.4: Does the delete command work?
# Create a test note using the app's add command, then delete it.
# PASS: note removed. FAIL: command errors or note still exists.

# TEST 2.5: Does tag filtering work?
# PASS: filtered list shows only matching notes. FAIL: errors or shows all.

# FULL DUMP:
sqlite3 .pebbl/db.sqlite "SELECT id, category, tier, source, topics, substr(message,1,100) FROM logs ORDER BY id;"
```

---

## Phase 3: Compaction

Tests the compaction pipeline. No subagent needed — run directly.

```bash
cd /Users/ashley/Documents/pebbl-eval

# Seed 12 detail entries on the same topic to trigger compaction
for i in $(seq 1 12); do
  pebbl log "search tuning iteration $i: adjusted ranking weight" --cat quality --topic search
done

# TEST 3.1: Compaction notification appears
pebbl context 2>&1 | grep -i "compact"
# PASS: notification with "ready for compaction". FAIL: no notification.

# TEST 3.2: Preview shows the group
pebbl compact --preview 2>&1
# PASS: shows quality/search group with 12 entries and a proposed rollup.

# TEST 3.3: Execute compaction
pebbl compact --execute
# PASS: prints "Compacted 12 detail entries into rollups."

# TEST 3.4: Archive exists
ls .pebbl/archive/
cat .pebbl/archive/*.txt
# PASS: archive file exists with the 12 original entries.

# TEST 3.5: Rollup in database
sqlite3 .pebbl/db.sqlite "SELECT message FROM logs WHERE message LIKE '%[rollup]%';"
# PASS: rollup entry exists. FAIL: no rollup.

# TEST 3.6: Originals gone
sqlite3 .pebbl/db.sqlite "SELECT COUNT(*) FROM logs WHERE message LIKE '%search tuning iteration%';"
# PASS: 0 (all compacted). FAIL: entries still exist.

# TEST 3.7: Context is cleaner
pebbl context
# PASS: shows rollup instead of 12 individual entries.
```

---

## Phase 4: Auto-classification accuracy

Tests the rubric without --cat flags. Run directly, no subagent.

```bash
cd /Users/ashley/Documents/pebbl-eval

pebbl log "chose SQLite over JSON files for metadata"
pebbl log "notes module depends on search module for indexing"
pebbl log "always use ISO 8601 dates in frontmatter"
pebbl log "schema uses title, tags, created, body columns"
pebbl log "search endpoint returns top 5 matches"
pebbl log "response time target is under 200ms for search"
pebbl log "random note that matches nothing specific"

# TEST 4.1: Classification accuracy
sqlite3 .pebbl/db.sqlite "SELECT category, tier, message FROM logs ORDER BY id DESC LIMIT 7;"
# Expected:
#   "chose SQLite..."        → decision / signal
#   "notes module depends..." → structure / signal
#   "always use ISO 8601..."  → pattern / signal
#   "schema uses title..."    → data / detail
#   "search endpoint..."      → integration / detail
#   "response time target..." → quality / detail
#   "random note..."          → uncategorized / detail
#
# PASS: >= 5 of 7 correct. FAIL: < 5 correct.
```

---

## Reporting

After all phases, produce a summary table:

```
| Test | Description                          | Result | Actual Value |
|------|--------------------------------------|--------|--------------|
| 1.1  | Agent created pebbl entries           |        |              |
| 1.2  | Agent used --cat flags                |        |              |
| 1.3  | Agent used --topic flags              |        |              |
| 1.4  | Session summary logged                |        |              |
| 1.5  | Decisions logged as decisions         |        |              |
| 1.6  | App actually built                    |        |              |
| 1.7  | Markdown viewer renders formatted     |        |              |
| 1.8  | FTS5 integrated for search            |        |              |
| 2.1  | Phase 2 follows Phase 1 patterns      |        |              |
| 2.2  | New entries added in Phase 2          |        |              |
| 2.3  | Two session summaries exist           |        |              |
| 2.4  | Delete command works                  |        |              |
| 2.5  | Tag filtering works                   |        |              |
| 3.1  | Compaction notification               |        |              |
| 3.2  | Preview shows groups                  |        |              |
| 3.3  | Execute compaction                    |        |              |
| 3.4  | Archive file exists                   |        |              |
| 3.5  | Rollup in database                    |        |              |
| 3.6  | Originals deleted                     |        |              |
| 3.7  | Context cleaner after compaction      |        |              |
| 4.1  | Auto-classification accuracy (>= 5/7) |        |              |
```

Include the full SQLite dump at the end for manual review.
Score: X/21 tests passed.
