# How Pebbl Works

This is the deep dive. If you just want to use pebbl, the [README](README.md) and `pebbl help` are enough. Read this when you want to understand *why* pebbl is built the way it is, or when you want to extend it.

## The problem pebbl solves

A codebase carries two kinds of context. The first kind lives in the code: function names, types, comments, structure. Any agent can read it. The second kind doesn't: why you chose Postgres over MongoDB, which approach you tried and abandoned, the constraint that's not visible until you violate it.

That second kind usually lives in someone's head. Sometimes in a wiki nobody updates. When the head leaves the room, or the agent's context window resets, it's gone. The next person rediscovers it the hard way.

Pebbl is a place to put the second kind of context. Local, searchable, durable across sessions.

## Mental model

Think of pebbl as four interlocking ideas. Hold all four in your head and the commands stop being arbitrary.

**Entries are atomic.** Every log call writes one row. The row has a message, a category, a topic, a tier, and an ID. That's it. Entries don't nest, don't reference each other implicitly, don't get edited later. If a decision changes, you write a new entry with `--corrects <old-id>` and both stay searchable. History is preserved.

**Sessions have boundaries.** An agent works for a while, then stops. Pebbl doesn't track sessions explicitly, but it expects them. The session boundary is when you create a handoff. Everything logged before the handoff was part of the session that's ending; everything after is the next session.

**Handoffs are structured.** A handoff has a summary, a list of done items, a list of todo items, and optionally blockers. Each item is its own searchable block when the handoff closes. The handoff lives at the top of `pebbl context` until someone runs `pebbl handoff --close`, signaling they picked up the remaining work.

**Tiers decay differently.** Pebbl's database would grow forever if every entry stayed. So entries have tiers, and tiers compact at different thresholds. Foundation entries (architecture truths) never compact. Detail entries roll up when there are too many on one topic. Fleeting entries vanish after 30 days. The shape of memory matches the shape of how decisions actually age.

## The lifecycle

A normal session looks like this:

1. Agent starts. Runs `pebbl context`. Sees the project narrative, any open handoff from the previous session, recent entries, and a topic summary.
2. Before touching an area, runs `pebbl search "<area>"`. Sees prior decisions, so it doesn't re-litigate them.
3. As work happens, the agent calls `pebbl log` with `--cat` and `--topic`. Decisions go in. Failed approaches go in. Each entry includes the *why*, not just the *what*.
4. When the session ends, the agent calls `pebbl handoff "<summary>" --done "..." --todo "..."`. The handoff is now visible at the top of every future `pebbl context` call.
5. The next agent comes in, runs `pebbl context`, sees the open handoff. Does the todo items. Runs `pebbl handoff --close` to mark them done.

That loop is the whole pebbl workflow. Everything else (compaction, narrative, correction) is maintenance around it.

## Why categories

Categories aren't taxonomy for its own sake. They're filters that change what you ask. When you're about to propose an approach, you want to see prior *decisions* in that area, not the data schema. So you run `pebbl search "auth" --cat decision`. The category filter is the difference between "show me everything" (noisy) and "show me choices that might constrain me" (actionable).

The six categories cover the kinds of things that come up repeatedly in codebases:

- **decision**: choices with rationale; what's most often searched before proposing changes
- **structure**: module boundaries, ownership; useful when adding new code
- **pattern**: repeating conventions; the things linters can't enforce
- **data**: schemas, formats; the contracts between modules
- **integration**: external systems; the parts that bite when they change
- **quality**: targets and measurements; the numbers that gate releases

Run `pebbl help categories` for the canonical list.

## Why tiers

Tiers solve a problem: a project that runs for a year accumulates thousands of entries, most of which are no longer interesting. If pebbl returned everything on every query, it'd be useless within months.

The tier system makes memory decay gracefully:

- **Foundation** entries are forever. Things like "this project is SQLite-based, never propose another database." When a new agent reads `pebbl context`, foundation entries show up regardless of recency.
- **Component** entries are kept until there are 15+ on a single topic. At that point pebbl suggests compacting them. Compaction merges related entries into a summary, archiving the originals.
- **Detail** entries compact at 10+ on a topic. Same idea, lower threshold because detail entries are noisier.
- **Fleeting** entries auto-delete after 30 days. For session summaries, scratch notes, things you want available right now but don't care about next month.

Most entries default to `detail`. You promote with `--scope foundation` when you're recording something project-defining. There's also an auto-demotion rule: if pebbl detects an entry that looks like a parameter dump (numbers without "because"), it forces it to `detail` tier so it doesn't accumulate authority it didn't earn.

## Architecture

Pebbl is small. Five concepts hold the whole system together.

### SQLite is the source of truth

