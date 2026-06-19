'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const init = require('../src/init');
const upgrade = require('../src/upgrade');
const eject = require('../src/eject');
const { AGENT_BEGIN, AGENT_END, AGENT_SECTION } = init;

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-iue-'));
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

describe('init', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
  });
  after(() => { process.chdir(origCwd); });

  it('creates .pebbl/ with seed files', () => {
    silence(() => init());
    assert.ok(fs.existsSync(path.join(dir, '.pebbl')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'manual-logs.md')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'rubric.yml')));
    assert.ok(fs.existsSync(path.join(dir, '.pebbl', 'config.yml')));
  });

  it('writes AGENTS.md with sentinel-wrapped pebbl block', () => {
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes(AGENT_BEGIN));
    assert.ok(md.includes(AGENT_END));
    assert.ok(md.indexOf(AGENT_BEGIN) < md.indexOf(AGENT_END));
  });

  it('does not create PEBBL.md at project root', () => {
    silence(() => init());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });

  it('AGENTS.md points to pebbl help instead of PEBBL.md', () => {
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(!md.includes('PEBBL.md'));
    assert.match(md, /pebbl help <topic>/);
  });

  it('appends pebbl block to pre-existing AGENTS.md without clobbering', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing user content\n\nMy notes.\n');
    silence(() => init());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes('My notes.'));
    assert.ok(md.includes(AGENT_BEGIN));
  });

  it('adds .pebbl/ to .gitignore', () => {
    silence(() => init());
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /\.pebbl\//);
  });
});

describe('upgrade', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
    silence(() => init());
  });
  after(() => { process.chdir(origCwd); });

  it('refreshes pebbl block in place without touching surrounding content', () => {
    const agentMd = path.join(dir, 'AGENTS.md');
    const tampered = fs.readFileSync(agentMd, 'utf8')
      .replace(AGENT_BEGIN + '\n', AGENT_BEGIN + '\nSTALE CONTENT\n');
    fs.writeFileSync(agentMd, '# user header\n\n' + tampered + '\n\n## user trailer\n');
    silence(() => upgrade());
    const after = fs.readFileSync(agentMd, 'utf8');
    assert.ok(!after.includes('STALE CONTENT'));
    assert.ok(after.includes('# user header'));
    assert.ok(after.includes('## user trailer'));
    assert.ok(after.includes(AGENT_BEGIN));
    assert.ok(after.includes(AGENT_END));
  });

  it('is idempotent — running twice yields the same AGENTS.md', () => {
    silence(() => upgrade());
    const first = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    silence(() => upgrade());
    const second = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(first, second);
  });

  it('migrates legacy pebbl section to sentinel format', () => {
    const legacy = '# Agent Guidelines\n\n## Pebbl — Project Memory Protocol\n\nOld content here.\n\n## Other section\nUnrelated.\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), legacy);
    silence(() => upgrade());
    const md = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(md.includes(AGENT_BEGIN));
    assert.ok(!md.includes('## Pebbl — Project Memory Protocol'));
    assert.ok(md.includes('## Other section'));
  });

  it('removes legacy PEBBL.md if present', () => {
    fs.writeFileSync(path.join(dir, 'PEBBL.md'), 'legacy content\n');
    silence(() => upgrade());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });
});

describe('eject', () => {
  let dir, origCwd;
  before(() => { origCwd = process.cwd(); });
  beforeEach(() => {
    dir = tmpProject();
    process.chdir(dir);
    silence(() => init());
  });
  after(() => { process.chdir(origCwd); });

  it('strips pebbl sentinel block from AGENTS.md, leaves user content', () => {
    const agentMd = path.join(dir, 'AGENTS.md');
    const before = fs.readFileSync(agentMd, 'utf8');
    fs.writeFileSync(agentMd, '# user header\n\n' + before + '\n\n## user trailer\n');
    silence(() => eject());
    const after = fs.readFileSync(agentMd, 'utf8');
    assert.ok(!after.includes(AGENT_BEGIN));
    assert.ok(!after.includes(AGENT_END));
    assert.ok(after.includes('# user header'));
    assert.ok(after.includes('## user trailer'));
  });

  it('removes legacy PEBBL.md if present', () => {
    fs.writeFileSync(path.join(dir, 'PEBBL.md'), 'legacy\n');
    silence(() => eject());
    assert.ok(!fs.existsSync(path.join(dir, 'PEBBL.md')));
  });

  it('removes .pebbl/ from .gitignore but leaves other entries', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.pebbl/\ndist/\n');
    silence(() => eject());
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(!gi.includes('.pebbl/'));
    assert.match(gi, /node_modules\//);
    assert.match(gi, /dist\//);
  });
});
