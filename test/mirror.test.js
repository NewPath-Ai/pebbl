'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { mirrorMachines, mirrorLogs, mirrorHandoffs, stripHandoffPrefix } = require('../src/mirror');
const { searchMirrors, mergeMirror } = require('../src/search')._internal;
const init = require('../src/init');
const context = require('../src/context');
const handoff = require('../src/handoff');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-mirror-'));
}

function silence(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return fn(); } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
}

// Run fn capturing everything console.log prints, as one string.
function capture(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = () => {};
  try { fn(); } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join('\n');
}

const DROPLET_LOGS = `# Manual Logs

## 2026-06-11T10:00:00.000Z - older droplet decision about queue retries
<!-- cat:decision topic:pipeline tier:component source:agent -->

## 2026-06-12T09:00:00.000Z - droplet parked branch agent/foo after 2 fix rounds
<!-- cat:correction topic:pipeline tier:detail source:agent -->
`;

const DROPLET_HANDOFFS = `# Handoffs

## 2026-06-12T08:00:00.000Z - handoff #4: finish wiring the review judge
<!-- handoff:4 field:summary topic:pipeline status:open -->

## 2026-06-12T08:00:00.000Z - handoff #4 todo: re-run the budget test
<!-- handoff:4 field:todo topic:pipeline status:open -->

## 2026-06-10T08:00:00.000Z - handoff #3: judge prompt rewrite landed
<!-- handoff:3 field:summary topic:pipeline status:closed -->
`;

function writeMirror(pebblDir, machine, { logs, handoffs } = {}) {
  const dir = path.join(pebblDir, 'mirror', machine);
  fs.mkdirSync(dir, { recursive: true });
  if (logs) fs.writeFileSync(path.join(dir, 'manual-logs.md'), logs);
  if (handoffs) fs.writeFileSync(path.join(dir, 'handoffs.md'), handoffs);
}

describe('mirror readers', () => {
  let dir;
  beforeEach(() => { dir = tmpProject(); });

  it('mirrorMachines returns [] when no mirror dir exists (inert)', () => {
    assert.deepEqual(mirrorMachines(dir), []);
  });

  it('mirrorMachines lists machine dirs, ignoring stray files', () => {
    writeMirror(dir, 'droplet', { logs: DROPLET_LOGS });
    fs.writeFileSync(path.join(dir, 'mirror', 'stray.txt'), 'x');
    assert.deepEqual(mirrorMachines(dir), ['droplet']);
  });

  it('mirrorLogs returns [] with no mirrors and parses entries newest-first', () => {
    assert.deepEqual(mirrorLogs(dir), []);
    writeMirror(dir, 'droplet', { logs: DROPLET_LOGS });
    const logs = mirrorLogs(dir);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].machine, 'droplet');
    assert.equal(logs[0].message, 'droplet parked branch agent/foo after 2 fix rounds');
    assert.equal(logs[0].cat, 'correction');
    assert.equal(logs[0].tier, 'detail');
    assert.equal(logs[0].topics, 'pipeline');
    assert.equal(logs[0].date, '2026-06-12');
    assert.equal(logs[1].message, 'older droplet decision about queue retries');
  });

  it('mirrorHandoffs parses field and status, defaulting status to closed', () => {
    writeMirror(dir, 'droplet', {
      handoffs: DROPLET_HANDOFFS + '\n## 2026-06-09T00:00:00.000Z - handoff #2: no status tag\n<!-- handoff:2 field:summary topic: -->\n',
    });
    const hs = mirrorHandoffs(dir);
    assert.equal(hs.length, 4);
    const open = hs.filter(h => h.status === 'open');
    assert.equal(open.length, 2);
    assert.equal(hs.find(h => h.handoffId === '2').status, 'closed');
    assert.equal(hs[0].machine, 'droplet');
  });

  it('readers never modify mirror files', () => {
    writeMirror(dir, 'droplet', { logs: DROPLET_LOGS, handoffs: DROPLET_HANDOFFS });
    const lp = path.join(dir, 'mirror', 'droplet', 'manual-logs.md');
    const hp = path.join(dir, 'mirror', 'droplet', 'handoffs.md');
    const before = [fs.readFileSync(lp, 'utf8'), fs.readFileSync(hp, 'utf8')];
    mirrorMachines(dir); mirrorLogs(dir); mirrorHandoffs(dir);
    searchMirrors(dir, 'droplet', null, null);
    assert.deepEqual([fs.readFileSync(lp, 'utf8'), fs.readFileSync(hp, 'utf8')], before);
  });

  it('stripHandoffPrefix strips summary and field prefixes', () => {
    assert.equal(stripHandoffPrefix('handoff #4: finish wiring'), 'finish wiring');
    assert.equal(stripHandoffPrefix('handoff #4 todo: re-run tests'), 're-run tests');
    assert.equal(stripHandoffPrefix('plain message'), 'plain message');
  });
});

