'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/args');

describe('parseArgs', () => {
  it('parses flags with values', () => {
    const result = parseArgs(['chose', 'SQLite', '--cat', 'decision', '--topic', 'datastore']);
    assert.deepStrictEqual(result.flags, { cat: 'decision', topic: 'datastore' });
    assert.deepStrictEqual(result.positional, ['chose', 'SQLite']);
  });

  it('parses boolean flags (--preview, --execute)', () => {
    const result = parseArgs(['--preview']);
    assert.deepStrictEqual(result.flags, { preview: true });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses --execute as boolean', () => {
    const result = parseArgs(['--execute', '--resolve', '22:signal', 'extra']);
    assert.deepStrictEqual(result.flags, { execute: true, resolve: '22:signal' });
    assert.deepStrictEqual(result.positional, ['extra']);
  });

  it('handles mixed positional and flags', () => {
    const result = parseArgs(['hello', '--cat', 'pattern', 'world', '--tier', 'signal']);
    assert.deepStrictEqual(result.flags, { cat: 'pattern', tier: 'signal' });
    assert.deepStrictEqual(result.positional, ['hello', 'world']);
  });

  it('passes unknown flags through as positional and warns on stderr', () => {
    const written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(chunk); return true; };
    try {
      const result = parseArgs(['--unknown', 'value', '--cat', 'decision']);
      assert.deepStrictEqual(result.flags, { cat: 'decision' });
      assert.deepStrictEqual(result.positional, ['--unknown', 'value']);
      assert.ok(written.some(l => l.includes('unknown flag --unknown')), 'expected warning for --unknown');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('emits no warning for known flags', () => {
    const written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(chunk); return true; };
    try {
      parseArgs(['--cat', 'decision', '--preview']);
      assert.strictEqual(written.length, 0, 'expected no warnings for known flags');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('returns empty for no args', () => {
    const result = parseArgs([]);
    assert.deepStrictEqual(result.flags, {});
    assert.deepStrictEqual(result.positional, []);
  });

  it('handles all positional with no flags', () => {
    const result = parseArgs(['just', 'a', 'message']);
    assert.deepStrictEqual(result.flags, {});
    assert.deepStrictEqual(result.positional, ['just', 'a', 'message']);
  });

  it('handles flag with no following value', () => {
    const result = parseArgs(['--cat', '--topic', 'auth']);
    assert.deepStrictEqual(result.flags, { topic: 'auth' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('handles boolean flag inline with other params', () => {
    const result = parseArgs(['--preview', '--cat', 'decision']);
    assert.deepStrictEqual(result.flags, { preview: true, cat: 'decision' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses relates and corrects as value flags', () => {
    const result = parseArgs(['fixed', '--relates', '5', '--corrects', '3']);
    assert.deepStrictEqual(result.flags, { relates: '5', corrects: '3' });
    assert.deepStrictEqual(result.positional, ['fixed']);
  });

  it('parses source and tier flags', () => {
    const result = parseArgs(['note', '--source', 'agent', '--tier', 'fleeting']);
    assert.deepStrictEqual(result.flags, { source: 'agent', tier: 'fleeting' });
    assert.deepStrictEqual(result.positional, ['note']);
  });

  it('parses resolve flag with value', () => {
    const result = parseArgs(['--resolve', '22:signal,15:rollup']);
    assert.deepStrictEqual(result.flags, { resolve: '22:signal,15:rollup' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses handoff value flags (--done, --todo, --blocked)', () => {
    const result = parseArgs(['summary', '--done', 'task A; task B', '--todo', 'task C', '--blocked', 'waiting on API']);
    assert.deepStrictEqual(result.flags, { done: 'task A; task B', todo: 'task C', blocked: 'waiting on API' });
    assert.deepStrictEqual(result.positional, ['summary']);
  });

  it('parses --deep as a boolean flag (pebbl check --deep)', () => {
    const result = parseArgs(['--deep']);
    assert.deepStrictEqual(result.flags, { deep: true });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses --n as a value flag (pebbl scan-commits --n 50)', () => {
    const result = parseArgs(['--n', '50']);
    assert.deepStrictEqual(result.flags, { n: '50' });
    assert.deepStrictEqual(result.positional, []);
  });

  it('parses handoff boolean flags (--latest, --list, --close)', () => {
    const result = parseArgs(['--latest']);
    assert.deepStrictEqual(result.flags, { latest: true });
    assert.deepStrictEqual(result.positional, []);

    const result2 = parseArgs(['--list']);
    assert.deepStrictEqual(result2.flags, { list: true });

    const result3 = parseArgs(['--close', '--topic', 'auth']);
    assert.deepStrictEqual(result3.flags, { close: true, topic: 'auth' });
  });
});
