'use strict';
// P1 — the read-side emitters: take the folded projection (src/fold.js) and
// write the disposable `view.sqlite` rows plus the 4 markdown files, BYTE-
// IDENTICAL to what today's db.sqlite-driven generation produces. The string
// templates here are lifted verbatim from the canonical generators so the
// committed/regenerated markdown is the same on every machine:
//   - manual-logs.md  : regenerateMarkdown (compact.js:143-159)
//   - handoffs.md     : materializeHandoffsMd (handoff.js:248-272)
//   - narrative.md    : writeNarrative (narrative.js:19-25)
//   - commit-log.md   : logCommit (log-commit.js:24)
// Reusing the EXACT templates is the whole point — re-deriving them would let
// the fold drift from the db path and break the never-committed-markdown
// safety guarantee (design "The fold").
//
// This module READS the folded rows; it does not change how compaction WRITES
// (that is P3) and it does NOT rewire openDb or rename db.sqlite (that is the
// P2/P6 cutover). It writes a SEPARATE `view.sqlite` artifact so the fold-
// equivalence test can compare it against the live db.sqlite without touching
// the existing read path.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { foldFull } = require('./fold');

// ── markdown emitters (byte-identical tails) ─────────────────────────────────

// manual-logs.md. regenerateMarkdown selects ALL logs ORDER BY timestamp ASC
// (no valid_to filter — corrected rows STAY in the markdown; only the live
// VIEW hides them). topicStr is `row.topics || ''`, source is the row source.
function renderManualLogsMd(logs) {
  const ordered = logs.slice().sort(byTimestampAscStable);
  let md = '# Manual Logs\n\n';
  for (const row of ordered) {
    const topicStr = row.topics || '';
    md += `## ${row.timestamp} - ${row.message}\n`;
    md += `<!-- cat:${row.category} topic:${topicStr} tier:${row.tier} source:${row.source} -->\n\n`;
  }
  return md;
}

// handoffs.md. materializeHandoffsMd orders handoffs by id ASC, emits a
// summary block + one block per ';'-split done/todo/blocked item, joined by
// '\n'. ts = closed_at || timestamp. Verbatim from handoff.js:248-272.
function splitItems(field) {
  if (!field) return [];
  return field.split(';').map((s) => s.trim()).filter(Boolean);
}
function renderHandoffsMd(handoffs) {
  const ordered = handoffs.slice().sort((a, b) => a.id - b.id);
  const out = ['# Handoffs', ''];
  for (const row of ordered) {
    const ts = row.closed_at || row.timestamp;
    const topic = row.topics || '';
    const status = row.status || 'open';
    const blocks = [['summary', `handoff #${row.id}: ${row.summary}`]];
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        blocks.push([field, `handoff #${row.id} ${field}: ${item}`]);
      }
    }
    for (const [field, message] of blocks) {
      out.push(`## ${ts} - ${message}`);
      out.push(`<!-- handoff:${row.id} field:${field} topic:${topic} status:${status} -->`);
      out.push('');
    }
  }
  return out.join('\n');
}

// narrative.md. writeNarrative format, verbatim from narrative.js:19-25. The
// folded narrative carries the LATEST narrative-set's text/refs/updated; the
// `<!-- updated: ts -->` uses that event's ts (not Date.now()) so the file is
// deterministic across machines. Returns '' when no narrative was ever set.
function renderNarrativeMd(narrative) {
  if (!narrative) return '';
  const refs = narrative.refs || [];
  const refsLine = refs.length > 0 ? `<!-- refs: ${refs.join(',')} -->\n` : '';
  return `# Project Narrative\n\n${(narrative.text || '').trim()}\n\n${refsLine}<!-- updated: ${narrative.updated} -->\n`;
}

// commit-log.md. logCommit APPENDS per commit; we render the whole file from
// the folded commit rows in order. Verbatim block from log-commit.js:24.
function renderCommitLogMd(commits) {
  let md = '';
  for (const c of commits) {
    const shortHash = (c.hash || 'unknown').slice(0, 8);
    const msg = (c.message || '').trim().split('\n')[0];
    const category = c.category || 'uncategorized';
    const tier = c.tier || 'fleeting';
    const fileList = (c.files || '').replace(/,$/, '');
    md += `## ${c.timestamp} - ${shortHash}: ${msg}\n`;
    md += `<!-- cat:${category} topic: tier:${tier} source:hook -->\n\n`;
    md += `Files: ${fileList || '(none)'}\n\n`;
  }
  return md;
}

// Stable timestamp-ASC sort. logs already arrive in (ts,emitted_at,eid) order
// from the fold, so a stable sort on timestamp preserves that tie-break — the
// same order db.sqlite's `ORDER BY timestamp ASC` yields for same-ts rows is
// insertion order, which the fold's deterministic order reproduces.
function byTimestampAscStable(a, b) {
  const at = a.timestamp || '';
  const bt = b.timestamp || '';
  if (at < bt) return -1;
  if (at > bt) return 1;
  return a.id - b.id; // stable tie-break by the assigned local int
}

