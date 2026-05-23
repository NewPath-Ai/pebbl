'use strict';
const { execSync, spawnSync } = require('child_process');

function qmdAvailable() {
  const result = spawnSync('which', ['qmd'], { encoding: 'utf8' });
  return result.status === 0;
}

function qmdCollectionCreate(memDir) {
  execSync(`qmd collection create "${memDir}"`, { stdio: 'inherit' });
}

function qmdUpdate(memDir) {
  // Non-fatal — if qmd isn't installed, skip silently
  if (!qmdAvailable()) return;
  spawnSync('qmd', ['update', memDir], { stdio: 'ignore' });
}

function qmdQuery(memDir, query) {
  if (!qmdAvailable()) {
    console.error('qmd not found. Install it: npm install -g qmd');
    process.exit(1);
  }
  const result = spawnSync('qmd', ['query', query, '--collection', memDir], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

module.exports = { qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdQuery };
