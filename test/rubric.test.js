'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadRubric, classifyEntry, parseYaml, ensureProjectFiles } = require('../src/rubric');
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
  // Rules must match real rubric order: [session] first, then content patterns.
  // This ensures first-match-wins works correctly for session entries.
  const rules = [
    { pattern: new RegExp('\\[session\\]', 'i'), category: 'uncategorized', tier: 'fleeting' },
    { pattern: new RegExp('chose|decided|decision|picked', 'i'), category: 'decision', tier: 'component' },
    { pattern: new RegExp('module|component|boundary', 'i'), category: 'structure', tier: 'component' },
  ];

  it('matches decision keywords', () => {
    const result = classifyEntry(rules, 'chose SQLite over Postgres');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'component' });
  });

  it('matches structure keywords', () => {
    const result = classifyEntry(rules, 'refactored the auth module boundary');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'component' });
  });

  it('matches session tag', () => {
    const result = classifyEntry(rules, '[session] updated the API endpoints');
    assert.deepStrictEqual(result, { category: 'uncategorized', tier: 'fleeting' });
  });

  it('session entry with decision keywords still matches session rule first', () => {
    const result = classifyEntry(rules, '[session] we made a decision to use Redis and chose bcrypt');
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
      { pattern: new RegExp('refactor|module', 'i'), category: 'structure', tier: 'component' },
      { pattern: new RegExp('refactor.*data', 'i'), category: 'data', tier: 'detail' },
    ];
    const result = classifyEntry(orderedRules, 'refactored the data module');
    assert.deepStrictEqual(result, { category: 'structure', tier: 'component' });
  });

  it('matches case-insensitively', () => {
    const result = classifyEntry(rules, 'DECIDED to use Redis');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'component' });
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

  it('integration: file-loaded rules + classifyEntry pipeline', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "chose|decided"
    category: decision
    tier: signal
  - pattern: "api|endpoint"
    category: integration
    tier: detail
`);
    const rules = loadRubric(tmpDir);
    const result = classifyEntry(rules, 'chose Postgres over MySQL');
    assert.deepStrictEqual(result, { category: 'decision', tier: 'signal' });

    const result2 = classifyEntry(rules, 'added a new API endpoint');
    assert.deepStrictEqual(result2, { category: 'integration', tier: 'detail' });

    const result3 = classifyEntry(rules, 'random note');
    assert.strictEqual(result3, null);
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

describe('ensureProjectFiles — rubric migration', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-migrate-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchors unanchored [session] pattern in existing rubric', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "\\[session\\]"
    category: uncategorized
    tier: fleeting
  - pattern: "chose|decided"
    category: decision
    tier: signal
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(content.includes('^\\[session\\]'), 'pattern should be anchored with ^');
    assert(!content.includes('"\\[session\\]"'), 'old unanchored pattern should be gone');
  });

  it('does not double-anchor already anchored pattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), `rules:
  - pattern: "^\\[session\\]"
    category: uncategorized
    tier: fleeting
`);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(!content.includes('^^'), 'should not double-anchor');
    assert(content.includes('^\\[session\\]'), 'anchored pattern preserved');
  });

  it('does not anchor-migrate rubrics without [session] pattern, but adds trace rule', () => {
    const original = `rules:
  - pattern: "chose|decided"
    category: decision
    tier: component
`;
    fs.writeFileSync(path.join(tmpDir, 'rubric.yml'), original);
    ensureProjectFiles(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'rubric.yml'), 'utf8');
    assert(!content.includes('^^'), 'should not add double-anchor');
    assert(content.includes('^trace:'), 'trace rule should be added');
    assert(content.includes('chose|decided'), 'existing rules should be preserved');
  });
});
