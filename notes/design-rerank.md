# Design: re-rank retrieval

> **Historical record.** QMD (the `@tobilu/qmd` semantic search index) was removed from pebbl in M2. SQLite FTS5/BM25 is now the only search engine. This note predates that change and is kept as a design/decision record; its QMD references describe how pebbl worked at the time, not current behavior.

*Idea 4 of 4 in the memory-harness series. Status: design, not built. May 28, 2026.*

Rank by recency + importance + usage + relevance, not recency alone. The layer [context pack](./design-context-pack.md) stands on.

---

## Problem

Pebble ranks two ways, both partial. Search delegates to qmd, which orders by semantic relevance only ([src/search.js](../src/search.js)). Context orders by tier then `id DESC`, which is recency ([src/context.js:266](../src/context.js)). Neither uses two signals that Generative Agents showed matter: **importance** (entries are not equally load-bearing) and **usage** (an entry the agent keeps retrieving is worth surfacing first).

A six-month-old foundation decision that gets pulled into context every session is more valuable than a fresh detail note nobody has looked at twice. Recency ranking inverts that. Generative Agents scores memory by a weighted sum of recency (exponential decay), an importance score, and relevance ([Park et al., 2023](https://ar5iv.labs.arxiv.org/html/2304.03442)). This design adapts that formula to Pebble's rows and adds a usage term.

## Design

### Schema (migration v0.6)

Add to `logs`, same migrate pattern as the others:

```sql
ALTER TABLE logs ADD COLUMN importance INTEGER;   -- 1..5, nullable
ALTER TABLE logs ADD COLUMN last_accessed TEXT;
ALTER TABLE logs ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
```

(If reflect's v0.6 ships first, fold these into the same version bump.)

### Importance: heuristic default, optional agent override

A genuinely good importance score wants the agent. But Pebble can set a sensible default with no model, then let the agent override:

- **Default (deterministic):** derive from tier and category at write time. foundation = 5, component = 4 for decision/structure/pattern else 3, detail = 2, fleeting = 1. This reuses the classification Pebble already computes in [log.js](../src/log.js); no new judgment.
- **Override:** `pebbl log "..." --importance 5`. The agent, which has the context, can mark something more or less important than its tier implies.

This mirrors [context pack](./design-context-pack.md)'s honesty about ranking: ship the deterministic version, allow the agent to do better.

### Usage tracking

When an entry is *retrieved in a way that signals need*, bump `access_count` and set `last_accessed = now`. The trap: do not count the always-on `pebbl context` recent list, or every entry inflates equally and the signal is noise. Count only:

- explicit `pebbl search` hits, and
- inclusion in a `context pack` (the agent chose to spend budget on it).

That keeps usage meaning "this earned its place," not "this scrolled past."

### The score

Shared function in a new `src/rank.js` (the IMPLEMENT_V02 rule is one home for shared logic, [IMPLEMENT_V02.md:968](../IMPLEMENT_V02.md)):

```
score = w_recency  * exp(-age_days / halflife)
      + w_importance * (importance / 5)
      + w_usage     * exp(-days_since_access / usage_halflife)
      + w_relevance * semantic_score   // search only; 0 for context
```

Weights live in `config.yml` under `rank:`, so they are tunable without code:

```yaml
rank:
  recency: 0.25
  importance: 0.35
  usage: 0.20
  relevance: 0.20
  halflife_days: 30
  usage_halflife_days: 14
```

Apply in three places: `context.js` recent/topic sections (relevance term drops out), `search.js` re-ranking qmd or SQLite-fallback results, and feeding [context pack](./design-context-pack.md). Foundation entries still float to the top of the topic index regardless of score; the score orders within a tier and drives the pack's fill.

## Constraint check

- **No internal LLM.** The math is arithmetic. Importance default is a tier lookup. Usage is a counter.
- **Local-first, no deps.** Three columns, one scoring function.
- **Backward compatible.** Additive migration; existing rows get `importance` backfilled from tier, `access_count = 0`.

## Harness integration

Indirect but foundational. Better ranking means the agent's always-on context and its budgeted pack both surface the right entries first. Every other idea in this series benefits: the pack fills with higher-value rows, reflect's notifications point at genuinely active topics, and bi-temporal current beliefs outrank superseded ones for free (a superseded entry stops accruing usage). This is the cheapest idea with the widest blast radius.

## Risks and open questions

- **Weights are the whole game, and they cannot be guessed.** Shipping tuned weights without an eval is how you make retrieval worse while believing you improved it. This idea should not ship its weights until the LongMemEval-style fixture exists to tune against. The mechanism can land first with neutral weights; the tuning waits for measurement.
- **Rich-get-richer.** Surfaced entries get accessed, which surfaces them more. The `usage_halflife` decay fights this so old access fades. Cap the usage term's contribution so it cannot dominate.
- **Importance without an agent is weak.** The tier heuristic is a floor, not the ceiling. Accept it for v1; the override flag and, later, an agent-scored pass at write time close the gap.
- **Access counting from context pack is a soft signal.** Inclusion is not the same as use. Acceptable proxy for v1; revisit if it skews ranking.

## How to measure it

This is the idea that most needs the eval, and most rewards it. Build the LongMemEval / LoCoMo-style fixture ([arXiv:2410.10813](https://arxiv.org/pdf/2410.10813), [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)): a synthetic project history plus held-out questions. Measure whether the correct entry lands in top-k, before vs after re-rank, and sweep the weights to find a setting that beats pure recency. That delta is the entire justification for the feature. No fixture, no feature.

## Effort and files

Low to medium for the mechanism; the tuning is the real cost and lives in the eval.

- `src/migrate.js` — v0.6 columns (share the bump with reflect if both land).
- `src/db.js` — columns in fresh `SCHEMA`.
- `src/rank.js` — new: the shared scoring function.
- `src/log.js` — importance default from tier; `--importance` override.
- `src/context.js` + `src/search.js` — apply the score; bump usage on qualifying retrievals.
- `src/args.js` — add `importance` to `KNOWN_FLAGS`.
- `config.yml` — the `rank:` block.

## Sequencing note

Build order across the series: the **eval fixture first** (nothing here is tunable without it), then this re-rank mechanism with neutral weights, then [context pack](./design-context-pack.md) on top, then [bi-temporal corrects](./design-bitemporal-corrects.md) and [reflect](./design-reflect.md) as the memory-quality layer. Re-rank and pack are the two that most directly earn Pebble its context-management seat in the harness.
