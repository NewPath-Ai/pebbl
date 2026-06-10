'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readPosture, formatPosture, setPostureField, VALID_FIELDS } = require('../src/posture');

function tmpPebblDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-posture-'));
  return dir;
}

function writeConfig(dir, content) {
  fs.writeFileSync(path.join(dir, 'config.yml'), content);
}

describe('posture', () => {
  describe('readPosture', () => {
    it('returns null when no config exists', () => {
      const dir = tmpPebblDir();
      const result = readPosture(dir);
      assert.equal(result, null);
    });

    it('returns null when config has no posture block', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'compaction:\n  threshold: 10\n');
      const result = readPosture(dir);
      assert.equal(result, null);
    });

    it('reads posture from config', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'posture:\n  maturity: production\n  security: strict\n');
      const result = readPosture(dir);
      assert.equal(result.maturity, 'production');
      assert.equal(result.security, 'strict');
    });
  });

  describe('formatPosture', () => {
    it('formats null as no posture set', () => {
      assert.equal(formatPosture(null), '(no posture set)');
    });

    it('formats posture fields', () => {
      const out = formatPosture({ maturity: 'prototype', security: 'relaxed' });
      assert.ok(out.includes('prototype'));
      assert.ok(out.includes('relaxed'));
    });
  });

  describe('setPostureField', () => {
    it('adds posture block when missing', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'compaction:\n  threshold: 10\n');
      setPostureField(dir, 'maturity', 'production');
      const content = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
      assert.ok(content.includes('posture:'));
      assert.ok(content.includes('maturity: production'));
    });

    it('updates existing field', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'posture:\n  maturity: prototype\n');
      setPostureField(dir, 'maturity', 'production');
      const content = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
      assert.ok(content.includes('maturity: production'));
      assert.ok(!content.includes('maturity: prototype'));
    });

    it('adds new field to existing posture block', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'posture:\n  maturity: prototype\n');
      setPostureField(dir, 'security', 'strict');
      const content = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
      assert.ok(content.includes('maturity: prototype'));
      assert.ok(content.includes('security: strict'));
    });

    it('allows free-text notes', () => {
      const dir = tmpPebblDir();
      writeConfig(dir, 'posture:\n  maturity: prototype\n');
      setPostureField(dir, 'notes', 'speed over durability');
      const content = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
      assert.ok(content.includes('notes: speed over durability'));
    });
  });

  describe('VALID_FIELDS', () => {
    it('has maturity, security, test_expectation', () => {
      assert.ok(VALID_FIELDS.maturity);
      assert.ok(VALID_FIELDS.security);
      assert.ok(VALID_FIELDS.test_expectation);
    });
  });
});
