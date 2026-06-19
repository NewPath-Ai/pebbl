'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { _internal } = require('../src/scan-commits');
const { uncapturedDecisions, bestEntryOverlap, words, DEFAULT_DECISION_RE: RE } = _internal;
const BIN = path.resolve(__dirname, '../bin/pebbl.js');

describe('scan-commits - uncapturedDecisions', () => {
  it('suggests a decision-shaped commit with no matching entry', () => {
    const out = uncapturedDecisions(
      [{ hash: 'a1', subject: 'chose Postgres over Mongo for the ledger' }], [], RE);
    assert.equal(out.length, 1);
    assert.equal(out[0].hash, 'a1');
  });

  it('does NOT suggest a decision already logged (dedupe by word overlap)', () => {
    const commits = [{ hash: 'a1', subject: 'chose Postgres over Mongo for the ledger' }];
    const entries = ['we chose Postgres for the ledger storage']; // shares chose, postgres, ledger
    assert.equal(uncapturedDecisions(commits, entries, RE).length, 0);
  });

  it('does NOT suggest a non-decision commit (fix typo)', () => {
    assert.equal(uncapturedDecisions([{ hash: 'b2', subject: 'fix typo in README' }], [], RE).length, 0);
  });

  it('still suggests a decision when only an unrelated entry exists (low overlap)', () => {
    const commits = [{ hash: 'c3', subject: 'adopted bcrypt for password hashing' }];
    const entries = ['decided on a different topic entirely about rendering'];
    assert.equal(uncapturedDecisions(commits, entries, RE).length, 1);
  });
});

describe('scan-commits - helpers', () => {
  it('words drops short + stop words and dedupes', () => {
    assert.deepEqual(words('We chose the Redis cache for the cache').sort(), ['cache', 'chose', 'redis']);
  });
  it('bestEntryOverlap counts distinctive-word overlap against entries', () => {
    assert.equal(bestEntryOverlap('chose Redis caching', [new Set(['chose', 'redis', 'unrelated'])]), 2);
    assert.equal(bestEntryOverlap('chose Redis caching', [new Set(['totally', 'different'])]), 0);
  });
});

describe('scan-commits - integration (hook auto-capture is excluded from dedupe)', () => {
  it('nudges a decision commit until it is INTENTIONALLY logged', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-scan-'));
    const sh = (c) => execSync(c, { cwd: repo, stdio: 'ignore' });
    const out = (c) => execSync(c, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      sh('git init -q'); sh('git config user.email t@t.i'); sh('git config user.name t');
      sh(`node "${BIN}" init`);
      fs.writeFileSync(path.join(repo, 'a'), 'x'); sh('git add -A');
      sh('git commit -qm "chose Redis over Memcached for the session cache"');
      // The hook auto-captured the commit (source=hook); scan must STILL nudge it.
      assert.match(out(`node "${BIN}" scan-commits`), /Redis over Memcached/);
      // Log it intentionally → the next scan must NOT re-nudge it.
      sh(`node "${BIN}" log "chose Redis over Memcached for the session cache" --cat decision`);
      assert.doesNotMatch(out(`node "${BIN}" scan-commits`), /pebbl log .*Redis over Memcached/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
