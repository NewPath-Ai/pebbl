'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'manual',
  message   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  hash      TEXT NOT NULL,
  message   TEXT NOT NULL,
  files     TEXT
);
`;

function openDb(memDir) {
  const db = new Database(path.join(memDir, 'db.sqlite'));
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
