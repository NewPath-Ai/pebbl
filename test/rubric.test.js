'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRubric, classifyEntry, parseYaml } = require('../src/rubric');

describe('parseYaml', () => {
  it('parses rules list', () => {
    const yaml = `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "bug|fix"
    category: quality
    tier: detail
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 2);
    assert.strictEqual(result.rules[0].pattern, 'chose|decided');
    assert.strictEqual(result.rules[0].category, 'decision');
    assert.strictEqual(result.rules[0].tier, 'signal');
  });

  it('parses flat key-value block', () => {
    const yaml = `compaction:
  threshold: 10
  fleeting_retention: 30
`;
    const result = parseYaml(yaml);
    assert.deepStrictEqual(result.compaction, { threshold: 10, fleeting_retention: 30 });
  });

  it('ignores comments and empty lines', () => {
    const yaml = `# This is a comment
rules:
  # Another comment
  - pattern: "test"
    category: decision
    tier: signal

`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 1);
    assert.strictEqual(result.rules[0].pattern, 'test');
  });

  it('strips quotes from values', () => {
    const yaml = `rules:
  - pattern: "chose"
    category: "decision"
    tier: 'signal'
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules[0].category, 'decision');
    assert.strictEqual(result.rules[0].tier, 'signal');
  });

  it('rejects rules with no pattern (corrupt entries)', () => {
    // No pattern field → filtered out by loadRubric
    const yaml = `rules:
  - category: decision
    tier: signal
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.rules.length, 1);
    // loadRubric will filter this out since pattern is missing
  });
});

describe('classifyEntry', () => {
  const rules = [
    { pattern: new RegExp('chose|decided|decision|picked', 'i'), category: 'decision', tier: 'signal' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'signal' },
    { pattern: new RegExp('\\[session\\]', 'i'), category: 'uncategorized', tier: 'fleeting' },
  ];

  it('matches decision keywords', () => {
    const result = classifyEntry(rules, 'chose SQLite over Postgres');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'signal' });
  });

  it('matches structure keywords', () => {
    const result = classifyEntry(rules, 'refactored the auth module boundary');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'signal' });
  });

  it('matches session tag', () => {
    const result = classifyEntry(rules, '[session] updated the API endpoints');
    assert.deepStrictEqual(result, { category: 'uncategorized', tier: 'fleeting' });
  });

  it('returns null for no match', () => {
    const result = classifyEntry(rules, 'random note about nothing');
    assert.strictEqual(result, null);
  });

  it('returns null when rules array is empty', () => {
    const result = classifyEntry([], 'chose SQLite');
    assert.strictEqual(result, null);
  });

  it('uses first matching rule (order matters)', () => {
    const orderedRules = [
      { pattern: new RegExp('refactor|module', 'i'), category: 'structure', tier: 'signal' },
      { pattern: new RegExp('refactor.*data', 'i'), category: 'data', tier: 'detail' },
    ];
    const result = classifyEntry(orderedRules, 'refactored the data module');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'signal' });
  });

  it('matches case-insensitively', () => {
    const result = classifyEntry(rules, 'DECIDED to use Redis');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'signal' });
  });
});

describe('loadRubric', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no rubric.yml exists', () => {
    const rules = loadRubric(tmpDir);
    assert.deepStrictEqual(rules, []);
  });

  it('loads and compiles rules from rubric.yml', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "schema|model"
    category: data
    tier: detail
`);
    const rules = loadRubric(tmpDir);
    assert.strictEqual(rules.length, 2);
    assert(rules[0].pattern instanceof RegExp);
    assert(rules[1].pattern instanceof RegExp);
    assert(rules[0].pattern.test('I CHOSE Redis'));
    assert(!rules[0].pattern.test('added a table'));
    assert(rules[1].pattern.test('updated the schema'));
  });

  it('filters out rules without pattern or category', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose"
    category: decision
    tier: signal
  - tier: signal
  - pattern: "data"
`);
    const rules = loadRubric(tmpDir);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].category, 'decision');
  });
});
