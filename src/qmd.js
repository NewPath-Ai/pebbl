'use strict';
const { execSync, spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

function qmdAvailable() {
  const result = spawnSync('which', ['qmd'], { encoding: 'utf8' });
  return result.status === 0;
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
  if (!qmdAvailable()) return;
  // Self-heal: register the collection if it isn't there yet, so projects
  // that pre-date this naming change get wired up on first write rather
  // than only on `pebbl init`.
  qmdCollectionCreate(pebblDir);
  spawnSync('qmd', ['update', pebblDir], { stdio: 'ignore' });
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

module.exports = { qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdUpdateDeferred, qmdQuery, collectionName };
