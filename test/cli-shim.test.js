'use strict';
require('./setup'); // incident 2026-06-18: bypass live qmd embeds in tests
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-shim-'));
  // pebbl init requires a git-like dir; just needs to be writable
  return dir;
}

describe('cli shim (direct exec, no node prefix)', () => {
  it('runs ./bin/pebbl.js help and exits 0 with usage output', () => {
    const dir = tmpProject();
    const result = spawnSync(BIN, ['help'], {
      cwd: dir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);

    const out = result.stdout + result.stderr;
    assert.ok(
      out.toLowerCase().includes('usage') || out.toLowerCase().includes('pebbl'),
      `expected usage output, got: ${out.slice(0, 300)}`
    );
  });

  it('exits 0 with no arguments (prints help)', () => {
    const dir = tmpProject();
    const result = spawnSync(BIN, [], {
      cwd: dir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`);
  });
});
