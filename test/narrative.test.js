'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const narrative = require('../src/narrative');
const { readNarrative, writeNarrative, getNarrativePath, readRefs, readUpdatedTimestamp, updateRefs } = narrative;
const { openDb } = require('../src/db');

// Run narrative() with a fake cwd containing a .pebbl/ dir. Captures stdout,
// stderr, and any process.exit code instead of letting it kill the test run.
function runNarrative(pebblDir, args) {
  const projectRoot = path.dirname(pebblDir);
  const origCwd = process.cwd();
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;

  const out = [];
  const err = [];
  let exitCode = null;

  process.chdir(projectRoot);
  console.log = (m) => out.push(String(m));
  console.error = (m) => err.push(String(m));
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };

  try {
    narrative(args);
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.chdir(origCwd);
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

function setup() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-narr-'));
  const pebblDir = path.join(projectRoot, '.pebbl');
  fs.mkdirSync(pebblDir);
  // Initialize the db so openDb's foundation query has a table to hit.
  const db = openDb(pebblDir);
  db.close();
  return { projectRoot, pebblDir };
}

function teardown(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

describe('narrative - SET trap guard', () => {
  let projectRoot, pebblDir;
  beforeEach(() => { ({ projectRoot, pebblDir } = setup()); });
  afterEach(() => teardown(projectRoot));

  it('refuses a lone --flag token and exits non-zero instead of overwriting', () => {
    writeNarrative(pebblDir, 'Original narrative body.', []);
    const { err, exitCode } = runNarrative(pebblDir, ['--refresh-typo']);
    assert.strictEqual(exitCode, 1);
    assert.match(err, /not a valid narrative/);
    // Body must be untouched — not overwritten with the literal flag.
    const body = readNarrative(pebblDir);
    assert.match(body, /Original narrative body\./);
    assert.doesNotMatch(body, /--refresh-typo/);
  });

  it('backs up an existing narrative to narrative.md.bak before overwriting', () => {
    writeNarrative(pebblDir, 'First version of the narrative.', []);
    runNarrative(pebblDir, ['Second', 'version', 'now']);

    const bak = getNarrativePath(pebblDir) + '.bak';
    assert.ok(fs.existsSync(bak), 'narrative.md.bak should exist');
    assert.match(fs.readFileSync(bak, 'utf8'), /First version of the narrative\./);

    const body = readNarrative(pebblDir);
    assert.match(body, /Second version now/);
  });

  it('does NOT write a .bak when no prior narrative exists', () => {
    runNarrative(pebblDir, ['Brand', 'new', 'narrative']);
    const bak = getNarrativePath(pebblDir) + '.bak';
    assert.ok(!fs.existsSync(bak), 'no .bak should be created on first set');
    assert.match(readNarrative(pebblDir), /Brand new narrative/);
  });

  it('still accepts a normal multi-word narrative that happens to contain a flag-like token', () => {
    // More than one positional token → not treated as a stray flag.
    const { exitCode } = runNarrative(pebblDir, ['Use', '--force', 'carefully']);
    assert.strictEqual(exitCode, null);
    assert.match(readNarrative(pebblDir), /Use --force carefully/);
  });
});

describe('narrative - --refresh', () => {
  let projectRoot, pebblDir;
  beforeEach(() => { ({ projectRoot, pebblDir } = setup()); });
  afterEach(() => teardown(projectRoot));

  it('re-stamps the timestamp and re-links refs while leaving the body intact', () => {
    const db = openDb(pebblDir);
    db.prepare("INSERT INTO logs (timestamp, message, tier) VALUES (?,?,'foundation')")
      .run('2026-06-01T10:00:00.000Z', 'foundation decision one');
    db.prepare("INSERT INTO logs (timestamp, message, tier) VALUES (?,?,'foundation')")
      .run('2026-06-02T10:00:00.000Z', 'foundation decision two');
    db.close();

    // Seed a narrative with NO refs and a stale timestamp baked into the file.
    const p = getNarrativePath(pebblDir);
    fs.writeFileSync(p, '# Project Narrative\n\nThe canonical project body.\n\n<!-- updated: 2020-01-01T00:00:00.000Z -->\n');

    const before = readUpdatedTimestamp(pebblDir);
    const { exitCode } = runNarrative(pebblDir, ['--refresh']);

    assert.strictEqual(exitCode, null);
    // Body preserved verbatim.
    assert.match(readNarrative(pebblDir), /The canonical project body\./);
    assert.doesNotMatch(readNarrative(pebblDir), /--refresh/);
    // Refs re-linked to the two foundation entries.
    assert.deepStrictEqual(readRefs(pebblDir).sort((a, b) => a - b), [1, 2]);
    // Timestamp re-stamped (changed from the stale seed).
    assert.notStrictEqual(readUpdatedTimestamp(pebblDir), before);
  });

  it('errors and exits non-zero when there is no narrative to refresh', () => {
    const { exitCode, err } = runNarrative(pebblDir, ['--refresh']);
    assert.strictEqual(exitCode, 1);
    assert.match(err, /No narrative to refresh/);
  });
});

describe('narrative - updateRefs still rewrites short legit bodies', () => {
  let projectRoot, pebblDir;
  beforeEach(() => { ({ projectRoot, pebblDir } = setup()); });
  afterEach(() => teardown(projectRoot));

  it('preserves a short body when auto-updating corrected refs', () => {
    const db = openDb(pebblDir);
    // Original foundation entry (id 1) and a correction to it (id 2).
    db.prepare("INSERT INTO logs (timestamp, message, tier) VALUES (?,?,'foundation')")
      .run('2026-06-01T10:00:00.000Z', 'original');
    db.prepare("INSERT INTO logs (timestamp, message, tier, corrects) VALUES (?,?,'foundation',1)")
      .run('2026-06-02T10:00:00.000Z', 'corrected');

    // A legitimately short narrative body linked to ref 1.
    writeNarrative(pebblDir, 'ok', [1]);
    const result = updateRefs(pebblDir, db);
    db.close();

    assert.strictEqual(result.updated, true);
    // Short body survived the automatic rewrite — guard must NOT live in writeNarrative.
    assert.match(readNarrative(pebblDir), /\bok\b/);
    assert.deepStrictEqual(readRefs(pebblDir), [2]);
  });
});
