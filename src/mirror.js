'use strict';
const fs = require('fs');
const path = require('path');

// Readers for .pebbl/mirror/<machine>/ — other machines' synced memory
// projections (manual-logs.md, handoffs.md), copied in by the factory sync
// jobs. Read-only by convention: nothing in pebbl may ever write under
// mirror/ — the sync job owns it, and these files regenerate from the OTHER
// machine's db.sqlite, so a local edit would be silently lost anyway.
// With no mirror/ directory every reader returns [], keeping all callers
// inert until mirrors exist.

const LOG_META_RE = /<!--\s*cat:(\S+)\s+topic:(\S*)\s+tier:(\S+)\s+source:(\S+)\s*-->/;
const HANDOFF_META_RE = /<!--\s*handoff:(\d+)\s+field:(\S+)\s+topic:(\S*)(?:\s+status:(\S+))?\s*-->/;
const HEADER_RE = /^## (\S+) - (.*)$/;

function mirrorMachines(pebblDir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(pebblDir, 'mirror'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// Split a projection file into {timestamp, message, meta} blocks: a
// "## <ts> - <message>" header line plus the first HTML comment that
// follows it (the entry's metadata line).
function parseBlocks(content) {
  const blocks = [];
  let current = null;
  for (const line of content.split('\n')) {
    const h = line.match(HEADER_RE);
    if (h) {
      current = { timestamp: h[1], message: h[2].trim(), meta: '' };
      blocks.push(current);
    } else if (current && !current.meta && line.includes('<!--')) {
      current.meta = line;
    }
  }
  return blocks;
}

// Entries from machines' manual-logs.md, newest first.
// machine omitted → all machines.
function mirrorLogs(pebblDir, machine) {
  const machines = machine ? [machine] : mirrorMachines(pebblDir);
  const out = [];
  for (const m of machines) {
    const content = readFileOrNull(path.join(pebblDir, 'mirror', m, 'manual-logs.md'));
    if (!content) continue;
    for (const b of parseBlocks(content)) {
      const meta = b.meta.match(LOG_META_RE);
      if (!meta || !b.message) continue;
      out.push({
        machine: m,
        timestamp: b.timestamp,
        date: b.timestamp.slice(0, 10),
        message: b.message,
        cat: meta[1],
        topics: meta[2],
        tier: meta[3],
        source: meta[4],
      });
    }
  }
  out.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return out;
}

// Materialized handoff items from machines' handoffs.md, newest first.
// machine omitted → all machines.
function mirrorHandoffs(pebblDir, machine) {
  const machines = machine ? [machine] : mirrorMachines(pebblDir);
  const out = [];
  for (const m of machines) {
    const content = readFileOrNull(path.join(pebblDir, 'mirror', m, 'handoffs.md'));
    if (!content) continue;
    for (const b of parseBlocks(content)) {
      const meta = b.meta.match(HANDOFF_META_RE);
      if (!meta || !b.message) continue;
      out.push({
        machine: m,
        handoffId: meta[1],
        field: meta[2],
        topics: meta[3],
        status: meta[4] || 'closed',
        timestamp: b.timestamp,
        date: b.timestamp.slice(0, 10),
        message: b.message,
      });
    }
  }
  out.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return out;
}

// "handoff #12 todo: item" / "handoff #12: summary" → the bare text.
function stripHandoffPrefix(message) {
  const m = message.match(/^handoff #\d+ (?:summary|done|todo|blocked): (.+)$/i);
  return m ? m[1] : message.replace(/^handoff #\d+: /i, '');
}

module.exports = { mirrorMachines, mirrorLogs, mirrorHandoffs, stripHandoffPrefix, parseBlocks };
