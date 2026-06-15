# Design: shareable decision history

*Share pebbl's own foundation/component decisions with the repo, while `.pebbl/` stays gitignored. Status: design spike, not built. June 15, 2026.*

Pull research in ([sources index](./design-context-pack.md) family); push the *why* back out so a fresh clone carries it.

---

## Problem

pebbl gitignores `.pebbl/` ([.gitignore:3](../.gitignore)). That is the right default: a tool that writes local memory into every user's project should not commit the maintainers' memory into its own public repo. But on pebbl *itself* the default has a cost. The foundation/component decisions that explain why pebbl is shaped the way it is live only in local `db.sqlite`, one copy per checkout. A fresh clone — a new contributor, or the factory building pebbl in `~/factory/repos/pebbl` — gets the code and none of the reasoning.

The asymmetry is the sharp part: `pebbl search` hands a local user the why, but only if they already have a populated `.pebbl`. The people who most need the context (someone who just cloned) have an empty one.

## What to share, and what not

pebbl already owns the dividing line: **tiers**. foundation and component are the load-bearing, project-wide and subsystem decisions; detail and fleeting are notes and session chatter that decay. So the shareable layer is foundation + component — pebbl's own ADR (Architecture Decision Record) history. The noise stays local. This is not "un-gitignore `.pebbl`"; it is "add a curated, committed projection of the top two tiers."

## Options

### A. Committed ADR projection (generated file)
A tracked `DECISIONS.md` auto-generated from foundation+component entries, grouped by topic, each with its why. `.pebbl/` stays ignored; this one file is tracked.
- **Pro:** travels with the repo, human-readable, matches ADR convention, reuses machinery that already exists — `manual-logs.md` is itself a generated projection of `db.sqlite`.
- **Con:** a generated file under version control rots without a regeneration trigger, and churns on every new decision.

### B. Tier-scoped gitignore
Ignore the fleeting/detail projections and the binary db, but track one `foundation-component.md`.
- **Pro:** minimal, no new command.
- **Con:** `db.sqlite` is the source of truth and is local/binary; committing a partial projection without its db is a lossy half-state, and it couples the public repo to `.pebbl/`'s internal file layout, which is not a stable interface.

### C. Export command + tracked artifact (A, made explicit)
`pebbl export-decisions [path]` writes the foundation+component history to a tracked doc on demand, with a `--check` mode for freshness.
- **Pro:** the projection is an explicit, documented *output*, not a leaked internal file; opt-in per repo.
- **Con:** still needs a freshness mechanism, or it drifts.

## The hard parts (what an adversary attacks)

**Staleness.** A committed generated file drifts the moment a new foundation/component decision is logged and not re-exported. Manual regen rots — a broken window. A pre-commit hook that regenerates and stages it is automatic but adds friction and can itself cause conflicts. Better: `pebbl export-decisions --check` exits non-zero when the doc is stale, run in the repo's own tests. **Fail loud beats silent rot** — the same lesson the factory just took from `|| true` swallowing exit codes.

**Source of truth.** `db.sqlite` is authoritative; the committed `.md` is a read-only, lossy copy (no ids, no bitemporal history). The flow must be strictly one-directional, db -> doc, never doc -> db. Mark it in the file header ("generated, do not edit") so no one hand-edits a derived artifact.

**Privacy / leak.** This is the real reason `.pebbl` is gitignored, and it is the constraint that kills the naive "just commit foundation+component" version. foundation entries can hold sensitive context — credential paths, customer names, internal URLs. Auto-committing them to a public repo is a leak waiting to happen. Sharing must therefore be **opt-in and filtered**: entries are excluded by default and shared only when explicitly marked (a `share:` flag, or a per-repo allowlist of topics). The export must never include an entry that was not deliberately made shareable.

**Merge conflicts.** A regenerated file changes on most branches; two feature branches each re-export and collide on a doc nobody hand-edits. Mitigate with deterministic ordering (stable sort by topic then id, so diffs are minimal) and by regenerating as a **release artifact** (on tag) rather than per-commit — which sidesteps branch conflicts entirely.

## Recommendation

Ship **Option C, privacy-gated, with `--check`**, framed as ADR export:

1. **Privacy first.** Entries are excluded from sharing by default; a repo opts in, and an entry is shared only when explicitly marked shareable. The gating constraint leads, because a leak is the one failure that can't be walked back.
2. **Export.** `pebbl export-decisions` projects the shareable foundation+component entries into a tracked, clearly-marked-generated `DECISIONS.md`, deterministically ordered.
3. **Freshness.** `pebbl export-decisions --check` runs in the repo's tests and fails loud when stale; optionally regenerate as a release artifact to dodge branch conflicts. No silent pre-commit rewrite.

This keeps `.pebbl` gitignored (privacy intact), reuses pebbl's existing projection pattern, gives new contributors the ADR history, and refuses to leak. It changes neither `.gitignore` nor the schema in this spike.

## Relationship to sources-index

`pebbl-sources-index` (also queued) is the inbound side — index external research docs *into* search. This is the outbound side — export curated decisions *out* to a shared doc. Together they are pebbl's I/O for the why: pull in research, push out decisions. Design them so the exported `DECISIONS.md` could itself be an indexable source elsewhere.

## Friction

Stayed a proposal by design. The open question a real implementation must settle: the privacy-gating model — a per-entry `share:` flag (precise, but needs discipline at log time) versus a per-repo topic allowlist (coarser, but no per-entry burden). Lean per-entry flag with an allowlist as a convenience layer.
