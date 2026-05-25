'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');

function getNarrativePath(pebblDir) {
  return path.join(pebblDir, 'narrative.md');
}

function readNarrative(pebblDir) {
  const p = getNarrativePath(pebblDir);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8').trim();
  if (!content || content === '# Project Narrative') return null;
  return content;
}

function writeNarrative(pebblDir, text) {
  const p = getNarrativePath(pebblDir);
  const ts = new Date().toISOString();
  const content = `# Project Narrative\n\n${text.trim()}\n\n<!-- updated: ${ts} -->\n`;
  fs.writeFileSync(p, content);
}

function narrative(args) {
  const { flags, positional } = parseArgs(args);
  const pebblDir = requirePebblDir();

  if (flags.show || (positional.length === 0 && !flags.generate)) {
    const content = readNarrative(pebblDir);
    if (content) {
      console.log(content);
    } else {
      console.log('No narrative set yet.');
      console.log('');
      console.log('The narrative is a short description of what this project does.');
      console.log('It helps agents understand the project without reading all decisions.');
      console.log('');
      console.log('Set one with:');
      console.log('  pebbl narrative "Your project description here"');
    }
    return;
  }

  if (flags.generate) {
    console.log('To generate a narrative, review your foundation decisions:');
    console.log('  pebbl context --tier foundation');
    console.log('');
    console.log('Then write a narrative that captures the key points:');
    console.log('  pebbl narrative "This project is..."');
    return;
  }

  // Set/update the narrative
  const text = positional.join(' ').trim();
  if (!text) {
    console.error('Usage: pebbl narrative "Your project description"');
    process.exit(1);
  }

  writeNarrative(pebblDir, text);
  console.log('Narrative updated.');
}

module.exports = narrative;
module.exports.readNarrative = readNarrative;
module.exports.writeNarrative = writeNarrative;
module.exports.getNarrativePath = getNarrativePath;
