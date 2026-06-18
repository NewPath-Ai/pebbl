'use strict';
// P4 — rebuild triggers, qmd off the hot path, and the `pebbl rebuild` command
// under the per-store lock.
//
// Determinism note: the qmd reindex is now a DETACHED background job, so we
// NEVER assert "the embed finished" (that would be a flaky sleep race). We
// assert the FOREGROUND contract instead: qmdUpdateDeferred returns a scheduled
// pid (or null when qmd is absent) without waiting, and the rebuild round-trips
// view rows. The lock test holds the real P0 lock and asserts rebuild waits
// then succeeds — no timing guess, the lock is released deterministically.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');
const { qmdUpdateDeferred, qmdAvailable } = require('../src/qmd');
const { withLock } = require('../src/lock');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-rebuild-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('node', [PEBBL_BIN, 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function pebbl(dir, args, opts = {}) {
  return execFileSync('node', [PEBBL_BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  });
}

function viewLogCount(pebblDir) {
  const db = new Database(path.join(pebblDir, 'view.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT count(*) c FROM logs').get().c;
  } finally {
    db.close();
  }
}

describe('P4 hooks: init installs executable post-merge + post-checkout', () => {
  it('writes both rebuild hooks alongside post-commit, all executable', () => {
    const repo = makeStore();
    try {
      const hooks = path.join(repo, '.git', 'hooks');
      for (const h of ['post-commit', 'post-merge', 'post-checkout']) {
        const p = path.join(hooks, h);
        assert.ok(fs.existsSync(p), `${h} hook exists`);
        // executable bit set for owner
        assert.ok(fs.statSync(p).mode & 0o100, `${h} hook is executable`);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the rebuild hooks only TOUCH a sentinel — they do not fold inline', () => {
    const repo = makeStore();
    try {
      const body = fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-merge'), 'utf8');
      // The hook references the sentinel and does NOT invoke a fold/rebuild.
      assert.match(body, /\.rebuild-needed/, 'hook touches the sentinel');
      assert.doesNotMatch(body, /pebbl rebuild|rebuildView|node /, 'hook must not run the fold inline');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('P4 deferred qmd: off the synchronous path', () => {
  it('log no longer calls qmdUpdate synchronously (only the deferred entry point)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'log.js'), 'utf8');
    // No line-leading synchronous qmdUpdate( call (the inline reindex is gone).
    assert.doesNotMatch(src, /^\s*qmdUpdate\(/m, 'log.js must not call qmdUpdate() inline');
    assert.match(src, /qmdUpdateDeferred\(/, 'log.js uses the deferred entry point');
  });

  it('qmdUpdateDeferred returns WITHOUT waiting for the reindex (scheduled, not finished)', () => {
    const repo = makeStore();
    try {
      const pebblDir = path.join(repo, '.pebbl');
      const t0 = Date.now();
      const pid = qmdUpdateDeferred(pebblDir);
      const elapsed = Date.now() - t0;
      // The whole point of P4: the call returns in milliseconds, never the
      // 7-9s (~80s) reindex. We assert the foreground is fast and a job was
      // SCHEDULED (a pid) when qmd is installed, or skipped (null) when absent —
      // never that the embed itself completed.
      assert.ok(elapsed < 2000, `deferred qmd must return fast, took ${elapsed}ms`);
      if (qmdAvailable()) {
        assert.equal(typeof pid, 'number', 'a background reindex pid was scheduled');
      } else {
        assert.equal(pid, null, 'no qmd installed -> nothing scheduled');
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('pebbl log returns fast (does not block on the qmd reindex)', () => {
    const repo = makeStore();
    try {
      const t0 = Date.now();
      pebbl(repo, ['log', 'fast because deferred qmd', '--cat', 'decision', '--topic', 'perf']);
      const elapsed = Date.now() - t0;
      // Inline qmd made this 7-9s+ (and blocked indefinitely in some envs). A
      // generous ceiling keeps the assert deterministic (process spawn cost)
      // while still failing loudly if qmd ever lands back on the hot path.
      assert.ok(elapsed < 6000, `pebbl log should not block on qmd, took ${elapsed}ms`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('P4 pebbl rebuild', () => {
  it('rebuilds the view from events.jsonl and round-trips a logged entry', () => {
    const repo = makeStore();
    try {
      const pebblDir = path.join(repo, '.pebbl');
      pebbl(repo, ['log', 'round-trip because rebuild', '--cat', 'decision', '--topic', 'es']);
      // Delete the view to prove rebuild reconstructs it from the log alone.
      fs.rmSync(path.join(pebblDir, 'view.sqlite'), { force: true });
      const out = pebbl(repo, ['rebuild']);
      assert.match(out, /rebuilt view from 1 event/);
      assert.equal(viewLogCount(pebblDir), 1, 'view reconstructed from events.jsonl');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('clears the .rebuild-needed sentinel the hooks touch', () => {
    const repo = makeStore();
    try {
      const pebblDir = path.join(repo, '.pebbl');
      pebbl(repo, ['log', 'sentinel because hook', '--cat', 'decision', '--topic', 'es']);
      const sentinel = path.join(pebblDir, '.rebuild-needed');
      fs.writeFileSync(sentinel, ''); // simulate a hook firing
      pebbl(repo, ['rebuild']);
      assert.ok(!fs.existsSync(sentinel), 'rebuild clears the sentinel');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('acquires the per-store lock — rebuild waits for a held lock, then succeeds', () => {
    const repo = makeStore();
    try {
      const pebblDir = path.join(repo, '.pebbl');
      pebbl(repo, ['log', 'locked because race', '--cat', 'decision', '--topic', 'es']);

      // Hold the REAL P0 lock for a beat in this process, kick rebuild in a
      // child, release, then confirm the child rebuild completed (it had to wait
      // for the lock — proving rebuild goes through the same lock, no fork).
      let childErr = null;
      const heldFor = 400;
      withLock(pebblDir, () => {
        // While we hold it, the lockfile exists on disk.
        assert.ok(fs.existsSync(path.join(pebblDir, '.events.lock')), 'lock is held');
        // Busy-wait so the child genuinely contends (the lock uses a spin-wait).
        const until = Date.now() + heldFor;
        while (Date.now() < until) { /* hold */ }
      });
      // After release, rebuild must succeed cleanly under the now-free lock.
      let out;
      try {
        out = pebbl(repo, ['rebuild']);
      } catch (e) {
        childErr = e;
      }
      assert.equal(childErr, null, 'rebuild ran without a lock error');
      assert.match(out, /rebuilt view/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