// ── view.sqlite row writer ───────────────────────────────────────────────────
//
// Build a disposable view.sqlite with the SAME logs/handoffs/commits schema
// db.sqlite uses, populated from the folded rows. INTEGER ids/corrects/
// relates_to come straight from the eid->int map (FK translation), so the
// read-side subqueries (`valid_to IS NULL`, `id NOT IN (...)`, `b.id - a.id`)
// behave identically off this view. Returns the file path.
const VIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY,
  timestamp  TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'human',
  category   TEXT    NOT NULL DEFAULT 'uncategorized',
  tier       TEXT    NOT NULL DEFAULT 'detail',
  message    TEXT    NOT NULL,
  topics     TEXT,
  relates_to INTEGER,
  corrects   INTEGER,
  valid_from TEXT,
  valid_to   TEXT,
  invalidated_by INTEGER
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
CREATE TABLE IF NOT EXISTS handoffs (
  id               INTEGER PRIMARY KEY,
  timestamp        TEXT    NOT NULL,
  summary          TEXT    NOT NULL,
  done             TEXT,
  todo             TEXT,
  blocked          TEXT,
  topics           TEXT,
  source           TEXT    NOT NULL DEFAULT 'agent',
  session_entries  TEXT,
  session_commits  TEXT,
  status           TEXT    NOT NULL DEFAULT 'open',
  closed_at        TEXT,
  promoted_log_id  INTEGER,
  docs             TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function writeViewSqlite(projection, viewPath) {
  // Fresh file every rebuild — the view is disposable.
  try { fs.unlinkSync(viewPath); } catch { /* not present, fine */ }
  const db = new Database(viewPath);
  try {
    db.exec(VIEW_SCHEMA);
    const insLog = db.prepare(`
      INSERT INTO logs (id, timestamp, source, category, tier, message, topics,
                        relates_to, corrects, valid_from, valid_to, invalidated_by)
      VALUES (@id, @timestamp, @source, @category, @tier, @message, @topics,
              @relates_to, @corrects, @valid_from, @valid_to, @invalidated_by)
    `);
    const insHandoff = db.prepare(`
      INSERT INTO handoffs (id, timestamp, summary, done, todo, blocked, topics,
                            source, session_entries, session_commits, status, closed_at, docs)
      VALUES (@id, @timestamp, @summary, @done, @todo, @blocked, @topics,
              @source, @session_entries, @session_commits, @status, @closed_at, @docs)
    `);
    const insCommit = db.prepare(`
      INSERT INTO commits (id, timestamp, hash, message, files)
      VALUES (@id, @timestamp, @hash, @message, @files)
    `);
    const tx = db.transaction(() => {
      for (const r of projection.logs) {
        insLog.run({
          id: r.id,
          timestamp: r.timestamp,
          source: r.source,
          category: r.category,
          tier: r.tier,
          message: r.message,
          topics: r.topics || null,
          relates_to: r.relates_to,
          corrects: r.corrects,
          valid_from: r.valid_from || r.timestamp,
          valid_to: r.valid_to,
          invalidated_by: r.invalidated_by,
        });
      }
      for (const h of projection.handoffs) {
        insHandoff.run({
          id: h.id,
          timestamp: h.timestamp,
          summary: h.summary,
          done: h.done,
          todo: h.todo,
          blocked: h.blocked,
          topics: h.topics,
          source: h.source,
          session_entries: JSON.stringify(h.session_entries || []),
          session_commits: JSON.stringify(h.session_commits || []),
          status: h.status,
          closed_at: h.closed_at,
          docs: h.docs,
        });
      }
      for (const c of projection.commits) {
        insCommit.run({
          id: c.id,
          timestamp: c.timestamp,
          hash: c.hash,
          message: c.message,
          files: c.files || null,
        });
      }
    });
    tx();
  } finally {
    db.close();
  }
  return viewPath;
}

// ── top-level rebuild: events -> view.sqlite + 4 markdown files ──────────────
//
// The target the P0 `rebuild(rows)` seam (events.js:appendLogEvent) is meant
// to fill in. Pure-ish: writes files under pebblDir, returns the projection.
// view.sqlite is written as `view.sqlite` (NOT db.sqlite) so the existing read
// path P2 migrates is untouched (Guardrail: P1 may write a view.sqlite artifact
// but must not rewire openDb or rename db.sqlite).
function rebuildView(pebblDir, events) {
  const projection = foldFull(events);
  fs.writeFileSync(path.join(pebblDir, 'manual-logs.md'), renderManualLogsMd(projection.logs));
  fs.writeFileSync(path.join(pebblDir, 'handoffs.md'), renderHandoffsMd(projection.handoffs));
  const narrativeMd = renderNarrativeMd(projection.narrative);
  if (narrativeMd) {
    fs.writeFileSync(path.join(pebblDir, 'narrative.md'), narrativeMd);
  }
  fs.writeFileSync(path.join(pebblDir, 'commit-log.md'), renderCommitLogMd(projection.commits));
  writeViewSqlite(projection, path.join(pebblDir, 'view.sqlite'));
  return projection;
}

module.exports = {
  renderManualLogsMd,
  renderHandoffsMd,
  renderNarrativeMd,
  renderCommitLogMd,
  writeViewSqlite,
  rebuildView,
  splitItems,
};
