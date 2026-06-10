# Pebbl

Node.js CLI for local project memory. Stores decisions, handoffs, and commit
context in SQLite under `.pebbl/`. Entry point: `bin/pebbl.js`.

## Commands

```bash
node --test test/                    # full suite
node --test test/search.test.js      # one file
node bin/pebbl.js <subcommand>       # run the CLI from source
pebbl --help                         # subcommand reference
```

No build step, no linter configured. Don't add either without asking.

## Architecture

```
bin/pebbl.js     - CLI entry; arg dispatch only, no logic
src/args.js      - flag parsing
src/db.js        - SQLite schema + queries (better-sqlite3)
src/<verb>.js    - one file per subcommand (log, search, context, handoff, compact, ...)
src/rubric.js    - auto-classification of entries missing --cat
src/find-pebbl.js - locates the nearest .pebbl/ upward from cwd
test/            - node:test, one file per src module
notes/           - design notes, not shipped
plans/           - in-progress refactor plans, not shipped
```

Subcommand files in `src/` are the unit of change. Adding a verb means a new
`src/<verb>.js`, a dispatch line in `bin/pebbl.js`, and a `test/<verb>.test.js`.

## Conventions

- CommonJS (`require`), Node 18+, no transpile
- Every `src/` module gets a matching `test/` file
- SQL lives in `src/db.js`; other modules call its exported functions, never
  run raw queries
- User-facing CLI output goes through helpers in the relevant verb module, not
  `console.log` scattered across files

## Dogfooding

This repo uses its own CLI for memory. Before changing behavior:

```bash
node bin/pebbl.js context
node bin/pebbl.js search "<area you're touching>"
```

Log decisions and failed approaches as you go. See [PEBBL.md](PEBBL.md)
for `--cat` / `--topic` / `--tier` semantics — don't reinvent them here.

## Traces

Every workflow run ends with a trace. An agent failure that produces no trace and no workflow update is a wasted failure.

At the start of any workflow run, search for prior traces:

```bash
node bin/pebbl.js search "trace <workflow-name>" --cat quality
```

At the end, log the outcome:

```bash
node bin/pebbl.js log "trace: <workflow> <succeeded|failed|partial> for <task> — path: <step>→<step>→<step>[; deviation: <what> because <why>][; failed-at: <step> because <why>; fix: <where fix landed>]" \
  --cat quality --topic trace,<workflow> --source agent
```

Rules:
- `--cat quality` and `--topic trace,<workflow>` are always required
- Every `deviation` and `failed-at` clause needs `because` (or "to prevent", "so that") — no rationale, no value
- `--corrects` is not valid on trace entries — traces are append-only history
- One trace per run, logged at terminal state only (success, failure, or abandonment)

## Boundaries

- Never modify `package-lock.json` by hand — let npm regenerate
- Never edit files in `node_modules/`
- Never bump `version` in `package.json` — release flow handles it
- Never add a dependency without asking; the dep list is intentionally tiny
- Never write to `.pebbl/` directly in code — go through `src/db.js`
- Ask before changing the SQLite schema; migrations live in `src/migrate.js`
  and must be additive

## Permissions

Autonomous: read, edit `src/` and `test/`, run tests, run the CLI locally.

Ask first: install/remove packages, git commit/push, edit `package.json` or
`bin/pebbl.js` dispatch, schema migrations, anything in `notes/` or `plans/`
(those are the user's working docs).

## More

- User-facing usage: [README.md](README.md)
- Flag and category reference: [PEBBL.md](PEBBL.md)
- Eval setup: [EVAL_HARNESS.md](EVAL_HARNESS.md)
