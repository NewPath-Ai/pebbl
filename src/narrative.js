'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
// Projection-boundary secret mask: narrative.md is committed + gate-scanned.
// The original narrative text lives in the event log (a narrative-set event)
// untouched; only this rendered file is sanitized.
const { redact } = require('./privacy-scan');

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

function writeNarrative(pebblDir, text, refs) {
  const p = getNarrativePath(pebblDir);
  const ts = new Date().toISOString();
  const refsLine = refs && refs.length > 0 ? `<!-- refs: ${refs.join(',')} -->\n` : '';
  const content = `# Project Narrative\n\n${redact(text.trim())}\n\n${refsLine}<!-- updated: ${ts} -->\n`;
  fs.writeFileSync(p, content);
}

function readRefs(pebblDir) {
  const p = getNarrativePath(pebblDir);
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, 'utf8');
  const match = content.match(/<!-- refs: ([\d,]+) -->/);
  if (!match) return [];
  return match[1].split(',').map(Number).filter(n => !isNaN(n));
}

function readUpdatedTimestamp(pebblDir) {
  const p = getNarrativePath(pebblDir);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8');
  const match = content.match(/<!-- updated: (.+?) -->/);
  return match ? match[1] : null;
}

function updateRefs(pebblDir, db) {
  const currentRefs = readRefs(pebblDir);
  if (currentRefs.length === 0) return { updated: false, staleCount: 0 };

  // Find corrections to referenced entries
  let updated = false;
  const newRefs = currentRefs.map(refId => {
    const correction = db.prepare(
      'SELECT id FROM logs WHERE corrects = ? ORDER BY id DESC LIMIT 1'
    ).get(refId);
    if (correction) {
      updated = true;
      return correction.id;
    }
    return refId;
  });

  if (updated) {
    // Rewrite narrative with updated refs (preserve text)
    const narrative = readNarrative(pebblDir);
    if (narrative) {
      // Extract just the text (strip the markdown header and comments)
      const text = narrative
        .replace(/^# Project Narrative\s*\n*/m, '')
        .replace(/<!--.*?-->\s*/g, '')
        .trim();
      writeNarrative(pebblDir, text, newRefs);
    }
  }

  return { updated, staleCount: updated ? 1 : 0 };
}

function narrative(args) {
  const { flags, positional } = parseArgs(args);
  const pebblDir = requirePebblDir();

  // --refresh: re-link foundation refs and re-stamp the timestamp WITHOUT
  // rewriting the narrative body. Gives the drift nag a real, non-destructive
  // remedy. Must run before the show/empty guard so it isn't swallowed.
  if (flags.refresh) {
    const existing = readNarrative(pebblDir);
    if (!existing) {
      console.error('No narrative to refresh. Set one first with: pebbl narrative "..."');
      process.exit(1);
    }
    // Preserve the current body verbatim; only refs + timestamp change.
    const text = existing
      .replace(/^# Project Narrative\s*\n*/m, '')
      .replace(/<!--.*?-->\s*/g, '')
      .trim();
    const { openDb } = require('./db');
    const db = openDb(pebblDir);
    const foundationEntries = db.prepare(
      "SELECT id FROM logs WHERE tier = 'foundation' ORDER BY id"
    ).all();
    const refs = foundationEntries.map(e => e.id);
    writeNarrative(pebblDir, text, refs);
    if (refs.length > 0) {
      console.log(`Narrative refreshed. Re-linked to ${refs.length} foundation entries.`);
    } else {
      console.log('Narrative refreshed.');
    }
    return;
  }

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

  // Trap guard: an unknown flag like `--refresh` is fail-open parsed into
  // positional text. If the sole token looks like a flag, refuse rather than
  // silently overwriting the narrative with the literal flag string.
  // This guard lives HERE (the SET branch), NOT in writeNarrative — updateRefs
  // reuses writeNarrative with legitimately short bodies and must not be blocked.
  if (positional.length === 1 && positional[0].startsWith('--')) {
    console.error(`pebbl: '${positional[0]}' is not a valid narrative — looks like an unknown flag.`);
    console.error('Did you mean: pebbl narrative --refresh   (re-link refs, keep text)');
    console.error('Or set text:  pebbl narrative "Your project description"');
    process.exit(1);
  }

  // Back up an existing meaningful narrative before overwriting, so an
  // accidental overwrite is recoverable from narrative.md.bak.
  const existingBody = readNarrative(pebblDir);
  if (existingBody) {
    const bakPath = getNarrativePath(pebblDir) + '.bak';
    fs.writeFileSync(bakPath, fs.readFileSync(getNarrativePath(pebblDir), 'utf8'));
  }

  // Collect foundation entry refs
  const { openDb } = require('./db');
  const db = openDb(pebblDir);
  const foundationEntries = db.prepare(
    "SELECT id FROM logs WHERE tier = 'foundation' ORDER BY id"
  ).all();
  const refs = foundationEntries.map(e => e.id);

  writeNarrative(pebblDir, text, refs);
  if (refs.length > 0) {
    console.log(`Narrative updated. Linked to ${refs.length} foundation entries.`);
  } else {
    console.log('Narrative updated.');
  }
}

module.exports = narrative;
module.exports.readNarrative = readNarrative;
module.exports.writeNarrative = writeNarrative;
module.exports.getNarrativePath = getNarrativePath;
module.exports.readRefs = readRefs;
module.exports.readUpdatedTimestamp = readUpdatedTimestamp;
module.exports.updateRefs = updateRefs;
