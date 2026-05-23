'use strict';
const { execSync, spawnSync } = require('child_process');

function qmdAvailable() {
  const result = spawnSync('which', ['qmd'], { encoding: 'utf8' });
  return result.status === 0;
}

function qmdCollectionCreate(pebblDir) {
  execSync(`qmd collection create "${pebblDir}"`, { stdio: 'inherit' });
}

function qmdUpdate(pebblDir) {
  if (!qmdAvailable()) return;
  spawnSync('qmd', ['update', pebblDir], { stdio: 'ignore' });
}

function qmdQuery(pebblDir, query) {
  if (!qmdAvailable()) {
    console.error('qmd not found. Install it: npm install -g qmd');
    process.exit(1);
  }
  const result = spawnSync('qmd', ['query', query, '--collection', pebblDir], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

module.exports = { qmdAvailable, qmdCollectionCreate, qmdUpdate, qmdQuery };
