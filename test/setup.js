'use strict';
// Shared test setup — incident 2026-06-18 (post-commit embed thrash).
//
// THE PROBLEM: `node --test` runs test files in parallel; many of them
// `pebbl init` a temp repo and then make a burst of fixture commits. Each commit
// fires the post-commit hook -> `pebbl log-commit` -> a real `qmd update` embed.
// `qmd` is installed on dev machines, so the bare test suite once spawned dozens
// of concurrent embeds and drove the Mac to load ~154 (near-unresponsive).
//
// THE FIX (DRY): set the embed-bypass env var ONCE, here, at module load. Every
// test file does `require('./setup');` as its first line. Because requiring this
// module runs BEFORE any `describe`/`it`, the var is set before any test shells
// out — and child processes (`execSync`/`spawnSync`, which inherit process.env)
// carry it through git -> the post-commit hook -> `pebbl log-commit`, which then
// writes the commit-log/db row but skips the `qmd update` embed.
//
// Result: bare `node --test` triggers ZERO live embeds (Acceptance point 1, the
// must-not-regress). A test that specifically wants to exercise the real embed
// can delete this from its own child env, but no test should need to.
//
// We set PEBBL_DISABLE_EMBED (the embed-specific name). PEBBL_NO_HOOK is the
// other honored alias (see src/qmd.js embedDisabled); setting either is enough.
process.env.PEBBL_DISABLE_EMBED = '1';

module.exports = {};
