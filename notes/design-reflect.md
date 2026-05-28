# Design: `pebbl reflect`

*Idea 3 of 4 in the memory-harness series. Status: design, not built. May 28, 2026.*

Turn a pile of observations into a new insight the pile never stated. The agent does the thinking; Pebble runs the loop.

---

## Problem

Compaction ([src/compact.js](../src/compact.js)) rolls many entries into a concatenated string: `[rollup] decision notes on auth (2026-05): msg1; msg2; msg3`. That shrinks volume. It produces no new knowledge. It never notices the higher-order fact sitting across the entries: "we keep choosing managed services over self-hosting because the team is small." Reflection is the step that produces that sentence.

Two research lines converge here. Generative Agents runs a periodic reflection pass that synthesizes recent observations into higher-level insights, recursively ([Park et al., 2023](https://ar5iv.labs.arxiv.org/html/2304.03442)). A-MEM has new memories trigger *evolution* of existing notes, so the store grows structure over time rather than just accumulating ([Xu et al., 2025](https://arxiv.org/html/2502.12110v1)). Both want a model in the loop.

Pebble's founding rule forbids an internal model ([IMPLEMENT_V02.md:30](../IMPLEMENT_V02.md)). That is fine, because Pebble already has the pattern for this: `pebbl handoff --close` lets the *working agent* write the summary and Pebble just stores it ([src/handoff.js:50](../src/handoff.js)). The compaction `--resolve` flow does the same for ambiguous entries. Reflect is that pattern applied to insight generation. Pebble supplies the trigger, the source material, and the storage. The agent supplies the synthesis.

## Design

```bash
pebbl reflect [--topic <area>] [--preview]
```

### Trigger

When `N` (config `reflect.threshold`, propose 8) component/detail entries share a topic *and* no foundation/pattern entry already summarizes that topic recently, surface a notification inside `pebbl context` next to the existing compaction notice:

```
[pebbl] 9 entries on 'auth' may hold an unstated pattern. Run: pebbl reflect --topic auth
```

### The command emits a prompt, it does not answer it

`pebbl reflect --topic auth` prints a structured block for the agent to act on. No model call:

```
--- PEBBL REFLECT: auth (9 entries) ---
Read these entries. If they share a decision, pattern, or constraint that is NOT
already written as its own entry, capture it as ONE new entry with rationale:

  [id:12] chose JWT over server sessions because we scaled horizontally
  [id:18] added refresh-token rotation after the security review
  [id:24] dropped the auth cache; staleness caused more bugs than it saved
  [id:31] standardized on 15-minute access-token TTL
  ... 5 more

Then log it:
  pebbl log "<the insight, with a because/so-that rationale>" \
    --cat pattern --topic auth --tier foundation --derived-from 12,18,24,31,...

If there is no insight beyond what is already logged, run:
  pebbl reflect --topic auth --skip
---
```

The agent reads, decides whether a real pattern exists, and writes it. The derived entry links to its sources via a new `--derived-from` flag (a typed `relates_to`), so an insight can be traced back to the observations that produced it, and re-examined if those change.

`--preview` shows what would be surfaced without printing the full prompt, for a human scanning the project.

### Provenance and anti-noise

- Add `reflected_at TEXT` to `logs` (migration v0.6, same pattern as v0.5). Source entries get stamped when a reflection consumes them, so they do not re-trigger. Only *new* entries past the threshold re-arm the trigger.
- `--derived-from` populates `relates_to` with a provenance marker, finally giving that dormant column a job.
- The existing thin-entry detector ([src/detect-thin.js](../src/detect-thin.js)) gates the derived entry: a reflection with no "because / so that / the problem is" rationale gets the same spec-sheet warning a bad decision entry gets. Insight without a reason is not an insight.

## Constraint check

- **No internal LLM.** The agent reflects; Pebble scaffolds. Identical to handoff-close and compact `--resolve`, both already shipped.
- **Local-first, no deps.** One nullable column plus a notification query.
- **Backward compatible.** New command, additive migration.

## Harness integration

Reflect is a consolidation step that runs occasionally, not every turn. Two good trigger points:

- **After `pebbl handoff`** at session end, while the agent still has the session in context and can judge what mattered.
- **When the context notification fires**, so a human or agent can run it on demand.

The payoff compounds with the other ideas. Reflections are foundation/pattern entries, exactly what [design-context-pack.md](./design-context-pack.md) prioritizes when filling a budget. More sessions produce more reflections, which produce denser high-tier knowledge, which produces better packs at the same token cost. That is the self-improving memory loop the harness deep-dive points at, built from parts Pebble already has.

This is Böckeler's *inferential* control: a model making a semantic judgment, run where judgment matters, not on every change.

## Risks and open questions

- **Low-value reflections.** The agent may write filler. Mitigations: the thin-entry gate, foundation tier so it is visible and easy to `--corrects`, and the rule that reflect only fires past a threshold.
- **Over-reflection.** Without the `reflected_at` stamp, the same nine entries re-trigger forever. The stamp is load-bearing, not optional.
- **Who runs it.** If it depends on the agent remembering, adoption drops, the same failure mode as every other manual step. The honest fix is a session-end nudge in `AGENTS.md` plus the context notification, and accepting that reflect is lower-frequency than context/log.
- **Recursive reflection.** Generative Agents reflects on reflections. Out of scope for v1; revisit once single-level reflect earns its keep.

## How to measure it

Harder than the deterministic ideas, because the output is a judgment. Build a fixture where the seeded entries imply a specific pattern, run reflect, and score whether the produced entry captures it. This needs an LLM-as-judge or a keyword proxy, so treat the metric as directional, not a gate. The deterministic parts (trigger fires at threshold, sources get stamped, no re-trigger) are scriptable and should be gated tests.

## Effort and files

Medium.

- `src/reflect.js` — new: trigger query, prompt emission, `--skip` / `--preview`.
- `bin/pebbl.js` — route `reflect`.
- `src/context.js` — add the reflect notification alongside `showCompactionNotifications`.
- `src/migrate.js` — v0.6: `reflected_at` column.
- `src/log.js` — handle `--derived-from` (writes `relates_to` + marks provenance).
- `src/args.js` — add `derived-from`, `skip` to `KNOWN_FLAGS` (`skip` boolean).
- `config.yml` — `reflect.threshold: 8`.
