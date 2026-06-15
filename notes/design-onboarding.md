# Design: onboarding & migration (no cold start)

*Bootstrap useful memory when pebbl is added to a repo that already has history, and carry an older pebbl forward safely. Status: design spike, not built. June 15, 2026.*

Raise the capture **floor**, don't add retrieval. A fresh `pebbl init` is empty ([init.js:56-57](../src/init.js) write empty `manual-logs.md`/`commit-log.md`), and an empty store gives an agent no reason to trust or use it — the cold-start face of the capture/coverage problem the adversarial analysis put ahead of retrieval. The fix is not a cleverer search; it's having something worth searching on day one.

---

## Problem

Two moments where memory is missing or stale:

1. **Cold start** — pebbl is added to a repo with real history (commits, README, ADRs, `sources/`) but no `.pebbl`. The decisions exist; they're just not in the store.
2. **Migration** — a repo carries an *older* pebbl into a newer one. The store exists but may lack columns, classifications, or indexes the new version expects.

Both are capture problems, not retrieval problems. The hard part isn't getting the data in — it's getting it in **without inventing it or flooding the store**.

## The four risks (the whole design is about these)

- **Fabrication.** Mining git messages or asking "what big decisions did you make?" can manufacture decisions that were never really made. A hallucinated foundation entry is *worse than an empty store*: it carries borrowed authority and sends the next agent down a false path (the same failure `pebbl check` guards against after the fact). **Hard rule: bootstrap never auto-writes a decision entry. It only ever prints a confirmable suggestion** — a human or agent promotes it. This is the same posture as `scan-commits`.
- **Distillation noise.** Seeding from raw history (every commit, every doc paragraph) floods the store with low-signal entries — the exact dilution risk `pebbl-sources-index` was careful about. A store that's 90% noise is as untrustworthy as an empty one. Bootstrap must distill the *few* real decisions, not dump the corpus.
- **Interactive burden.** An onboarding flow that asks 20 questions gets abandoned. Anything interactive needs a low-effort default and must be fully skippable — the value has to come mostly from what can be mined silently, with questions as an optional sharpener.
- **Migration safety.** A migration that corrupts or silently drops existing memory destroys the one thing the user already trusted. Migrations must be additive, version-gated, and reversible (or at least dry-run-previewable before any write).

## Part 1 — cold-start bootstrap

Three channels, in increasing fabrication risk. Lean hard on the cheap, safe ones; gate the risky one behind explicit confirmation.

