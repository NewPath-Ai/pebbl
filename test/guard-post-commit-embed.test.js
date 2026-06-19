'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const qmd = require('../src/qmd');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-guard-'));
  const sh = (c, opts = {}) => execSync(c, { cwd: repo, stdio: 'ignore', ...opts });
  sh('git init -q');
  sh('git config user.email t@t.i');
  sh('git config user.name t');
  sh(`node "${BIN}" init`);
  return { repo, sh };
}

function qmdUpdateProcs() {
  // Count live `qmd update` processes (the embed we must not fan out).
  const r = spawnSync('pgrep', ['-f', 'qmd update'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── Acceptance point 2: bypass var suppresses the embed but still writes the row.
describe('guard: PEBBL_DISABLE_EMBED bypass (acceptance #2)', () => {
  it('a commit writes the commit-log/db row but spawns no qmd update', () => {
    const { repo, sh } = mkRepo();
    try {
      const before = qmdUpdateProcs().length;
      fs.writeFileSync(path.join(repo, 'f'), 'x');
      sh('git add f');
      // setup.js set PEBBL_DISABLE_EMBED=1 process-wide; the child inherits it.
      sh('git commit -qm "guard bypass commit"');

      // The commit row must still be captured (bypass skips ONLY the embed).
      const commitLog = fs.readFileSync(path.join(repo, '.pebbl', 'commit-log.md'), 'utf8');
      assert.match(commitLog, /guard bypass commit/, 'commit-log row should be written');

      // No new live embed should have been spawned.
      assert.equal(qmdUpdateProcs().length, before, 'no qmd update should be running');
      // And no lockfile should linger (nothing acquired it).
      assert.equal(fs.existsSync(path.join(repo, '.pebbl', '.qmd-update.lock')), false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('embedDisabled() reflects both env-var aliases', () => {
    const saved = { d: process.env.PEBBL_DISABLE_EMBED, h: process.env.PEBBL_NO_HOOK };
    try {
      delete process.env.PEBBL_DISABLE_EMBED;
      delete process.env.PEBBL_NO_HOOK;
      assert.equal(qmd.embedDisabled(), false);
      process.env.PEBBL_NO_HOOK = '1';
      assert.equal(qmd.embedDisabled(), true, 'PEBBL_NO_HOOK alias honored');
      delete process.env.PEBBL_NO_HOOK;
      process.env.PEBBL_DISABLE_EMBED = '1';
      assert.equal(qmd.embedDisabled(), true, 'PEBBL_DISABLE_EMBED honored');
    } finally {
      // Restore the harness-wide bypass.
      if (saved.d === undefined) delete process.env.PEBBL_DISABLE_EMBED; else process.env.PEBBL_DISABLE_EMBED = saved.d;
      if (saved.h === undefined) delete process.env.PEBBL_NO_HOOK; else process.env.PEBBL_NO_HOOK = saved.h;
    }
  });
});

// ── Acceptance point 3: the hook-path embed is backgrounded, so a commit returns
// promptly. With the bypass on we can't time a real embed, so we assert the two
// load-bearing facts: (a) log-commit kicks the DEFERRED (detached) path, not the
// blocking one, and (b) a bypassed commit returns far faster than an embed.
describe('guard: embed is backgrounded, never blocks the commit (acceptance #3)', () => {
  it('log-commit uses the detached qmdUpdateDeferred, not the blocking qmdUpdate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'log-commit.js'), 'utf8');
    assert.match(src, /qmdUpdateDeferred/, 'hook path must use the deferred (detached) embed');
    assert.doesNotMatch(src, /[^a-zA-Z]qmdUpdate\(/, 'hook path must not call the blocking qmdUpdate directly');
  });

  it('qmdUpdateDeferred spawns detached (does not block) and is greppable', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'qmd.js'), 'utf8');
    assert.match(src, /detached:\s*true/, 'deferred embed must spawn detached');
  });

  it('a commit returns promptly (well under an embed) under the bypass', () => {
    const { repo, sh } = mkRepo();
    try {
      fs.writeFileSync(path.join(repo, 'f'), 'x');
      sh('git add f');
      const t0 = Date.now();
      sh('git commit -qm "prompt return"');
      const ms = Date.now() - t0;
      // A real synchronous embed is 7-9s (~80s with embeddings). A bypassed/backgrounded
      // commit must return in well under that. 5s is a generous ceiling for CI noise.
      assert.ok(ms < 5000, `commit took ${ms}ms — should return promptly, not block on an embed`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── Acceptance point 4: single-flight lock — two near-simultaneous embeds for the
// SAME store can't both run. Exercised at the lock level (no real qmd needed).
describe('guard: single-flight lock per store (acceptance #4)', () => {
  const { acquireLock, releaseLock, takeDirty, pidAlive, LOCK_NAME, DIRTY_NAME } = qmd._lock;

  function mkStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-lock-'));
    fs.mkdirSync(path.join(dir, '.pebbl'));
    return path.join(dir, '.pebbl');
  }

  it('first acquire wins; a second concurrent acquire is refused and marks dirty', () => {
    const store = mkStore();
    try {
      assert.equal(acquireLock(store), true, 'first acquire should win');
      // While held by THIS live process, a second acquire must be refused...
      assert.equal(acquireLock(store), false, 'second acquire must be refused (single-flight)');
      // ...and it must have marked the store dirty so the holder re-runs.
      assert.equal(fs.existsSync(path.join(store, DIRTY_NAME)), true, 'refused caller marks dirty');
      assert.equal(takeDirty(store), true, 'dirty flag is consumable');
      assert.equal(takeDirty(store), false, 'dirty flag clears after one take');
      releaseLock(store);
      // After release the lock is free again.
      assert.equal(fs.existsSync(path.join(store, LOCK_NAME)), false, 'lock removed on release');
      assert.equal(acquireLock(store), true, 'acquire succeeds again after release');
      releaseLock(store);
    } finally {
      fs.rmSync(path.dirname(store), { recursive: true, force: true });
    }
  });

  it('a STALE lock (dead PID) is stolen, not honored forever', () => {
    const store = mkStore();
    try {
      // Plant a lock owned by a PID that cannot be alive (well above any real pid).
      const deadPid = 2147483646;
      assert.equal(pidAlive(deadPid), false, 'sanity: planted pid is dead');
      fs.writeFileSync(path.join(store, LOCK_NAME), String(deadPid));
      // A new caller should STEAL the stale lock and acquire it.
      assert.equal(acquireLock(store), true, 'stale lock should be stolen');
      // The lockfile is now owned by us.
      assert.equal(fs.readFileSync(path.join(store, LOCK_NAME), 'utf8').trim(), String(process.pid));
      releaseLock(store);
    } finally {
      fs.rmSync(path.dirname(store), { recursive: true, force: true });
    }
  });

  it('qmdUpdate is a no-op under the bypass, so it never touches the lock', () => {
    const store = mkStore();
    try {
      // Harness bypass is on → qmdUpdate returns immediately without locking/spawning.
      qmd.qmdUpdate(store);
      assert.equal(fs.existsSync(path.join(store, LOCK_NAME)), false, 'no lock under bypass');
    } finally {
      fs.rmSync(path.dirname(store), { recursive: true, force: true });
    }
  });
});
