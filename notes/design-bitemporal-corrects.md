# Design: bi-temporal `--corrects`

*Idea 2 of 4 in the memory-harness series. Status: design, not built. May 28, 2026.*

Make a correction stamp *when* a belief stopped being true, instead of just hiding it.

---

## Problem

Today `--corrects <id>` does two things: the new entry stores `corrects = <id>` ([src/log.js:139](../src/log.js)), and every read path hides the old entry with `id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)` ([src/context.js:217](../src/context.js)). The old belief disappears from view. The timeline does not survive. You cannot ask "what did we believe about auth in March, before we switched?" The superseded entry has no record of when it stopped being true or what replaced it.

The `relates_to` and `corrects` columns were shipped in v0.2 unused, explicitly described in [IMPLEMENT_V02.md:41](../IMPLEMENT_V02.md) as seeds for "a future self-learning layer." `corrects` is half-wired (it hides and inherits). `relates_to` is still dormant. This design activates the temporal half.

Zep / Graphiti makes this its core idea: every fact carries validity intervals, and tracks event time separately from ingestion time, so facts can be invalidated and superseded with full history. It beat MemGPT on the Deep Memory Retrieval benchmark ([Rasmussen et al., 2025](https://arxiv.org/abs/2501.13956)). Pebble does not need a graph database to get the useful 80% of this. Two columns and a stamp do it.

## Design

### Schema (migration v0.5)

Add to `logs`, following the exact pattern in [src/migrate.js:54](../src/migrate.js):

```sql
ALTER TABLE logs ADD COLUMN valid_from TEXT;      -- defaults to timestamp
ALTER TABLE logs ADD COLUMN valid_to TEXT;        -- NULL = currently believed
ALTER TABLE logs ADD COLUMN invalidated_by INTEGER; -- the entry that superseded it
```

New migration block:

```js
if (version < 0.5) {
  const cols = new Set(db.prepare('PRAGMA table_info(logs)').all().map(c => c.name));
  if (!cols.has('valid_from')) {
    db.exec(`ALTER TABLE logs ADD COLUMN valid_from TEXT;
             ALTER TABLE logs ADD COLUMN valid_to TEXT;
             ALTER TABLE logs ADD COLUMN invalidated_by INTEGER;`);
  }
  // Backfill: every existing row was valid from its timestamp.
  db.prepare('UPDATE logs SET valid_from = timestamp WHERE valid_from IS NULL').run();
  // Retro-stamp anything an existing correction pointed at.
  db.prepare(`
    UPDATE logs SET
      valid_to = (SELECT c.timestamp FROM logs c WHERE c.corrects = logs.id ORDER BY c.id DESC LIMIT 1),
      invalidated_by = (SELECT c.id FROM logs c WHERE c.corrects = logs.id ORDER BY c.id DESC LIMIT 1)
    WHERE id IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)
  `).run();
  setVersion(db, 0.5);
  console.error('pebbl: migrated db to v0.5 (bi-temporal corrects)');
}
```

The backfill makes the whole existing history bi-temporal retroactively. No data loss, additive only.

### Write path

In `log.js`, when `flags.corrects` is set, after the current inheritance logic, stamp the target:

```js
db.prepare(
  'UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL'
).run(ts, newId, correctsId);
```

New rows get `valid_from = ts`, `valid_to = NULL`. The `AND valid_to IS NULL` guard means correcting an already-superseded entry does not overwrite the original supersession (see edge cases).

### Read paths

Replace the subquery filter with an explicit, indexable predicate everywhere context/search list "current" memory:

```sql
-- was: id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)
-- now:
WHERE valid_to IS NULL
```

Add an index: `CREATE INDEX IF NOT EXISTS idx_logs_valid_to ON logs(valid_to)`.

### New query surface

```bash
pebbl context --as-of 2026-03-15   # memory as it was believed on that date
pebbl log --history <id>            # the full supersession chain for one entry
```

`--as-of` predicate:

```sql
WHERE valid_from <= :date AND (valid_to IS NULL OR valid_to > :date)
```

## Constraint check

- **No internal LLM.** Pure SQL and timestamps.
- **Local-first, no deps.** Two nullable columns plus one integer.
- **Backward compatible.** Additive migration; the backfill converts old corrections automatically. Old `corrects` links keep working.
- **Activates dormant schema.** This is the "future self-learning layer" the v0.2 design pre-paid for.

## Harness integration

Gives the agent a way to reason about decision *evolution*, not just current state: "we used sessions, switched to JWT in March because of horizontal scaling, then added refresh rotation in April." That trajectory is exactly the kind of context that stops a later agent from re-litigating a settled choice.

Pairs with [design-reflect.md](./design-reflect.md): a reflection over a correction chain ("we keep reverting caching choices") is high-signal. And the bi-temporal shape is the on-ramp to a fuller entity/edge layer (Zep-style) later, without another migration of the existing data.

## Risks and open questions

- **Correction chains.** A corrected-by-B, B corrected-by-C: each correction stamps only its direct target. `valid_to IS NULL` then yields only C. The `AND valid_to IS NULL` write guard keeps A's original stamp intact. Verify with a 3-link test.
- **Correcting an old belief.** If `--corrects` points at an already-superseded entry, the guard skips the stamp; warn the agent ("entry #N was already superseded by #M; recording the link but not changing the timeline"). Decide later whether to support branching history. v1: linear only.
- **Scope.** This is the minimal bi-temporal step. It does not build entities/edges or relationship typing. That is the GraphRAG/Zep direction, deliberately out of scope here.

## How to measure it

A knowledge-update fixture, the category LongMemEval ([arXiv:2410.10813](https://arxiv.org/pdf/2410.10813)) weights heavily:

1. Log a decision, then `--corrects` it with a new one.
2. Assert `pebbl context` shows only the new belief.
3. Assert `pebbl context --as-of <before-correction>` shows the old one.
4. Assert search ranks the current belief above the superseded one.

Deterministic, scriptable, no judge needed.

## Effort and files

Low.

- `src/migrate.js` — v0.5 block above.
- `src/db.js` — add the three columns to the fresh-install `SCHEMA`, add the index.
- `src/log.js` — stamp the target on `--corrects`; set `valid_from` on insert.
- `src/context.js` + `src/search.js` — swap the subquery filter for `valid_to IS NULL`; add `--as-of`.
- `src/args.js` — add `as-of`, `history` to `KNOWN_FLAGS` (`history` is boolean).