**Channel A — mine git history (lowest risk, highest leverage).** The commits are real; nothing is invented. `log-commit.js` already auto-captures *recent* commits as `source='hook'` fleeting entries; the missing piece is a *one-time backfill over all history* that surfaces **decision-shaped** commits as suggestions. This is `scan-commits` pointed at the whole log instead of the last 30 — **they should share the decision-detection code**, not reimplement it. Output: ready-to-edit `pebbl log "..." --cat decision` lines the user accepts or ignores. No fabrication (it's the real commit), distillation handled by the decision-verb + dedupe filter.

**Channel B — distill existing docs (defer discovery to sources-index).** README, ADRs, and `sources/` already hold the *why*. The temptation is to parse them into entries — but `pebbl-sources-index` already makes those docs **findable** as read-only `[source]` hits without copying them in. So bootstrap should **not** re-ingest docs as entries (that's the distillation-noise trap). Instead: at init, point `sources-index` at the repo's doc dirs (README's dir, `docs/`, `sources/`) so they're searchable immediately, and only *distill* a doc into a real entry when a human confirms a specific decision. Discovery is free and lossless; distillation is opt-in and human-gated.

**Channel C — interactive reconstruction (highest risk, opt-in, last).** Ask the human/agent the handful of things mining can't see: the big architectural decisions and — crucially — *what was tried and abandoned* (negative knowledge never lands in a commit). `handoff.js` is the lightweight prior art: it captures a session's done/todo/blocked, but it's **forward-looking** (handing off live work) and assumes a session already in flight — it has no notion of reconstructing the past, and nothing classifies its items into foundation/component. So onboarding needs more than handoff, but should reuse its materialize-one-block-per-item shape. Keep it to **3–5 questions, fully skippable**, and every answer becomes a *suggested* entry the user confirms — never an auto-write. If they skip, channels A+B still leave a useful store.

## Part 2 — migration (older pebbl → newer)

**What already exists.** `migrate.js` version-gates the schema (`meta.schema_version`, semver-normalized) and applies additive `ALTER TABLE ... ADD COLUMN` steps (v0.1→v0.2 added category/tier/topics/relates_to/corrects), idempotently. `upgrade.js` carries config forward: merges new `rubric.yml` rules, updates the `AGENTS.md` pebbl section, removes legacy `PEBBL.md`. So **schema and config migration is solved and safe** (additive, versioned).

**What a newer pebbl needs that isn't covered.** When the new version changes *meaning*, not just shape:
- **Re-classification.** Entries logged before a rubric change keep their old category/tier. A migration should *offer* to re-run the rubric over historical messages — but as a **preview** (it can move a foundation decision to detail), never a silent rewrite. Reuse `compact`'s ambiguous-resolution UX: show the proposed re-tag, let the user confirm.
- **Topic/tier backfill.** Old entries with empty `topics` are invisible to topic-filtered search. A backfill pass can infer topics from the message (the rubric/word-extraction already exists), again **suggested, not forced**.
- **Re-index.** New retrieval surfaces (qmd collections, the `[source]` and `[archived]` projections from this session's work) need a one-shot reindex on upgrade so old data participates. This is mechanical and safe.

**Migration safety mechanism.** Everything above ships behind a `migrate --dry-run` that prints what *would* change and writes nothing, plus an automatic `db.sqlite` copy before any destructive step. Additive-and-previewable is the invariant; a re-classification that demotes a real decision must be reversible.

## How this stays distinct from its siblings

Three tasks circle the same capture problem; they must compose, not duplicate:
- **`pebbl-sources-index`** — *discovery* of external docs (read-only `[source]`). Bootstrap's doc channel **defers to it** instead of re-ingesting docs.
- **`scan-commits`** — *ongoing* nudge for uncaptured decisions. Bootstrap's git channel is the **same engine run once over full history**.
- **onboarding (this)** — the *one-time bootstrap* that wires those two at the existing repo's history/docs and adds the interactive reconstruction neither covers.

The shared principle across all three: **surface, never auto-write.** Capture is raised by making real artifacts cheap to promote, not by manufacturing memory.

## Recommendation (phased)

1. **Ship the free wins first.** At `init` on a repo with history: run the `scan-commits` engine over *all* commits and register `sources-index` on the repo's doc dirs. Zero new fabrication risk (real commits, read-only docs), almost no interactive burden, and reuses code that already exists. This alone takes a fresh pebbl from empty to "useful on day one."
2. **Add the interactive sharpener (opt-in).** A skippable `pebbl onboard` that asks 3–5 "founding decisions / what was abandoned" questions and emits *suggested* foundation entries. Lands the negative knowledge mining can't.
3. **Complete migration.** Add `migrate --dry-run` + pre-write db backup, then re-classification / topic backfill / reindex as previewed, confirmable passes.

Build order is deliberate: phase 1 delivers most of the value with the least risk and depends only on already-queued work; the interactive and migration phases are where fabrication and safety need the most care, so they come after the cheap wins prove the floor is worth raising.

## Friction

- The cold-start and capture-nudge tasks **share a decision-detector** (`scan-commits`); building onboarding before factoring that out would fork the logic. Recommend `scan-commits` expose its `uncapturedDecisions`/`decisionRe` as the shared engine (it already exports `_internal`).
- `handoff.js` is close-but-not-it for interactive reconstruction (forward-looking, unclassified). Whether to extend handoff or add a sibling `onboard` is the one real fork this spike leaves for Ashley.
