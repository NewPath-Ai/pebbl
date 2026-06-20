'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { topicFilter } = require('../src/db');

describe('topicFilter', () => {
  it('returns correct SQL clause and params', () => {
    const { clause, params } = topicFilter('auth');
    assert(clause.includes('LIKE'));
    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[0], '%,auth,%');
    assert.strictEqual(params[1], 'auth');
  });

  it('handles multi-word topics', () => {
    const { clause, params } = topicFilter('clip forge');
    assert(clause.includes('LIKE'));
    assert.strictEqual(params.length, 4);
    assert.strictEqual(params[0], '%,clip forge,%');
    assert.strictEqual(params[1], 'clip forge');
  });

  it('returns clause starting with AND', () => {
    const { clause } = topicFilter('test');
    assert(clause.startsWith('AND'));
  });
});
