# Pebbl — Project Memory Protocol

Pebbl is a local CLI memory tool scoped to this repository. It stores decisions, failed approaches, and commit context as searchable entries. Use it to avoid repeating mistakes and to understand why the codebase is the way it is.

## When to use it

- At the start of every session, before touching any code
- Before suggesting an approach you aren't certain about
- After any decision, failure, or pivot worth remembering

## How to use it

```bash
pebbl context              # always run this first
pebbl search "auth"        # before working on any feature
pebbl search "why did we"  # before suggesting an approach
pebbl log "message"        # after any significant decision or failure
```

## What to log

- Approaches that failed and why
- Decisions made and the reasoning behind them
- Constraints discovered during implementation
- Verification gates and decisive findings — log them the moment they land, not at handoff close. A handoff is a recap; the atomic log is the searchable record.
- Anything you'd want to know at the start of the next session
- Session handoffs when done working (`pebbl handoff "summary" --done "..." --todo "..."`)

## What not to log

- Every small code change — the git hook handles that automatically
- Things already obvious from the code itself




## Pebbl — Project Memory Protocol

Pebbl stores architecture decisions, conventions, and component facts for this codebase.
Agents use it to avoid burning tokens re-discovering what's already known.

### Start of every session
```bash
pebbl context                    # recent entries, all tiers
pebbl context --topic <area>     # entries for a specific component
pebbl search "topic" --cat decision  # search decisions before proposing an approach
```

### Logging — ALWAYS use --cat and --topic

Every `pebbl log` call **must** include `--cat` and `--topic`. Entries without
these flags are hard to find and impossible to filter.

| Category    | When to use |
|-------------|-------------|
| decision    | Choices made, rationale, constraints, trade-offs |
| structure   | Component boundaries, module topology, ownership |
| pattern     | Conventions, coding standards, design patterns |
| data        | Models, schemas, storage choices, data flow |
| integration | APIs, contracts, cross-component interfaces |
| quality     | Perf targets, SLAs, security posture |

```bash
pebbl log "chose Redis for caching" --cat decision --topic auth
pebbl log "modules split into store and renderer" --cat structure --topic notes,renderer
pebbl log "all dates use ISO 8601" --cat pattern --topic conventions
```

### End of every session — handoff

Use `pebbl handoff` to create a structured handoff for the next agent. This captures
what you did, what remains, and auto-collects your session's log entries and commits:
```bash
pebbl handoff "built auth module, chose bcrypt" \
  --done "password hashing; login endpoint; tests" \
  --todo "forgot-password flow; rate limiting" \
  --topic auth --source agent
```

**Write `--done`/`--todo`/`--blocked` as `;`-separated atomic items.** On close each
item becomes its own searchable block. One long run-on with no `;` materializes as a
single wall of text that search can't localize within — pebbl warns you when a field
looks like that. Keep each item short and self-contained.

The next agent sees the handoff automatically via `pebbl context`. When they've
picked up the work, they close it:
```bash
pebbl handoff --close
```

Closing a handoff:
- Materializes the handoff to `handoffs.md`, one searchable block per `;`-split item
  (summary/done/todo/blocked are kept structured in the handoffs table — they are NOT
  flattened into a single log entry)
- Marks session detail entries as compaction-eligible
- Clears the handoff from `pebbl context`

Other handoff commands:
```bash
pebbl handoff --latest          # show the most recent handoff
pebbl handoff --list            # list recent handoffs
```

**Fallback (if pebbl < 0.3):** use the `[session]` log format:
```bash
pebbl log "[session] summary of work" --topic <area> --source agent
```

### Correcting a past entry
```bash
pebbl log "switched from Redis to Postgres" --cat decision --topic auth --corrects <id>
```

### Compaction (when notified)
```bash
pebbl compact --preview
pebbl compact --execute --resolve 12:foundation,15:rollup,18:skip
```

### What to log
- Architecture decisions and why (--cat decision)
- Component boundaries and ownership (--cat structure)
- Conventions and patterns adopted (--cat pattern)
- Constraints and failed approaches (--cat decision)

### Entry quality — always explain WHY

The most important part of a decision entry is the rationale. Future agents need to
understand WHY a choice was made, not just WHAT was chosen. Without rationale, agents
may revert decisions or reintroduce already-solved problems.

Bad (mechanics only):
```bash
pebbl log "threshold is 0.5, weight is 0.6, W*fit + (1-W)*scorecard formula"
```
This reads like a spec sheet. A future agent sees "0.5" and has no idea if it's
arbitrary, empirical, or structural. It will guess or change it.

Good (rationale included):
```bash
pebbl log "threshold is 0.5 because Professional Services touches every industry at
0.2-0.4, which is too weak for meaningful knowledge transfer"
```
The WHY is included. The future agent knows what problem this solves.

Rule of thumb: if your entry reads like config documentation, you forgot the rationale.
Use "because", "to prevent", "so that", or "the problem is" to connect mechanics to
motivation. Entries that only list parameters (default, threshold, weight, score, blend,
config, param, formula) with numbers get auto-tagged as detail tier — they will
persist but are flagged as lower-authority than component/foundation entries with proper rationale.

### What not to log
- Routine code changes (git hook captures those)
- Anything obvious from reading the code
