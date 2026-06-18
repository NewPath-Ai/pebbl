#!/usr/bin/env node
'use strict';
// Background qmd reindex worker — P4. Launched DETACHED by qmdUpdateDeferred
// (src/qmd.js) so `pebbl log` returns after only the ms-scale fold + markdown
// write while the 7-9s (~80s with embeddings) qmd reindex runs out of band.
//
// It does nothing but call the SAME synchronous qmdUpdate the inline path used
// (one reindex implementation — DRY); the only thing P4 changed is WHERE it
// runs (a detached child, not the foreground). Errors are swallowed: a failed
// background reindex must never surface as a non-zero exit that could be noticed
// by a parent (there is none — we're detached) or pollute a terminal. The index
// just stays stale until the next write/rebuild, which BM25 search tolerates.

const { qmdUpdate } = require('./qmd');

const pebblDir = process.argv[2];
if (!pebblDir) process.exit(0);

try {
  qmdUpdate(pebblDir);
} catch {
  // best-effort background work — never throw
}
process.exit(0);
