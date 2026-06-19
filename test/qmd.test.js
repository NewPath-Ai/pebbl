'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectionName } = require('../src/qmd');

describe('qmd - collectionName', () => {
  it('uses parent dir basename as the readable prefix', () => {
    const name = collectionName('/Users/ashley/Documents/lumr/.pebbl');
    assert.match(name, /^pebbl-lumr-[a-f0-9]{6}$/);
  });

  it('is deterministic for the same path', () => {
    const a = collectionName('/Users/ashley/Documents/lumr/.pebbl');
    const b = collectionName('/Users/ashley/Documents/lumr/.pebbl');
    assert.strictEqual(a, b);
  });

  it('produces different names for two projects with the same basename', () => {
    // Two unrelated repos that both happen to be named "client"
    const a = collectionName('/Users/ashley/work/acme/client/.pebbl');
    const b = collectionName('/Users/ashley/work/globex/client/.pebbl');
    assert.notStrictEqual(a, b, 'hash must disambiguate same-basename projects');
    assert.match(a, /^pebbl-client-/);
    assert.match(b, /^pebbl-client-/);
  });

  it('resolves relative paths so cwd does not change the name', () => {
    const abs = collectionName('/Users/ashley/Documents/lumr/.pebbl');
    // The relative form, resolved against absolute, should hash the same
    const path = require('path');
    const rel = path.relative(process.cwd(), '/Users/ashley/Documents/lumr/.pebbl');
    const fromRel = collectionName(rel);
    assert.strictEqual(fromRel, abs);
  });
});