describe('searchMirrors', () => {
  let dir;
  beforeEach(() => {
    dir = tmpProject();
    writeMirror(dir, 'droplet', { logs: DROPLET_LOGS, handoffs: DROPLET_HANDOFFS });
  });

  it('returns [] when no mirrors exist', () => {
    assert.deepEqual(searchMirrors(tmpProject(), 'anything', null, null), []);
  });

  it('matches logs and handoffs case-insensitively with machine attribution', () => {
    const rs = searchMirrors(dir, 'PARKED', null, null);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].machine, 'droplet');
    assert.equal(rs[0].isHandoff, false);

    const hs = searchMirrors(dir, 'review judge', null, null);
    assert.equal(hs.length, 1);
    assert.equal(hs[0].isHandoff, true);
    assert.equal(hs[0].status, 'open');
  });

  it('applies cat filter to logs and topic filter to both', () => {
    assert.equal(searchMirrors(dir, 'droplet', 'decision', null).length, 1);
    assert.equal(searchMirrors(dir, 'droplet', null, 'pipeline').length, 2);
    assert.equal(searchMirrors(dir, 'droplet', null, 'nope').length, 0);
  });

  it('mergeMirror keeps attributed mirror results over duplicate locals', () => {
    const local = [
      { isHandoff: false, message: 'droplet parked branch agent/foo after 2 fix rounds', tier: 'detail', cat: 'correction', date: '2026-06-12' },
      { isHandoff: false, message: 'a purely local entry', tier: 'detail', cat: 'quality', date: '2026-06-12' },
    ];
    const mirror = searchMirrors(dir, 'parked', null, null);
    const merged = mergeMirror(local, mirror);
    assert.equal(merged.length, 2);
    assert.equal(merged.filter(r => r.machine).length, 1);
    assert.equal(merged[0].message, 'a purely local entry');
  });

  it('mergeMirror is a no-op with no mirror results', () => {
    const local = [{ isHandoff: false, message: 'x', tier: 'detail', cat: 'quality', date: 'd' }];
    assert.deepEqual(mergeMirror(local, []), local);
  });
});

describe('CLI integration (inert without mirrors)', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  after(() => { process.chdir(origCwd); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
    silence(() => init([]));
  });

  it('context output is unchanged by an empty mirror root and gains a section with content', () => {
    const without = capture(() => context([]));
    assert.ok(!without.includes('MIRROR'));

    fs.mkdirSync(path.join(dir, '.pebbl', 'mirror'), { recursive: true });
    const withEmpty = capture(() => context([]));
    assert.equal(withEmpty, without);

    writeMirror(path.join(dir, '.pebbl'), 'droplet', { logs: DROPLET_LOGS, handoffs: DROPLET_HANDOFFS });
    const withMirror = capture(() => context([]));
    assert.ok(withMirror.includes('--- MIRROR: droplet ---'));
    assert.ok(withMirror.includes('open handoff: finish wiring the review judge'));
    assert.ok(withMirror.includes('droplet parked branch agent/foo after 2 fix rounds'));
    assert.ok(withMirror.startsWith(without.trimEnd().slice(0, 20)));
  });

  it('handoff --list shows mirrored handoffs tagged with the machine', () => {
    const empty = capture(() => handoff(['--list']));
    assert.ok(empty.includes('no handoffs found'));

    writeMirror(path.join(dir, '.pebbl'), 'droplet', { handoffs: DROPLET_HANDOFFS });
    const listed = capture(() => handoff(['--list']));
    assert.ok(!listed.includes('no handoffs found'));
    assert.ok(listed.includes('[droplet] #4 [open]'));
    assert.ok(listed.includes('finish wiring the review judge'));
    assert.ok(!listed.includes('re-run the budget test'), 'only summary blocks are listed');
  });
});
