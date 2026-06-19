# Incident: post-commit hook embed thrash (2026-06-18)

## What happened
A factory agent running the pebbl test suite in the `pebbl--rerank-live-wire`
worktree drove the Mac to **load average ~154 on 10 cores** (15x oversubscription).
At peak: **62 concurrent `qmd update` processes (~673% CPU)** plus 27 orphaned
`qmd-worker.js` leaks. Individual embed jobs ran **40-46 minutes without finishing**
because every process was CPU-starved. The machine was at real risk of going
unresponsive. Resolved by SIGTERM/SIGKILL of 75 processes; load decayed afterward.

## Root cause
The `post-commit` git hook does a **synchronous, unbounded full embed on every commit**.

Chain:
```
git commit
  -> .git/hooks/post-commit            (HOOK_SCRIPT, src/init.js:35-40)
     -> pebbl log-commit               (src/log-commit.js)
        -> qmdUpdate(pebblDir)         (src/log-commit.js:38)
           -> spawnSync('qmd','update',...)   (src/qmd.js:58)  <-- BLOCKING full embed
```

`node --test` runs test files in parallel; each test creates a temp repo, runs
`pebbl init` (which installs this hook), then makes many fixture commits
(messages like `base`, `chose Redis over Memcached for the session cache`).
Every fixture commit fires a full synchronous embed. Dozens stack up in parallel
-> thrash.

### The tell
`src/log-commit.js:40` carries the comment `// Never block a commit`, but
`qmdUpdate` at line 38 is `spawnSync` — synchronous — so it **does** block the
commit until the embed finishes. The intent was written down; the implementation
contradicts it. (Same intent-carry-gap pattern seen elsewhere in the factory.)

## Why it bites
- No async: the embed runs in the foreground of the commit.
- No concurrency cap / lock: N parallel commits -> N parallel embeds.
- No test bypass: fixture commits trigger real embeds they don't need.
- No load guard / nice: embeds can starve interactive work and WindowServer.
- Worker leak: `qmd-worker.js` children orphan to PPID 1 and never get reaped.

## Proposed guardrails (not yet implemented — pending Ashley's go)
1. **Test bypass (highest leverage, smallest change).** Hook + `log-commit`
   honor an env var (e.g. `PEBBL_NO_HOOK=1` / `PEBBL_DISABLE_EMBED=1`) and skip
   `qmdUpdate`. The test harness sets it globally. Fixture commits should never
   trigger real embeds.
2. **Honor "never block a commit": background the embed.** Replace the hook-path
   `spawnSync` with a detached `spawn` (`detached:true, stdio:'ignore', .unref()`)
   so the commit returns instantly.
3. **Single-flight lock per store.** A lockfile in `.pebbl`; if an update is
   already running, mark the store dirty and return (a newer update supersedes).
   Caps concurrency at 1 per store even in real use.
4. **nice the qmd process** so embeds can't starve interactive work (defense in depth).
5. **Load circuit-breaker.** Skip/defer the embed when system load already
   exceeds ~cores. Cheap insurance.
6. **Reap workers.** Ensure `qmd update` children don't orphan (timeout + kill).

Minimal fix for *this* incident: (1)+(2)+(3).

## Operational note
If this recurs, the diagnostic is:
`ps -Ao pid,%cpu,etime,command -r | grep qmd` + `sysctl -n vm.loadavg`.
Kill set: `qmd.js`, `qmd-worker.js`, `pebbl* log-commit`, `.git/hooks/post-commit`,
`node --test`. Git commits hung on the hook complete on their own once the hook dies
(post-commit failure is non-fatal to the commit).
