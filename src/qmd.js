'use strict';
const { execSync, spawnSync } = require('child_process');
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

function qmdQuery(pebblDir, query) {
  if (!qmdAvailable()) {
    console.error('qmd not found. Install it: npm install -g @tobilu/qmd');
    process.exit(1);
  }
  qmdCollectionCreate(pebblDir);
  const result = spawnSync('qmd', ['search', query, '-c', collectionName(pebblDir)], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

module.exports = { qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdQuery, collectionName };
