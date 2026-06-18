# Project Narrative

Pebbl is a Node.js CLI for local project memory: decisions, handoffs, and commit context stored in SQLite under .pebbl/. Founding constraints: exactly one runtime dep (better-sqlite3), no internal model — the working agent does the thinking, pebbl runs the loop and stores the result. Feedback deliberately bypasses SQLite so it survives db/qmd failures. The notes/ design series (bitemporal corrects, context-pack, reflect, rerank, onboarding, shared-decisions) maps the harness-engineering roadmap; all are spikes, not yet built.

<!-- refs: 1,2,5,9,12 -->
<!-- updated: 2026-06-18T01:33:17.627Z -->
