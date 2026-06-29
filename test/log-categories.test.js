'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VALID_CATEGORIES, normalizeCategory } = require('../src/log');
const { parseYaml, classifyEntry } = require('../src/rubric');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PEBBL_BIN = path.join(__dirname, '..', 'bin', 'pebbl.js');

describe('steering category', () => {
  it('is a valid category', () => {
    assert.ok(VALID_CATEGORIES.includes('steering'));
  });

  it('keeps the original six categories', () => {
    for (const cat of ['decision', 'structure', 'pattern', 'data', 'integration', 'quality']) {
      assert.ok(VALID_CATEGORIES.includes(cat), cat);
    }
  });

  it('does NOT list the deprecated alias as a canonical category', () => {
    assert.ok(!VALID_CATEGORIES.includes('correction'));
  });

  it('accepts `correction` as a deprecated alias that normalizes to steering', () => {
    assert.strictEqual(normalizeCategory('correction'), 'steering');
    // canonical, other categories, and empty input pass through untouched
    assert.strictEqual(normalizeCategory('steering'), 'steering');
    assert.strictEqual(normalizeCategory('decision'), 'decision');
    assert.strictEqual(normalizeCategory(null), null);
  });

  it('is documented in help output', () => {
    const help = require('../src/help');
    assert.match(help.TOPICS.categories, /steering\s+course-correction/);
    assert.match(help.SUBCOMMANDS.log, /quality\|steering/);
  });

  it('default rubric classifies factory failure language as steering', () => {
    // Pull DEFAULT_RUBRIC out of rubric.js the way ensureProjectFiles writes it
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rubric.js'), 'utf8');
    const m = src.match(/const DEFAULT_RUBRIC = `([\s\S]*?)`;/);
    assert.ok(m, 'DEFAULT_RUBRIC found in source');
    const rubric = parseYaml(m[1]);
    const rules = rubric.rules
      .map((r) => ({ pattern: r.pattern ? new RegExp(r.pattern, 'i') : null, category: r.category || null, tier: r.tier || null }))
      .filter((r) => r.pattern && r.category);

    const steeringMsgs = [
      'lumr/beat-check parked: failed adversarial review 3x on agent/beat-check',
      'agent.sh crashed rc=2 before/during run',
      'hotfix for regression in search ranking',
    ];
    for (const msg of steeringMsgs) {
      const c = classifyEntry(rules, msg);
      assert.ok(c, `classified: ${msg}`);
      assert.strictEqual(c.category, 'steering', msg);
    }

    // decision language must not be stolen by the steering rule
    const d = classifyEntry(rules, 'chose bcrypt for password hashing');
    assert.strictEqual(d.category, 'decision');
  });
});

describe('deprecated --cat correction alias (end-to-end)', () => {
  it('stores an entry logged with --cat correction as category steering', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-alias-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
      execFileSync('node', [PEBBL_BIN, 'init'], { cwd: dir, stdio: 'ignore' });
      execFileSync(
        'node',
        [PEBBL_BIN, 'log', 'parked the flaky branch after 3 failed reviews', '--cat', 'correction', '--tier', 'component'],
        { cwd: dir, stdio: 'ignore' },
      );
      const db = new Database(path.join(dir, '.pebbl', 'db.sqlite'), { readonly: true });
      const row = db.prepare("SELECT category FROM logs WHERE message LIKE 'parked the flaky%'").get();
      db.close();
      assert.ok(row, 'entry was stored');
      assert.strictEqual(row.category, 'steering', '--cat correction must normalize to steering on storage');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
