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
  corrects   INTEGER
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
`;

function openDb(pebblDir) {
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

// Single source of truth for "this entry has not been superseded by a
// correction." An entry is superseded when some OTHER entry's `corrects`
// column points at its id. context.js already inlined this exact subquery in
// three places (topic index, recent, full view); centralizing it keeps the
// compaction nag and the rollup using the same definition so they cannot drift
// (DRY). Returns a parameter-free SQL fragment; prefix with AND/WHERE as needed.
function notCorrected() {
  return 'id NOT IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)';
}

module.exports.notCorrected = notCorrected;
