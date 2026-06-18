'use strict';
// CI smoke test: drive the real CLI end-to-end on a freshly populated store,
// exactly the way the dogfooded pebbl repo uses its own .pebbl/. This is the
// feedback loop the task closes — a populated `context` run is what would have
// caught the bugs that sat in feedback.jsonl. It spawns bin/pebbl.js as a
// subprocess (like cli-shim.test.js) so it exercises the full dispatch path,
// not just an imported function.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN = path.resolve(__dirname, '../bin/pebbl.js');

// Run the CLI in `cwd`. Returns { status, out } where out merges stdout+stderr
// (pebbl writes hints to stderr). Throws with context on a non-zero exit so a
// broken round-trip fails loudly instead of silently passing a later assert.
function run(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!allowFail && r.status !== 0) {
    throw new Error(`pebbl ${args.join(' ')} exited ${r.status}\n${out}`);
  }
  return { status: r.status, out };
}

function setupProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-dogfood-'));
  // pebbl init writes a git hook only when a .git/ DIR exists; we leave it out
  // so init stays inside the temp project without touching a real repo.
  run(dir, ['init']);
  return dir;
}

describe('dogfood round-trip: log -> context -> compact --preview -> execute -> narrative', () => {
  it('survives a full populated round-trip and reports the open-handoff count', () => {
    const dir = setupProject();
    try {
      // ── log ── seed enough entries on one topic to make compaction eligible
      // (default component threshold is 15; the per-topic preview threshold is
      // lower, so a dozen detail entries on one topic is plenty to exercise the
      // grouping path without depending on the exact number).
      for (let i = 0; i < 12; i++) {
        run(dir, ['log', `auth detail decision number ${i} because reason ${i}`,
          '--cat', 'decision', '--topic', 'auth', '--tier', 'detail']);
      }
      run(dir, ['log', 'the project uses sqlite because it is a single-file embedded store',
        '--cat', 'decision', '--topic', 'storage', '--scope', 'foundation']);

      // ── narrative ── set it so the round-trip ends with a narrative that
      // links to the foundation entry.
      const narr = run(dir, ['narrative', 'A test project that stores decisions in sqlite.']);
      assert.match(narr.out, /Narrative updated/);

      // ── open handoff ── so context has an open-handoff count to report.
      run(dir, ['handoff', 'mid-task handoff for the round-trip test',
        '--done', 'seeded entries', '--todo', 'finish the round-trip', '--topic', 'auth']);

      // ── context ── must run clean AND surface the open handoff with its count.
      const ctx = run(dir, ['context']);
      assert.match(ctx.out, /Open handoff from previous agent \(#\d+/,
        'context must report the open handoff (the open-handoff count surface)');
      assert.match(ctx.out, /--- NARRATIVE ---/, 'context must show the narrative section');

      // ── compact --preview ── must run clean (it groups eligible entries; we
      // do not assert a specific group count, only that the preview path works).
      const preview = run(dir, ['compact', '--preview']);
      assert.equal(preview.status, 0, 'compact --preview must exit 0');

      // ── compact --execute ── the rollup write path. Must not error on a
      // populated store.
      const execd = run(dir, ['compact', '--execute']);
      assert.equal(execd.status, 0, 'compact --execute must exit 0');

      // ── context again ── the store is still readable after compaction.
      const ctx2 = run(dir, ['context']);
      assert.equal(ctx2.status, 0, 'context must still run after compaction');
      assert.match(ctx2.out, /--- NARRATIVE ---/, 'narrative survives compaction');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('context surfaces unresolved feedback and a resolved item drops off', () => {
    const dir = setupProject();
    try {
      run(dir, ['log', 'seed so context has content', '--cat', 'decision', '--topic', 'core']);

      // Drop two feedback items inside the project.
      const a = run(dir, ['feedback', 'first bug to action']);
      const b = run(dir, ['feedback', 'second bug to action']);
      const idA = (a.out.match(/\[([0-9a-f]{8})\]/) || [])[1];
      const idB = (b.out.match(/\[([0-9a-f]{8})\]/) || [])[1];
      assert.ok(idA && idB, 'feedback must echo a stable id');

      // context surfaces BOTH as unresolved, with the triage pointer.
      const ctx = run(dir, ['context']);
      assert.match(ctx.out, /UNRESOLVED FEEDBACK \(2\)/, 'context shows 2 unresolved feedback items');
      assert.match(ctx.out, /pebbl feedback --list/, 'context prints the triage pointer');

      // Resolve one; it drops off the surface and the count falls to 1.
      run(dir, ['feedback', '--resolve', idA]);
      const ctx2 = run(dir, ['context']);
      assert.match(ctx2.out, /UNRESOLVED FEEDBACK \(1\)/, 'resolved item drops off, count falls to 1');
      assert.ok(!ctx2.out.includes(idA), 'resolved id no longer shown');
      assert.ok(ctx2.out.includes(idB), 'unresolved id still shown');

      // --list mirrors the surface: only the unresolved item remains.
      const list = run(dir, ['feedback', '--list']);
      assert.ok(list.out.includes(idB) && !list.out.includes(idA),
        'feedback --list shows only unresolved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('feedback outside any project does not mint a stray .pebbl/ in cwd', () => {
    // An empty throwaway dir with NO .pebbl/ anywhere above it, and a fake HOME
    // so the global fallback lands in the sandbox, not the real ~/.pebbl.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-nowhere-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pebbl-home-'));
    try {
      const r = spawnSync(process.execPath, [BIN, 'feedback', 'feedback from nowhere'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
      });
      assert.equal(r.status, 0, `feedback should succeed: ${r.stderr}`);
      // No stray .pebbl/ minted in the cwd.
      assert.ok(!fs.existsSync(path.join(cwd, '.pebbl')),
        'feedback outside a project must NOT create a stray .pebbl/ in cwd');
      // It went to the global store under the (fake) HOME instead.
      assert.ok(fs.existsSync(path.join(fakeHome, '.pebbl', 'feedback.jsonl')),
        'feedback should fall back to the global ~/.pebbl store');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
