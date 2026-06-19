'use strict';
const { execSync, spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Embed bypass — incident 2026-06-18. When either env var is set, every embed
// path (sync `qmdUpdate` AND the detached `qmdUpdateDeferred`) becomes a no-op,
// so a `git commit` writes the commit-log/db row but NEVER spawns `qmd update`.
// The test harness sets PEBBL_DISABLE_EMBED process-wide (test/setup.js) so that
// bare `node --test` — which makes dozens of fixture commits in parallel — fires
// ZERO live embeds. PEBBL_NO_HOOK is honored too as the operator/CI escape hatch
// named in the incident write-up. We read process.env at call time (not module
// load) so a var set by a parent still propagates through git -> hook ->
// `pebbl log-commit` -> here.
function embedDisabled() {
  return !!(process.env.PEBBL_DISABLE_EMBED || process.env.PEBBL_NO_HOOK);
}

function qmdAvailable() {
  const result = spawnSync('which', ['qmd'], { encoding: 'utf8' });
  return result.status === 0;
}

// Single-flight lock per .pebbl store — incident 2026-06-18. Two near-simultaneous
// commits could each fire a full `qmd update` for the SAME store, doubling (or
// N-tupling) the CPU for no benefit (the reindex is idempotent — a second run
// produces the same index). The lockfile caps concurrency at 1 embed per store.
//
// Strategy = SKIP, not queue. If the lock is already held by a LIVE process, the
// new caller marks the store dirty (a sentinel file) and returns immediately.
// When the in-flight run finishes it checks the dirty flag and re-runs ONCE, so
// the last writer's content is never lost — a newer update supersedes, it doesn't
// get dropped. (We chose dirty-re-run over a plain skip specifically so a commit
// landing mid-embed still gets indexed without waiting for the next commit.)
//
// acquire uses fs.openSync(..., 'wx') — atomic exclusive-create, the POSIX lock
// primitive — so the check-and-take is race-free across processes. A stale lock
// from a crashed/killed embed (PID no longer alive) is STOLEN rather than
// honored, so a single dead worker can't wedge a store forever.
const LOCK_NAME = '.qmd-update.lock';
const DIRTY_NAME = '.qmd-update.dirty';

function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence/permission probe, kills nothing
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it — still alive.
    return e.code === 'EPERM';
  }
}

// Try to take the per-store lock. Returns true if acquired, false if another
// LIVE process already holds it (in which case we marked the store dirty).
function acquireLock(pebblDir) {
  const lockPath = path.join(pebblDir, LOCK_NAME);
  try {
    const fd = fs.openSync(lockPath, 'wx'); // atomic create-or-fail
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Lock exists. Steal it if the holder is dead (stale lock); otherwise the
    // holder is live — mark dirty so it re-runs, and back off.
    let holder = 0;
    try { holder = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch { holder = 0; }
    if (!pidAlive(holder)) {
      try { fs.unlinkSync(lockPath); } catch { /* someone else won the steal — fine */ }
      return acquireLock(pebblDir);
    }
    try { fs.writeFileSync(path.join(pebblDir, DIRTY_NAME), ''); } catch { /* best effort */ }
    return false;
  }
}

function releaseLock(pebblDir) {
  try { fs.unlinkSync(path.join(pebblDir, LOCK_NAME)); } catch { /* already gone */ }
}

function takeDirty(pebblDir) {
  const dirtyPath = path.join(pebblDir, DIRTY_NAME);
  try {
    if (fs.existsSync(dirtyPath)) { fs.unlinkSync(dirtyPath); return true; }
  } catch { /* best effort */ }
  return false;
}

// Derive a stable per-project collection name. Previously every project
// registered the literal name 'pebbl' — qmd collection names are global, so
// only the last `qmd collection add` won and every other project's `pebbl
// search` silently returned the wrong repo's data. The name combines the
// project basename (for readability) with a short hash of the absolute path
// (for collision safety when two projects share a basename).
function collectionName(pebblDir) {
  const abs = path.resolve(pebblDir);
  const projectName = path.basename(path.dirname(abs)) || 'pebbl';
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 6);
  return `pebbl-${projectName}-${hash}`;
}

function collectionExists(name) {
  const r = spawnSync('qmd', ['collection', 'show', name], { encoding: 'utf8' });
  return r.status === 0;
}

