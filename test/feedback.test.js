'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readFeedback, showRecentFeedback, resolveFeedbackDir } = require('../src/feedback');
const feedback = require('../src/feedback');

function tmpPebbl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-fb-'));
  const pebblDir = path.join(dir, '.pebbl');
  fs.mkdirSync(pebblDir);
  return { root: dir, pebblDir };
}

function write(pebblDir, lines) {
  fs.writeFileSync(
    path.join(pebblDir, 'feedback.jsonl'),
    lines.map(o => JSON.stringify(o)).join('\n') + '\n'
  );
}

describe('readFeedback - resolve markers fold into status', () => {
  let root, pebblDir;
  beforeEach(() => { ({ root, pebblDir } = tmpPebbl()); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('marks an entry resolved when a {resolves:id} marker follows it', () => {
    write(pebblDir, [
      { id: 'aaa', message: 'open one', timestamp: '2026-06-18T00:00:00Z' },
      { id: 'bbb', message: 'will be resolved', timestamp: '2026-06-18T00:00:01Z' },
      { resolves: 'bbb' },
    ]);
    const entries = readFeedback(pebblDir);
    assert.equal(entries.length, 2, 'markers are not counted as entries');
    const byId = Object.fromEntries(entries.map(e => [e.id, e]));
    assert.equal(byId.aaa.resolved, false);
    assert.equal(byId.bbb.resolved, true);
  });

  it('returns [] when the file is absent', () => {
    assert.deepEqual(readFeedback(pebblDir), []);
  });

  it('skips malformed json lines instead of throwing', () => {
    fs.writeFileSync(path.join(pebblDir, 'feedback.jsonl'),
      '{not json}\n' + JSON.stringify({ id: 'ok', message: 'good' }) + '\n');
    const entries = readFeedback(pebblDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'ok');
  });

  it('derives a stable id for legacy entries written without one', () => {
    write(pebblDir, [{ message: 'legacy, no id', timestamp: '2026-06-18T00:00:00Z' }]);
    const a = readFeedback(pebblDir);
    const b = readFeedback(pebblDir);
    assert.ok(a[0].id, 'a derived id is present');
    assert.equal(a[0].id, b[0].id, 'the derived id is stable across reads');
  });
});

describe('showRecentFeedback - the context surface', () => {
  let root, pebblDir, logs;
  beforeEach(() => {
    ({ root, pebblDir } = tmpPebbl());
    logs = [];
    showRecentFeedback.__origLog = console.log;
    console.log = (m) => logs.push(String(m));
  });
  afterEach(() => {
    console.log = showRecentFeedback.__origLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints nothing when there is no unresolved feedback', () => {
    write(pebblDir, [
      { id: 'x', message: 'done', timestamp: '2026-06-18T00:00:00Z' },
      { resolves: 'x' },
    ]);
    showRecentFeedback(pebblDir);
    assert.equal(logs.length, 0, 'a fully-resolved store produces no noise');
  });

  it('prints unresolved items plus the triage pointer', () => {
    write(pebblDir, [{ id: 'y', message: 'live bug', timestamp: '2026-06-18T00:00:00Z' }]);
    showRecentFeedback(pebblDir);
    const out = logs.join('\n');
    assert.match(out, /UNRESOLVED FEEDBACK \(1\)/);
    assert.match(out, /live bug/);
    assert.match(out, /pebbl feedback --list/);
  });
});

describe('resolveFeedbackDir - dir resolution', () => {
  it('uses an existing project .pebbl/ when cwd is inside one', () => {
    const { root, pebblDir } = tmpPebbl();
    const orig = process.cwd();
    try {
      process.chdir(root);
      const { dir, global: isGlobal } = resolveFeedbackDir();
      // fs.realpathSync resolves macOS's /var -> /private/var symlink so the
      // path comparison isn't defeated by where the OS mounts the tmp dir.
      assert.equal(fs.realpathSync(dir), fs.realpathSync(pebblDir));
      assert.equal(isGlobal, false);
    } finally {
      process.chdir(orig);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the global ~/.pebbl and mints NO stray .pebbl/ in cwd', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nowhere-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-home-'));
    const orig = process.cwd();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;
      process.chdir(cwd);
      const { dir, global: isGlobal } = resolveFeedbackDir();
      assert.equal(isGlobal, true, 'no project tree -> global');
      assert.equal(dir, path.join(fakeHome, '.pebbl'));
      assert.ok(!fs.existsSync(path.join(cwd, '.pebbl')), 'no stray .pebbl/ in cwd');
    } finally {
      process.chdir(orig);
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
