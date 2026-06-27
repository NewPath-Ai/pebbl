# Design — pebbl self-learning primitives: readback, liveness, encode

*2026-06-23. Status: REVISION 1 (post-adversarial-review). Build order: readback tracer → liveness → encode.*

## Revision 1 — what the adversarial review changed (the trace)

Three adversaries attacked the v0 design; verdict was **not build-ready, 4 blockers**. Fixes folded in here:

- **B1 (readback tracer was self-falsifying).** v0's "jotter S0 already built" doesn't exist; in the real store jotter is the *rebuild-every-pass* fixture, so v0 would FALSE-fire. → Replaced with a **real** collision pair (App. A) and made jotter a must-NOT-trip.
- **B2 (encode altitude self-reported).** v0 let the band-aiding agent tag its own fix's altitude. → Altitude is now **inferred from the diff**; the agent's tag is a *claim* to be checked (§3).
- **B3 (factory-guide pointed at vapor).** v0 hard-coded stage names no script uses + wired into unbuilt components. → Guide now emits **trigger-conditions, not stage names**, with a **BUILT/PLANNED** status on every edge (§4).
- **B4 (liveness checker could pass while blind).** v0's `check` returns empty on a bug → "all green." → **Planted always-overdue sentinel**; a check that reports zero overdue is itself broken (§2).
- **Cross-cutting (proxy-vs-goal).** Every v0 test graded the *tool*, not the *factory* — the exact house-rubric Check 5 sin. → Every primitive now carries a **goal-level acceptance** that observes a downstream *outcome event*, plus a foolability fixture (§0, §6). The "fixes 31% stale-spec" claim is downgraded: readback *surfaces* the collision; consumption is gated on L20 (structural read), which is unsolved.
- Plus schema/mechanism fixes inline (real categories, identifier-aware tokens, FTS5 routing, collision ranking lane).

## 0. Principle

pebbl stays a deterministic, **no-LLM** substrate: each command **selects** information and **exposes structure**; agents supply judgment. Each command is **self-documenting for factory integration** (§4).

