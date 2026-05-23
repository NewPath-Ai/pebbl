'use strict';
const { requireMemDir } = require('./find-mem');
const { qmdQuery } = require('./qmd');

module.exports = function search(query) {
  if (!query || !query.trim()) {
    console.error('Usage: pebbl search "[query]"');
    process.exit(1);
  }

  const memDir = requireMemDir();
  const raw = qmdQuery(memDir, query.trim());

  if (!raw.trim()) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  console.log(raw.trim());
  console.log('---\n');
};