function qmdCollectionCreate(pebblDir) {
  const name = collectionName(pebblDir);
  if (collectionExists(name)) return;

  const r = spawnSync('qmd', ['collection', 'add', pebblDir, '--name', name], { encoding: 'utf8' });
  if (r.status === 0) return;

  // Migration case: a pre-existing collection already covers this path under a
  // different name (typically the literal 'pebbl' from before per-project
  // naming). qmd rejects path duplicates, so rename it to the derived name
  // instead of leaving an orphan behind.
  const combined = (r.stderr || '') + (r.stdout || '');
  if (/already exists for this path/i.test(combined)) {
    const m = combined.match(/Name:\s+(\S+)/);
    if (m && m[1] !== name) {
      const renamed = spawnSync('qmd', ['collection', 'rename', m[1], name], { encoding: 'utf8' });
      if (renamed.status === 0) return;
      throw new Error(`qmd collection rename ${m[1]} → ${name} failed: ${renamed.stderr || renamed.stdout}`);
    }
  }
  throw new Error(`qmd collection add failed: ${combined.trim() || 'unknown error'}`);
}

function qmdUpdate(pebblDir) {
  if (embedDisabled()) return; // incident 2026-06-18: hard bypass for tests/CI
  if (!qmdAvailable()) return;
  // Single-flight: if another live process is already embedding this store, mark
  // it dirty and bail rather than launch a duplicate reindex.
  if (!acquireLock(pebblDir)) return;
  try {
    // Loop so a commit that landed mid-embed (which set the dirty flag) still
    // gets indexed without waiting for the next commit. Re-run while dirty.
    do {
      takeDirty(pebblDir); // clear BEFORE the run so writes during it re-dirty
      // Self-heal: register the collection if it isn't there yet, so projects
      // that pre-date this naming change get wired up on first write rather
      // than only on `pebbl init`.
      qmdCollectionCreate(pebblDir);
      spawnSync('qmd', ['update', pebblDir], { stdio: 'ignore' });
    } while (takeDirty(pebblDir));
  } finally {
    releaseLock(pebblDir);
  }
}

// Deferred (background) qmd update — P4. The synchronous `qmdUpdate` above is
// a measured 7-9s reindex (~80s with embeddings) and was called INLINE from
// `pebbl log` (log.js), so every write blocked on it; in some environments the
// qmd subprocess blocks effectively forever. P4 takes it off the foreground:
// `pebbl log` returns after only the ms-scale SQLite fold + markdown write, and
// the qmd reindex runs in a DETACHED background process that outlives the
// parent. `pebbl search` is BM25, so a few-seconds-stale index is still correct.
//
// Mechanism: spawn `node qmd-worker.js <pebblDir>` detached + unref'd, with all
// stdio ignored, so the parent's event loop has nothing tying it to the child
// and exits immediately. The worker calls the SAME synchronous `qmdUpdate` (one
// reindex implementation — DRY); only the SCHEDULING is new here. We do NOT wait
// on, and never throw from, the spawn: a failed/absent background reindex must
// never break or slow the canonical write. Returns the child's pid (or null if
// not scheduled) so callers/tests can assert a job was kicked without waiting
// for the embed to finish.
function qmdUpdateDeferred(pebblDir) {
  if (embedDisabled()) return null; // incident 2026-06-18: hard bypass for tests/CI
  // Skip the spawn entirely when qmd isn't installed — nothing to defer, and we
  // avoid launching a process that would immediately no-op.
  if (!qmdAvailable()) return null;
  const worker = path.join(__dirname, 'qmd-worker.js');
  try {
    const child = spawn(process.execPath, [worker, pebblDir], {
      detached: true,
      stdio: 'ignore',
    });
    // Sever the child from the parent's lifecycle so the foreground command can
    // exit while the reindex continues in the background.
    child.unref();
    return child.pid || null;
  } catch {
    // A failed background schedule is non-fatal: the index just stays stale
    // until the next write/rebuild. Never let it break the foreground write.
    return null;
  }
}

function qmdQuery(pebblDir, query) {
  if (!qmdAvailable()) {
    console.error('qmd not found. Install it: npm install -g @tobilu/qmd');
    process.exit(1);
  }
  qmdCollectionCreate(pebblDir);
  // Ask qmd for a wider candidate pool (-n 20) rather than its top-5 default.
  // The `--cat`/`--topic` filter runs in JS (parseQmdResults) AFTER qmd returns,
  // so with the default cap a filtered search could discard all 5 hits and
  // report "No results" even when matches exist further down the ranking.
  const result = spawnSync('qmd', ['search', query, '-c', collectionName(pebblDir), '-n', '20'], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

module.exports = {
  qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdUpdateDeferred, qmdQuery, collectionName,
  embedDisabled,
  // exposed for tests of the single-flight lock
  _lock: { acquireLock, releaseLock, takeDirty, pidAlive, LOCK_NAME, DIRTY_NAME },
};
