'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { shouldRouteLocal } = require('../src/log');
const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function sh(repo, cmd, env) {
  execFileSync('bash', ['-c', cmd], { cwd: repo, stdio: 'ignore', env: { ...process.env, ...(env || {}) } });
}
function tryShExit(repo, cmd, env) {
  try {
    execFileSync('bash', ['-c', cmd], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...(env || {}) } });
    return 0;
  } catch (e) {
    return e.status == null ? 1 : e.status;
  }
}
function mkrepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  sh(repo, 'git init -q && git config user.email a@b.c && git config user.name t');
  return repo;
}

describe('privacy init — hooks installed additively', () => {
  it('installs pre-commit AND pre-push WITHOUT clobbering post-commit/post-merge/post-checkout', () => {
    const repo = mkrepo('pebbl-hooks-');
    try {
      sh(repo, `node "${BIN}" init`);
      const hooks = path.join(repo, '.git', 'hooks');
      for (const h of ['pre-commit', 'pre-push', 'post-commit', 'post-merge', 'post-checkout']) {
        const p = path.join(hooks, h);
        assert.ok(fs.existsSync(p), `${h} should exist`);
        // executable bit set
        assert.ok((fs.statSync(p).mode & 0o111) !== 0, `${h} should be executable`);
      }
      // the pre-commit/pre-push hooks shell into pebbl privacy-scan
      assert.match(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), /privacy-scan --staged/);
      assert.match(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8'), /privacy-scan --push/);
      // the post-commit hook is the original log-commit hook (not clobbered)
      assert.match(fs.readFileSync(path.join(hooks, 'post-commit'), 'utf8'), /log-commit/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('re-init is idempotent and keeps every hook executable', () => {
    const repo = mkrepo('pebbl-reinit-');
    try {
      sh(repo, `node "${BIN}" init`);
      sh(repo, `node "${BIN}" init`); // second run
      for (const h of ['pre-commit', 'pre-push', 'post-commit']) {
        const p = path.join(repo, '.git', 'hooks', h);
        assert.ok((fs.statSync(p).mode & 0o111) !== 0, `${h} stays executable on re-init`);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('privacy init — gitignore for the two-file split', () => {
  it('gitignores events.local.jsonl (the private half)', () => {
    const repo = mkrepo('pebbl-ignore-');
    try {
      sh(repo, `node "${BIN}" init`);
      const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
      assert.match(gi, /events\.local\.jsonl/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('privacy init — pre-commit hook BLOCKS a leak (the whole point)', () => {
  it('refuses a commit that stages a non-RFC1918 IP+port and a cred path', () => {
    const repo = mkrepo('pebbl-block-');
    try {
      sh(repo, `node "${BIN}" init`);
      // stage a file with a real leak
      fs.writeFileSync(path.join(repo, 'leak.md'), 'droplet 67.207.93.196:48422 cred /etc/factory-updates-bot.env\n');
      sh(repo, 'git add leak.md');
      // the pre-commit hook must reject this (non-zero) — node_modules/.bin/pebbl
      // may not exist in this throwaway repo, so the hook falls back to PATH pebbl;
      // we make the hook find OUR pebbl by exporting a shim on PATH.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-bin-'));
      fs.writeFileSync(path.join(binDir, 'pebbl'), `#!/bin/sh\nexec node "${BIN}" "$@"\n`, { mode: 0o755 });
      fs.chmodSync(path.join(binDir, 'pebbl'), 0o755);
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      const code = tryShExit(repo, 'git commit -m "should be blocked"', env);
      assert.notEqual(code, 0, 'commit with a leak must be blocked by the pre-commit hook');
      // a clean commit passes
      fs.rmSync(path.join(repo, 'leak.md'));
      sh(repo, 'git reset -q');
      fs.writeFileSync(path.join(repo, 'clean.md'), 'chose bcrypt over argon2 because prod\n');
      sh(repo, 'git add clean.md');
      const okCode = tryShExit(repo, 'git commit -m "clean entry"', env);
      assert.equal(okCode, 0, 'a clean commit must pass the pre-commit hook');
      fs.rmSync(binDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('PEBBL_SKIP_SCAN=1 is an explicit escape hatch', () => {
    const repo = mkrepo('pebbl-skip-');
    try {
      sh(repo, `node "${BIN}" init`);
      fs.writeFileSync(path.join(repo, 'leak.md'), 'droplet 67.207.93.196:48422\n');
      sh(repo, 'git add leak.md');
      const code = tryShExit(repo, 'git commit -m "skip"', { PEBBL_SKIP_SCAN: '1' });
      assert.equal(code, 0, 'PEBBL_SKIP_SCAN bypasses the hook');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('privacy — foundation private-by-default routing (Q3=B)', () => {
  it('shouldRouteLocal: foundation on PUBLIC, no --share => LOCAL', () => {
    assert.equal(shouldRouteLocal({ tier: 'foundation', share: false, visibility: 'public' }), true);
  });
  it('shouldRouteLocal: foundation on PUBLIC with --share => SHARED', () => {
    assert.equal(shouldRouteLocal({ tier: 'foundation', share: true, visibility: 'public' }), false);
  });
  it('shouldRouteLocal: foundation on PRIVATE => SHARED (repo is the trust boundary)', () => {
    assert.equal(shouldRouteLocal({ tier: 'foundation', share: false, visibility: 'private' }), false);
  });
  it('shouldRouteLocal: foundation on UNKNOWN => SHARED (private-safe default)', () => {
    assert.equal(shouldRouteLocal({ tier: 'foundation', share: false, visibility: 'unknown' }), false);
  });
  it('shouldRouteLocal: non-foundation tiers are never private-by-default', () => {
    assert.equal(shouldRouteLocal({ tier: 'detail', share: false, visibility: 'public' }), false);
    assert.equal(shouldRouteLocal({ tier: 'component', share: false, visibility: 'public' }), false);
  });

  it('end-to-end: a foundation log on a PUBLIC remote lands in events.local.jsonl, NOT events.jsonl', () => {
    const repo = mkrepo('pebbl-route-pub-');
    try {
      sh(repo, `node "${BIN}" init`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      sh(repo, `node "${BIN}" log "the system uses sqlite because it is embedded" --tier foundation --cat decision`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      assert.ok(fs.existsSync(path.join(repo, '.pebbl', 'events.local.jsonl')), 'foundation event should be in the LOCAL file');
      assert.ok(!fs.existsSync(path.join(repo, '.pebbl', 'events.jsonl')), 'nothing should be in the SHARED file');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('end-to-end: --share publishes a foundation entry to events.jsonl even on a PUBLIC remote', () => {
    const repo = mkrepo('pebbl-route-share-');
    try {
      sh(repo, `node "${BIN}" init`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      sh(repo, `node "${BIN}" log "the system uses sqlite because it is embedded" --tier foundation --cat decision --share`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      assert.ok(fs.existsSync(path.join(repo, '.pebbl', 'events.jsonl')), '--share should write the SHARED file');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('end-to-end: a foundation log on a PRIVATE remote shares freely (events.jsonl)', () => {
    const repo = mkrepo('pebbl-route-priv-');
    try {
      sh(repo, `node "${BIN}" init`, { PEBBL_REMOTE_VISIBILITY: 'private' });
      sh(repo, `node "${BIN}" log "the system uses sqlite because it is embedded" --tier foundation --cat decision`, { PEBBL_REMOTE_VISIBILITY: 'private' });
      assert.ok(fs.existsSync(path.join(repo, '.pebbl', 'events.jsonl')), 'foundation shares freely on a private remote');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the fold reads BOTH files: a local event surfaces in the view', () => {
    const repo = mkrepo('pebbl-union-');
    try {
      sh(repo, `node "${BIN}" init`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      // a private foundation entry -> events.local.jsonl
      sh(repo, `node "${BIN}" log "the project uses sqlite because embedded" --tier foundation --cat decision`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      // a shared detail entry -> events.jsonl
      sh(repo, `node "${BIN}" log "tweaked the cache ttl to 60s for the api" --tier detail --cat pattern`, { PEBBL_REMOTE_VISIBILITY: 'public' });
      const { readEvents, fold } = require('../src/events');
      const pebblDir = path.join(repo, '.pebbl');
      const rows = fold(readEvents(pebblDir));
      const messages = rows.map((r) => r.message).join(' | ');
      assert.match(messages, /sqlite/, 'the LOCAL foundation event must surface in the folded view');
      assert.match(messages, /cache ttl/, 'the SHARED event must surface too');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
