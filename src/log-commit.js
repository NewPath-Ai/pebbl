'use strict';
const fs = require('fs');
const path = require('path');
const { findPebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdateDeferred, embedDisabled } = require('./qmd');
const { loadRubric, classifyEntry } = require('./rubric');

module.exports = function logCommit(hash, message, files) {
  try {
    const pebblDir = findPebblDir();
    if (!pebblDir) return;

    const ts = new Date().toISOString();
    const shortHash = (hash || 'unknown').slice(0, 8);
    const msg = (message || '').trim().split('\n')[0];
    const fileList = (files || '').replace(/,$/, '');

    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, msg);
    const category = classified ? classified.category : 'uncategorized';
    const tier = 'fleeting';

    const md = `## ${ts} - ${shortHash}: ${msg}\n<!-- cat:${category} topic: tier:${tier} source:hook -->\n\nFiles: ${fileList || '(none)'}\n\n`;
    fs.appendFileSync(path.join(pebblDir, 'commit-log.md'), md);

    const db = openDb(pebblDir);
    db.prepare(`
      INSERT INTO commits (timestamp, hash, message, files)
      VALUES (?, ?, ?, ?)
    `).run(ts, hash, msg, fileList);

    db.prepare(`
      INSERT INTO logs (timestamp, source, category, tier, message, topics)
      VALUES (?, 'hook', ?, 'fleeting', ?, NULL)
    `).run(ts, category, msg);

    // Reindex for `pebbl search`. Two guardrails from incident 2026-06-18:
    //  1. BYPASS — when PEBBL_NO_HOOK / PEBBL_DISABLE_EMBED is set (the test
    //     harness sets it process-wide), skip the embed entirely so a burst of
    //     fixture commits fires ZERO `qmd update`. The named env vars must appear
    //     in THIS file (and in the hook template) so the bypass is greppable and
    //     honored before we ever reach qmd.
    //  2. BACKGROUND — match the "Never block a commit" intent below: kick the
    //     reindex as a DETACHED, unref'd child (qmdUpdateDeferred) so the commit
    //     returns immediately instead of blocking on the 7-9s (~80s) embed. The
    //     single-flight lock inside qmdUpdate caps it at 1 embed per store.
    if (!embedDisabled()) qmdUpdateDeferred(pebblDir);
  } catch {
    // Never block a commit
  }
};
