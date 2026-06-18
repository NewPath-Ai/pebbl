# Manual Logs

## 2026-06-18T01:32:46.931Z - Feedback bypasses SQLite and qmd by design — it writes straight to .pebbl/feedback.jsonl because feedback is exactly what gets dropped when the db/qmd layers are misbehaving, so it must not depend on them
<!-- cat:decision topic:feedback tier:foundation source:human -->

## 2026-06-18T01:32:47.547Z - Pebbl keeps exactly one runtime dependency (better-sqlite3) on purpose — no tokenizer, no graph db, no model. New features must get the useful 80% with the existing primitives rather than adding a dep
<!-- cat:decision topic:dependencies tier:foundation source:human -->

## 2026-06-18T01:32:47.998Z - bi-temporal --corrects (design spike, not built): add valid_from/valid_to/invalidated_by columns so a correction stamps WHEN a belief stopped being true instead of just hiding the old entry — gets Zep/Graphiti validity-interval idea without a graph db, migration additive and backfilled
<!-- cat:decision topic:corrects,schema tier:detail source:human -->

## 2026-06-18T01:32:48.456Z - context pack --budget (design spike, not built): token-aware size-bounded snapshot for re-injection after Claude Code auto-compacts the window. Greedy fill in priority order (open handoff, narrative, foundation, ranked rest) with per-section soft caps; turns pebbl from a store into a context-management primitive
<!-- cat:decision topic:context-pack tier:component source:human -->

## 2026-06-18T01:32:48.909Z - Onboarding/bootstrap rule: surface, never auto-write. Bootstrap from real git history plus docs but NEVER auto-mint a decision entry — a hallucinated foundation entry is worse than an empty store because it carries borrowed authority. Risky channels gate behind explicit human confirmation
<!-- cat:decision topic:onboarding tier:foundation source:human -->

## 2026-06-18T01:32:49.359Z - Onboarding composes with siblings instead of duplicating: sources-index owns doc discovery, scan-commits is the decision-detection engine run once over full history, onboarding wires both and adds interactive reconstruction. Shared decision-detection code, not reimplemented (DRY)
<!-- cat:structure topic:onboarding tier:component source:human -->

## 2026-06-18T01:32:49.816Z - pebbl reflect (design spike, not built): pebbl supplies trigger plus source material plus storage, the agent supplies the synthesis. No internal model call — same pattern as handoff --close where the working agent writes the summary and pebbl just stores it. Reflect emits a structured prompt, it does not answer it
<!-- cat:decision topic:reflect tier:component source:human -->

## 2026-06-18T01:32:50.277Z - re-rank retrieval (design spike, not built): rank by recency plus importance plus usage plus relevance, not recency alone. Importance defaults deterministically from tier/category with optional agent override; usage counts only explicit search hits and context-pack inclusions, never the always-on context recent-list or every entry inflates equally
<!-- cat:decision topic:rerank,ranking tier:component source:human -->

## 2026-06-18T01:32:50.744Z - Migrations must be additive, version-gated, and previewable — never a silent rewrite. A re-classification that could demote a real decision ships behind migrate --dry-run plus an automatic db.sqlite backup before any destructive step; additive-and-previewable is the invariant
<!-- cat:decision topic:schema,migration tier:foundation source:human -->

## 2026-06-18T01:32:51.214Z - shareable decisions (design spike, not built): share foundation plus component decisions as a committed ADR projection while .pebbl/ stays gitignored for consuming projects. db.sqlite is source of truth, the .md is a read-only one-directional projection; --check exits non-zero when stale so rot fails loud in CI rather than silently
<!-- cat:decision topic:shared-decisions tier:component source:human -->

## 2026-06-18T01:32:51.675Z - Render supersession temporally in any decision export: show a corrected entry struck through with replaced-by reference and date rather than dropping correction history or printing superseded decisions as current — the why-we-changed is the most valuable part of an ADR log
<!-- cat:pattern topic:shared-decisions,corrects tier:component source:human -->

## 2026-06-18T01:32:52.134Z - Agent equals Model plus Harness. The gap between what a model can do and what you watch it do is mostly a harness gap, not a model gap (Opus 4.6: ~58% in Claude Code vs ~80% in a custom harness on Terminal-Bench 2.0). Every harness component must encode a named behavior the model cannot do alone, or delete it
<!-- cat:decision topic:harness tier:foundation source:human -->

## 2026-06-18T01:32:52.602Z - Harness design discipline is the ratchet: treat every agent mistake as a permanent signal, not a bad-luck retry. Add a constraint (AGENTS.md line plus hook plus reviewer) only when you have seen a real failure; remove one only when a better model made it pointless. This is why you cannot download someone else harness
<!-- cat:pattern topic:harness tier:component source:human -->