Everything lives in `.pebbl/db.sqlite`. Entries, handoffs, topics, relations. If you delete every other file in `.pebbl/`, pebbl can rebuild from the database. The `better-sqlite3` driver gives synchronous queries with no async ceremony, which keeps the CLI snappy.

### Markdown files are projections

The markdown files in `.pebbl/` (`manual-logs.md`, `commit-log.md`, `handoffs.md`) are derived. Pebbl regenerates them on writes. They exist so humans can read memory directly in an editor. The projection pattern means SQL stays the contract and markdown stays the surface.

Deleting a projection is safe. It comes back the next time pebbl writes.

### SQLite FTS5 handles search

Search runs entirely inside SQLite. Pebbl builds an FTS5 full-text index over the stored entries and ranks matches with BM25, so `pebbl search "caching strategy"` returns the relevant entries enriched with database metadata (category, tier, IDs). There's no external tool, binary, or model — the only native dependency is `better-sqlite3`. If FTS5 isn't available on the SQLite build, pebbl falls back to a LIKE keyword scan.

### A git hook captures commits

`pebbl init` installs `.git/hooks/post-commit` that runs `pebbl log-commit` with the hash, message, and changed files. Every commit becomes a log entry tagged `source=hook`. That's how `pebbl context` can show "5 commits since the last handoff touched auth/" without anyone manually logging.

### A rubric handles auto-classification

`.pebbl/rubric.yml` has regex rules. When you call `pebbl log` without `--cat`, the rubric matches the message and assigns a category. It also assigns tiers; for example, messages that look like parameter dumps get auto-demoted to `detail`. You can edit `rubric.yml` to teach pebbl your project's vocabulary.

The rubric is intentionally conservative. It catches obvious cases; explicit `--cat` always wins.

## Handoffs in detail

Handoffs are pebbl's most opinionated feature. They're worth understanding fully.

A handoff is a row in the `handoffs` table with five fields: summary, done, todo, blocked, topics. The done/todo/blocked fields are semicolon-separated strings. When you create a handoff, it's `status=open`. When you close it, `status=closed` and `closed_at` gets set.

Closing does three things:

1. Materializes the handoff into `handoffs.md`. Each `;`-separated item becomes its own markdown block, so search can find individual items, not just the handoff as a whole.
2. Marks session detail entries as compaction-eligible. The entries logged between the previous handoff close and this one form a "session" by inference; once the handoff closes, those entries are fair game for the next compaction pass.
3. Removes the handoff from `pebbl context`'s open-handoff slot.

The semicolon convention matters more than it looks. A handoff like `--todo "fix auth bug and add tests and refactor middleware"` materializes as one big block. Search can't localize within it. You'd search for "auth bug" and get the whole undifferentiated paragraph. With `;` separators, each item is its own searchable unit.

## Compaction

Compaction is pebbl's pressure-release valve. Without it, the database grows linearly forever.

Compaction runs in three modes:

- `pebbl compact --preview` shows groups ready to compact: topics with too many detail/component entries.
- `pebbl compact --execute` merges them. The original entries move to `.pebbl/archive/` (searchable but lower priority). A summary entry replaces them, tier-bumped to component or foundation depending on the content.
- `pebbl compact --resolve <id:action>` handles ambiguous cases. Actions are `foundation` (promote to permanent), `rollup` (merge into a summary), or `skip` (leave alone).

You don't run compaction on a schedule. `pebbl context` tells you when something's ready. That's intentional: compaction is a judgment call about what's worth keeping, and the timing depends on how much you've been writing.

## Narrative

The narrative is one paragraph describing what the project is. It's stored in `.pebbl/narrative.md` and shown at the top of `pebbl context`. Without it, agents have to infer the project's purpose from scattered entries, which is wasteful.

Set it once:

```bash
pebbl narrative "Pebbl is a local CLI memory tool for AI agents working on codebases. SQLite-backed, FTS5/BM25 search, with a git hook for commit capture."
```

Pebbl warns when the narrative is older than several foundation decisions, since that suggests the project has evolved past its description.

## Where to dig next

- `src/db.js`: schema and queries. Start here if you want to understand the data model.
- `src/handoff.js`: handoff create/close/list logic, including the materialization step.
- `src/compact.js`: the compaction pipeline.
- `src/rubric.js`: auto-classification rules; the regex list shows what pebbl pattern-matches.
- `src/context.js`: what shows up when you run `pebbl context`. Read this to understand the agent-facing surface.
- `EVAL_HARNESS.md`: how pebbl's quality is measured.

For the CLI reference, use `pebbl --help` and `pebbl help <topic>`. For agent-facing behavioral rules, see [AGENTS.md](AGENTS.md). This file is the architecture-and-mental-model layer; those are the user-facing layers.
