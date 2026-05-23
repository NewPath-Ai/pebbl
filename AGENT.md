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
- Anything you'd want to know at the start of the next session

## What not to log

- Every small code change — the git hook handles that automatically
- Things already obvious from the code itself
