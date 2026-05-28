# Design: `pebbl context pack --budget`

*Idea 1 of 4 in the memory-harness series. Status: design, not built. May 28, 2026.*

The one that turns Pebble from a store into a context-management primitive.

---

## Problem

`pebbl context` ([src/context.js](../src/context.js)) prints a fixed 3-section view: narrative, topic index, last 5 entries. It is not token-aware. It always prints the same shape regardless of how much room the agent has.

The harness has a different need. Claude Code runs its own lossy auto-compaction of the conversation when the window fills. Project knowledge that lived in the chat (decisions made three hours ago) gets summarized away or dropped. After that compaction there is no way to ask Pebble for a *prioritized, size-bounded* snapshot to re-inject. Pebble has the durable copy on disk, but no command hands it back at a controlled cost.

This is the move Anthropic's context-management work names directly: clear stale content from the window, then re-inject a distilled version from an external store. Their eval reported +39% on multi-step tasks and -84% tokens ([context management, 2025](https://www.anthropic.com/news/context-management)). Pebble already holds the external store. It is missing the distill-to-a-budget step.

## Design

New subcommand:

```bash
pebbl context pack [--budget <tokens>] [--topic <area>] [--format md|json]
```

- `--budget` defaults to `context.pack_budget` in `config.yml` (propose 1500). The command never exceeds it.
- `--topic` biases selection toward an area without excluding foundation.
- `--format md` (default, for injection) or `json` (for programmatic harness use).

### Token estimation without a dependency

Pebble has one dependency (`better-sqlite3`) and that constraint stays. No tokenizer library. Estimate with a character heuristic: `tokens ≈ ceil(chars / 3.6)`. Target 90% of budget as headroom so the estimate erring low does not overflow. Document it as an estimate in the output header. If `tiktoken` happens to be importable, use it; otherwise fall back to the heuristic. Never make it a hard dependency.

### Assembly (greedy fill, priority order)

Fill until the budget is reached, highest-value first:

1. **Open handoff** todo + blocked lines. This is the live work. Always include (it is small and it is the point of resuming).
2. **Narrative.** The global summary. Soft cap ~20% of budget so a long narrative cannot crowd out everything else.
3. **Foundation entries**, newest first, excluding superseded ones. These are project-defining and never compact.
4. **Remaining budget** fills with top-ranked component/detail entries. Ranking comes from [design-rerank.md](./design-rerank.md) (recency + importance + usage + relevance). Until that ships, order by tier then recency. If `--topic` is set, restrict this section to the topic.

Each section has a soft cap so no single section eats the whole budget. When a section overflows its cap, truncate to the highest-priority members and note the count dropped.

### Output

Markdown, comments stripped, ready to paste or inject:

```
--- PEBBL CONTEXT PACK (est. 1420/1500 tokens) ---
[handoff] todo: rate limiting; forgot-password UI
[narrative] qnotes is a CLI note tool; markdown files are the store, qmd indexes them...
[foundation] auth: chose bcrypt because the cost factor is tunable as hardware improves
[foundation] storage: markdown-on-disk, not SQLite, so notes stay grep-able by hand
[component] search: qmd returns top 5; ranking weight 0.6 favors recency
... 9 component/detail entries omitted for budget — run `pebbl context --full` for all
---
```

The header states the estimate and the budget. The footer states what was dropped and how to get it. The agent always knows it is looking at a summary, not the whole store.

## Constraint check

- **No internal LLM.** Selection and truncation are deterministic. Nothing here calls a model.
- **Local-first, no new deps.** Character heuristic for tokens; optional tiktoken only if already present.
- **Backward compatible.** New subcommand. `pebbl context` is untouched.

## Harness integration

This is the payload for two hooks:

- **SessionStart** injects `pebbl context pack --budget 1500` so every session opens with prioritized memory, with no reliance on the agent remembering to run `pebbl context`.
- **PreCompact** fires `pebbl handoff` to capture session state, then injects a fresh pack so the distilled memory survives the conversation getting squashed. This is the backstop pattern: the lossy summary happens, but the load-bearing decisions are re-stated from disk.

Document both snippets in `AGENTS.md` and in the README's harness section. This is the command that earns Pebble a context-management seat next to the harness's own compaction, instead of sitting off to the side as a notes file.

## Risks and open questions

- **Estimate accuracy.** The char heuristic drifts on code-heavy entries. Headroom (target 90%) absorbs it. Revisit if overflow shows up in testing.
- **Budget smaller than foundation set.** A mature project can have more foundation entries than fit. v1: include newest foundation, truncate, warn loudly. A real fix needs summarization, which means the agent, which means [design-reflect.md](./design-reflect.md) feeding denser high-tier entries over time.
- **Ranking dependency.** Pack is best with re-rank in place. It can ship first on tier+recency and improve when re-rank lands.

## How to measure it

- **Budget adherence:** output token estimate ≤ budget on a corpus of varied entry sizes.
- **Knowledge retention:** from a synthetic project history, pack at budget B, then ask the agent held-out questions about foundation decisions. Score answerable-from-pack rate. Ties into the eval fixture; knowledge-update cases (a decision that was later corrected) should reflect the current belief, not the stale one.

## Effort and files

Low to medium.

- `bin/pebbl.js` — route `context pack` (detect the `pack` subcommand within the context handler).
- `src/context.js` — new `packMode(pebblDir, db, flags)`; reuse `showOpenHandoff`, `readNarrative`, the foundation query.
- `src/args.js` — add `budget`, `format` to `KNOWN_FLAGS`.
- `config.yml` — `context.pack_budget: 1500`.
- `AGENTS.md` / README — hook snippets.
- No migration required.
