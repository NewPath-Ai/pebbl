'use strict';
const fs = require('fs');
const path = require('path');

// A read-only discovery index over a repo's source docs (research/decision
// markdown that lives OUTSIDE .pebbl, e.g. sources/). Source docs are NOT
// memory entries: no tier, no compaction, no rubric, never written to
// db.sqlite. They are external truth, re-read from disk on every search.
// Surfaced in `pebbl search` tagged [source] and ranked BELOW curated
// entries, mirroring the [machine] mirror surface — so a decision buried in
// a source doc is findable even when no one logged a pointer entry, while a
// real logged decision always outranks raw research for the same query.

// Configured source dirs resolved to absolute paths under the repo root
// (pebblDir's parent). Config shape: `sources:\n  dirs: a,b,c`. Default
// 'sources'. Missing dirs are simply skipped, so the index is inert until a
// repo actually has source docs.
function sourceDirs(pebblDir, config) {
  const cfg = (config && config.sources && config.sources.dirs) || 'sources';
  const repoRoot = path.dirname(path.resolve(pebblDir));
  return String(cfg)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(d => path.resolve(repoRoot, d));
}

function walkMd(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable dir → contributes nothing
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
}

// Every *.md under the configured dirs, absolute paths.
function sourceFiles(pebblDir, config) {
  const files = [];
  for (const dir of sourceDirs(pebblDir, config)) walkMd(dir, files);
  return files;
}

// A readable one-line excerpt around the first match.
function excerpt(text, idx, qlen) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + qlen + 90);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}

// Substring search over source docs. One hit per file (the first match, as an
// excerpt) so a long doc can't flood results. Read live from disk, so a
// deleted source file drops out on the next search. cat/topic filters do NOT
// apply — source docs carry no category or topic; they are unfiltered
// discovery, always ranked last by the caller.
function searchSources(pebblDir, query, config, limit = 10) {
  const q = (query || '').toLowerCase();
  if (!q) return [];
  const repoRoot = path.dirname(path.resolve(pebblDir));
  const results = [];
  for (const file of sourceFiles(pebblDir, config)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    results.push({
      isSource: true,
      source: path.relative(repoRoot, file),
      message: excerpt(text, idx, query.length),
    });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = { sourceDirs, sourceFiles, searchSources, excerpt };