**Acceptance discipline (new):** a primitive is not "done" when its command returns the right value (that's a proxy). It is done when a **downstream outcome event** changes on the real pipeline (the goal). Every §1–§3 spec carries both a unit test (tool) AND a goal test (outcome), AND a must-trip fixture proven to go red.

The three are one substrate queried three ways over the timestamped event stream. Reuse: `events.jsonl`+fold, **search.js FTS5 (porter stemming + synonym OR-expansion + bm25)**, the `eid/ts` envelope, the `makeEnvelope` maker pattern. (v0 routed readback through `context.js findRelatedCommits`; the review proved that path drops short identifiers and can't stem — readback uses **search.js**.)

---

## 1. Readback — `pebbl readback`

**Purpose:** surface colliding prior work for an incoming task BEFORE the agent acts, so it resumes/supersedes instead of reinventing. **Scope claim (corrected):** readback makes the collision *available*; whether the agent *obeys* is L20 (structural read), unsolved — so readback does not by itself "fix the 31% stale-spec class," it's the necessary half.

**Command:** `pebbl readback <spec-file | - > [--json] [--top N]`

**Mechanism (deterministic):**
1. **Identifier-aware extraction** (fixes F2). Keep: code identifiers, file paths (`*.ext`), short alnum slice-ids (S0, M1, v2, CI), quoted commands, capitalized artifact names — explicitly DO NOT drop tokens ≤3 chars. Separately, topic words (for context, not for collision).
2. **Reasoning-subset filter, real schema** (fixes F4). Include `type=='append' AND category ∈ {decision, correction, pattern, integration, structure, quality} AND tier ∈ {foundation, component, detail}`. EXCLUDE `type=='commit'` (the real firehose — 246 of them, no category), `source=='hook'` projection-sync appends, and `tier=='fleeting'`. (`quality-with-artifact` was not a real category; plain `quality` is kept because the strongest real precedents carry it.)
3. **Match via search.js FTS5** (fixes F6) — stemming + synonym expansion + bm25, so rename/paraphrase has a chance. Score: **artifact/identifier/path overlap ≫ topic overlap**.
4. **COLLISION requires an identifier/artifact/path match** (fixes F9), NEVER a topic word (`factory`/`review`/`promote` must not trip it). A single shared *artifact* is enough to flag (fixes F3 — no `score≥2` gate on identifier hits).
5. **Collision ranking lane** (fixes F8): collision-bearing matches sort ABOVE the importance/usage rerank; rerank only orders *within* the collision set. A hot, newer, same-topic non-collision entry can't outrank a true artifact collision.

**Output (JSON):** `[{eid, matched_on:[artifact|path|id…], score, collision:bool, verdict_hint}]`.

**Acceptance:**
- **Unit (tool):** given the App. A incoming task, readback returns the prior `test-triage-watermark.sh` fix entries with `collision=true`, ranked #1, via a **paraphrased** query that shares no eid and not the exact filename casing (proves selection, not `.includes` — fixes F7).
- **Goal (outcome):** on a replayed claim of an already-done task, the pipeline emits **no second build branch** / emits a supersede, vs a control run that rebuilds. (Observes the factory behavior, not the query.)
- **Must-NOT-trip (fixes F1):** the jotter *rebuild-each-pass* fixture returns `collision=false`; a novel artifact returns empty; two unrelated tasks sharing only {factory, review} return `collision=false`.
- **Known blind spot (fixes F5):** a precedent recorded ONLY as a `type=='commit'` entry is invisible until the two-store split lands — stated, with a must-trip that documents it.

**Factory wiring:** trigger = "a task is about to be claimed/started, before any code." COLLISION → pause, resume/supersede. Handed as typed input at build (the structural-read half is L20, not readback's to claim).

---

## 2. Liveness — `pebbl liveness` / `pebbl heartbeat`

**Purpose:** detect the *absence* of an expected event (the dog that didn't bark) — silent fails (cron skipped, canary never loaded, scribe died quiet, watermark advanced before the work).

**Commands:**
- `pebbl liveness register <name> --every <dur> [--grace <dur>]` → `liveness-register` event.
- `pebbl heartbeat <name> [--proof <token>]` → `heartbeat` event at now, **beat LAST, after the artifact is written and verified** (fixes F3). `--proof` carries an evidence token (row count / output hash / artifact path) so "beat but no real output" is inspectable.
- `pebbl liveness check [--json]` → walks the registry; flags OVERDUE when `now − last_beat > every + grace`.

**Heartbeat is a LIVENESS signal, not a correctness signal (fixes F3, reframed):** it asserts the run reached the (end) beat. Correctness stays the job of an artifact/freshness check (brief-freshness, canary). The doc no longer claims a beat proves the work was right.

**Self-proving checker (fixes B4/F2):** `liveness check` (a) appends its OWN `heartbeat liveness-check` and asserts its own freshness first; (b) the registry holds a **planted always-overdue sentinel** — every healthy check MUST report exactly that sentinel as OVERDUE. **A check reporting zero overdue is itself broken → LOUD, not green.** The brief prints the registry count walked + the sentinel's status, so "green over 0 jobs" is visibly wrong. (This is the airport-scanner test-weapon, applied to the monitor.)

**Registry from the real scheduler (fixes F1):** the known-critical set is **derived from the actual crontab / LaunchAgent plists**, not a hand-list. `check` asserts every scheduled job that should beat HAS a `liveness-register`; a scheduled-but-unregistered job is OVERDUE-by-absence. No second list to forget.

**The one external floor (fixes the split-brief gap):** pinned to **one real, non-dormant, scheduled job — the Mac morning brief** (the droplet `morning-report.sh` is dormant; do not rely on it). Exactly one such signal; more re-opens the regress.

**Acceptance:**
- **Unit:** a registered-then-silent job flags OVERDUE; the sentinel always flags; a forced-empty `check` goes LOUD (not green).
- **Goal:** add a scheduled job, DON'T register it → the suite goes red (the forgot-to-wire case, the real hole). Kill the brief's host → a human-reachable channel goes quiet in a noticed way.

**Factory wiring:** every scheduled stage registers once + beats on verified success; the Mac brief runs `check`; OVERDUE is loud.

---

## 3. Encode — `pebbl recurrence`

**Purpose:** escalate repeated friction symptom→root; separate **frequency** (happens a lot) from **resistance** (survived a fix). The band-aid detector.

**Altitude is INFERRED, not self-reported (fixes B2/F4):** the agent's `fix_altitude` is stored as `fix_altitude_claimed`. pebbl derives `fix_altitude_observed` from the merge diff it already records (commits + files): leaf-symptom-site-only → `patch`; touches a **shared definition / single-definer / type / schema** and/or lands a **regression guard** → `root`. `resistance` is computed from **observed** altitude. **Claimed-vs-observed disagreement is itself a high-value flag** ("claimed root, touched only the leaf").

**Signature anchored on fix-SITE, not error-string (fixes F5):** resistance keys on the *site a prior root-claimed fix touched* (drift-stable), not the error text (which the act of fixing mutates). Stated plainly in-doc: **a low resistance count is NOT evidence of no resistance** — any fix that renames/relocates/rewords resets a string signature; site-anchoring resists that. `--scan` surfaces "these N signatures share a site/artifact, maybe one drifting class" as a maintenance-agent prompt.

**Commands:**
- `pebbl recurrence <signature> [--json]` → `{frequency, resistance, last_seen, attempts:[{altitude_observed, altitude_claimed, eid, ts}], flag}`, flag ∈ {none, PATTERN (freq≥threshold), RESISTANT (≥1 recurrence after an *observed*-root fix), STRUCTURAL (≥2)}.
- `pebbl recurrence --scan [--json]` → all over-threshold signatures + drift-candidate groups (the maintenance feed).

**Escalation routing (must actually fire — not just compute the flag):** PATTERN → inbox (occurrences attached as must-trip fixtures); RESISTANT → Ashley, prior "root fix" marked falsified; STRUCTURAL → stop-fixing-as-a-bug (escalate-once-then-STOP).

**Acceptance:**
- **Unit:** the **GLM-judge** real case (App. A) — a claimed root fix, later falsified (billed nothing), re-fixed — computes RESISTANT.
- **Goal (fixes the silent-flag trap):** a seeded recurrent signature actually **lands in the inbox / pings Ashley once / stops generating repair tasks** — routing observed end-to-end, not just a flag computed.
- **Must-trip:** `root-claimed` on a leaf-only diff is downgraded to observed-`patch`; a relocate-fix (same failure, renamed file) is grouped by site, not seen as a fresh frequency-1 PATTERN.

**Factory wiring:** RETIRE tags `fix_altitude_claimed` + the diff is read for `observed`; maintenance runs `--scan`; RESISTANT/STRUCTURAL bypass to the human.

---

## 4. Self-documenting layer — `--factory-guide` (inverted, fixes B3)

Per command: `pebbl <cmd> --factory-guide [--json]` emits a manifest of **trigger-conditions, not destination stage names** (a host factory binds its own stages):
```json
{ "command": "readback",
  "call_when": "a task is about to be claimed/started, before any code is written",
  "precondition": "you have the task spec text",
  "effect": "a COLLISION result means stop and resume/supersede, do not rebuild",
  "consumes": "task spec", "produces": "ranked colliding precedents",
  "edges": [ {"to":"L20 structural-read","status":"PLANNED"},
             {"to":"pebbl search","status":"BUILT"} ] }
```
Rules: **every edge carries `status: BUILT|PLANNED`**; the integrating agent treats `PLANNED` as "do not wire, surface it." pebbl only emits edges it can **verify at runtime** (its own sibling commands); external consumers are described ("the kind of consumer this output expects"), not instructed.

`pebbl factory-guide [--json]` = the whole map, same rules.

**DRY claim corrected (fixes the relocated-drift finding):** embedding the guide only removes guide-vs-code drift. Guide-vs-actual-call-site drift is closed only if the **call site CONSUMES the manifest** (the factory stage reads `--factory-guide` and a wiring test asserts the call happens at the stated trigger). Absent that enforcement edge, the doc does NOT claim "can't drift."

---

## 5. Factory wiring map (triggers, not stage names)

| Trigger condition | Component | pebbl call | Effect / gate | Status |
|---|---|---|---|---|
| task about to start, pre-code | readback | `readback <spec>` | COLLISION → resume/supersede | BUILT(readback) + PLANNED(L20 obey) |
| task closing | reflect-leaf + encode tag | `log` + diff read | lesson-or-nothing | PLANNED |
| periodic maintenance | encode scan | `recurrence --scan` | PATTERN→inbox, RESISTANT→human | BUILT(scan) + PLANNED(routing) |
| any scheduled job, on verified success | liveness | `heartbeat --proof` | — | BUILT |
| the one human floor (Mac brief) | liveness | `liveness check` | OVERDUE + sentinel loud | BUILT |

---

## 6. Build order & acceptance bar

1. **Readback tracer** — prove on App. A real pair (paraphrased query), with the goal test (no second build branch) and the jotter must-NOT-trip. Then `--json` + `--factory-guide`.
2. **Liveness** — self-proving checker + sentinel + scheduler-derived registry.
3. **Encode** — diff-inferred altitude + site-anchored signature + routing.

Each ships: a **must-trip fixture** (detector proven red), a **goal test** (outcome observed, not tool-return), `--factory-guide` (status-tagged edges), and a one-line lesson at close.

---

## Appendix A — real tracer cases (cited, in the live sw-factory store)

**Readback COLLISION:** incoming task = "fix `test-triage-watermark.sh` fixture seed-rot (seeds from the live heartbeat file)." Prior work already addressing it: `01KV3F6EEF` ("seed heartbeat from a literal, not the live file"), `01KV3FYFG9` ("fixed test-triage-watermark.sh fixture rot"); the double-queue that PROVES the gap: `01KV3G5W2A` (queued the dup) + `01KV3G640S` (retired ALREADY-RESOLVED, fixed by `59c4408`). Readback on the incoming spec must surface these with `collision=true` unprompted.

**Encode RESISTANCE:** the GLM-judge saga — a claimed env-path fix, later found to bill nothing (never live), re-fixed via `glm-judge-key-resolution`. Multiple claimed-root fixes, falsified, recurring → the canonical RESISTANT case. (Pull exact eids at build via `pebbl search "glm judge"`.)
