'use strict';
// Per-store advisory lockfile. pebbl has no locking today (no flock, no
// busy_timeout, no WAL), so the append+rebuild path can interleave with a
// concurrent local write on the same store and lose or tear a write. This
// is the safety floor for every later write path, pulled forward to P0.
//
// Mechanism: O_EXCL create of `.pebbl/.events.lock`. O_EXCL is atomic at
// the filesystem layer — exactly one creator wins even under a race, so it
// works across processes (the shared-checkout case), not just threads.
// We scope the lock to append+rebuild only, as the design requires.

const fs = require('fs');
const path = require('path');

const LOCK_NAME = '.events.lock';
const STALE_MS = 30 * 1000; // a lock older than this is treated as abandoned
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const POLL_MS = 25;

// In-process held-lock set, keyed by lockfile path. The on-disk lock is an
// O_EXCL file (NOT reentrant — a second tryAcquire in the same process would
// EEXIST against our own lock and spin to the timeout), so a caller that is
// ALREADY inside a withLock for this store must not try to take it again. The
// lazy staleness check (staleness.js) consults isLocked() to skip its fold when
// it would re-enter a lock the write path already holds — closing the
// openDb→ensureFresh→withLock deadlock during a `pebbl log`/`compact`.
const heldLocks = new Set();

function sleep(ms) {
  // Synchronous spin-wait. The critical section (append a line + fold a
  // small tail) is sub-millisecond, so contention windows are tiny and a
  // brief blocking wait is simpler and safer than threading async through
  // every caller (orthogonality: callers stay synchronous like the rest of
  // pebbl's command code).
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

function lockPath(pebblDir) {
  return path.join(pebblDir, LOCK_NAME);
}

function tryAcquire(lp) {
  try {
    // wx = O_CREAT | O_EXCL | O_WRONLY: fails if the file already exists.
    const fd = fs.openSync(lp, 'wx');
    fs.writeSync(fd, String(process.pid) + '\n');
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function clearStale(lp) {
  try {
    const st = fs.statSync(lp);
    if (Date.now() - st.mtimeMs > STALE_MS) {
      fs.unlinkSync(lp);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Acquire the lock, run fn(), always release — even on throw. Returns
// whatever fn returns. Blocks (spin-polling) up to timeoutMs for a held
// lock, then reclaims an abandoned (stale) lock so a crashed writer can't
// wedge the store forever.
function withLock(pebblDir, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lp = lockPath(pebblDir);
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (true) {
    if (tryAcquire(lp)) { held = true; break; }
    if (Date.now() > deadline) {
      clearStale(lp);
      if (tryAcquire(lp)) { held = true; break; }
      throw new Error(`pebbl: could not acquire store lock at ${lp} within ${timeoutMs}ms`);
    }
    sleep(POLL_MS);
  }
  heldLocks.add(lp);
  try {
    return fn();
  } finally {
    if (held) {
      heldLocks.delete(lp);
      try { fs.unlinkSync(lp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
}

// True if THIS process currently holds the store lock for pebblDir. Used by the
// lazy staleness check to avoid re-entering a lock the surrounding write path
// already holds (the O_EXCL lock is not reentrant).
function isLocked(pebblDir) {
  return heldLocks.has(lockPath(pebblDir));
}

module.exports = { withLock, lockPath, isLocked };
