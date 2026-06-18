'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('./migrate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'human',
  category   TEXT    NOT NULL DEFAULT 'uncategorized',
  tier       TEXT    NOT NULL DEFAULT 'detail',
  message    TEXT    NOT NULL,
  topics     TEXT,
  relates_to INTEGER,
  corrects   INTEGER,
  valid_from TEXT,           -- when this belief started being true (defaults to timestamp)
  valid_to   TEXT,           -- when it stopped being true; NULL = currently believed
  invalidated_by INTEGER     -- the entry that superseded it
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
CREATE TABLE IF NOT EXISTS handoffs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0.3');
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_tier ON logs(tier);
CREATE INDEX IF NOT EXISTS idx_logs_valid_to ON logs(valid_to);
`;

function openDb(pebblDir) {
  // P4 — lazy staleness on the read path. Before handing back a handle, bring
  // view.sqlite + the 4 markdown files up to date with events.jsonl if a
  // post-merge/post-checkout (or a concurrent append on another machine) added
  // lines since the last fold. This is what makes "new view rows surface after
  // an append with NO manual rebuild" true on the very next command, and what
  // lets the git hooks stay lazy (they only touch a sentinel; the fold happens
  // here on the next read). Cheap when already fresh (a fingerprint compare, no
  // fold) and a no-op when this process already holds the store lock (we're
  // mid-write — see staleness.ensureFresh's re-entrancy guard). Best-effort: a
  // staleness failure must never break opening db.sqlite (the canonical store).
  try {
    require('./staleness').ensureFresh(pebblDir);
  } catch {
    // never let the lazy fold break the canonical read path
  }
  const db = new Database(path.join(pebblDir, 'db.sqlite'));
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

module.exports = { openDb };

function topicFilter(topic) {
  return {
    clause: "AND (',' || topics || ',' LIKE ? OR topics = ? OR topics LIKE ? || ',' OR topics LIKE ',' || ?)",
    params: [`%,${topic},%`, topic, topic, topic],
  };
}

module.exports.topicFilter = topicFilter;

// Single source of truth for "this entry is the current belief" — i.e. it has
// not been superseded by a correction. As of v0.5 (bi-temporal supersession)
// this is the stamped predicate `valid_to IS NULL`, replacing the old
// `id NOT IN (SELECT corrects ...)` subquery that HID the corrected row and
// lost the timeline. Centralizing it keeps every read site using one
// definition so they cannot drift (DRY). Returns a parameter-free SQL fragment;
// prefix with AND/WHERE as needed.
function notCorrected() {
  return 'valid_to IS NULL';
}

// Beliefs valid AT a given date (bi-temporal point-in-time query): a row was
// believed if it had started (valid_from <= date) and had not yet stopped
// (valid_to is still open, or stopped strictly after the date). Returns a
// fragment with two '?' placeholders; bind the same date twice.
function validAsOf() {
  return 'valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)';
}

module.exports.notCorrected = notCorrected;
module.exports.validAsOf = validAsOf;
