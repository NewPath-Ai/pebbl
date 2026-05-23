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
