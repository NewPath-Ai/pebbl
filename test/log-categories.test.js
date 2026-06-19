'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VALID_CATEGORIES } = require('../src/log');
const { parseYaml, classifyEntry } = require('../src/rubric');
const fs = require('fs');
const path = require('path');

describe('correction category', () => {
  it('is a valid category', () => {
    assert.ok(VALID_CATEGORIES.includes('correction'));
  });

  it('keeps the original six categories', () => {
    for (const cat of ['decision', 'structure', 'pattern', 'data', 'integration', 'quality']) {
      assert.ok(VALID_CATEGORIES.includes(cat), cat);
    }
  });

  it('is documented in help output', () => {
    const help = require('../src/help');
    assert.match(help.TOPICS.categories, /correction\s+something went wrong/);
    assert.match(help.SUBCOMMANDS.log, /quality\|correction/);
  });

  it('default rubric classifies factory failure language as correction', () => {
    // Pull DEFAULT_RUBRIC out of rubric.js the way ensureProjectFiles writes it
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rubric.js'), 'utf8');
    const m = src.match(/const DEFAULT_RUBRIC = `([\s\S]*?)`;/);
    assert.ok(m, 'DEFAULT_RUBRIC found in source');
    const rubric = parseYaml(m[1]);
    const rules = rubric.rules
      .map((r) => ({ pattern: r.pattern ? new RegExp(r.pattern, 'i') : null, category: r.category || null, tier: r.tier || null }))
      .filter((r) => r.pattern && r.category);

    const correctionMsgs = [
      'lumr/beat-check parked: failed adversarial review 3x on agent/beat-check',
      'agent.sh crashed rc=2 before/during run',
      'hotfix for regression in search ranking',
    ];
    for (const msg of correctionMsgs) {
      const c = classifyEntry(rules, msg);
      assert.ok(c, `classified: ${msg}`);
      assert.strictEqual(c.category, 'correction', msg);
    }

    // decision language must not be stolen by the correction rule
    const d = classifyEntry(rules, 'chose bcrypt for password hashing');
    assert.strictEqual(d.category, 'decision');
  });
});
