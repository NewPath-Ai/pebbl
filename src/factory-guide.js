'use strict';

// ── Shared --factory-guide printer (DRY: one renderer for the trio) ──────────
//
// readback, liveness, and encode(recurrence) each expose `--factory-guide`: a
// STATIC trigger-condition manifest (call_when/precondition/effect/consumes/
// produces[/caveat]) plus BUILT|PLANNED edges, so a host factory can wire the
// primitive without reading the source. The manifest DATA differs per command
// and STAYS in each module; only the rendering was triplicated, so a format tweak
// had to be made in three places or the guides DRIFT. This is that one renderer.
//
// PURE: takes a manifest object, returns the exact output STRING (trailing \n
// included) — the caller does the one process.stdout.write, matching pebbl's
// render-returns / caller-emits idiom. No store access, no I/O here.
//
// GENERIC over the per-command shape: the human body walks the manifest's own
// keys in insertion order and renders every field except `command` (the header)
// and `edges` (rendered specially below). That covers encode's extra `caveat:`
// line and liveness's two `which`-keyed manifests with no special-casing — pass
// the chosen manifest object in (e.g. FACTORY_GUIDE[which]).

// Fields rendered by the header/edges block rather than the generic field loop.
const NON_FIELD_KEYS = new Set(['command', 'edges']);

// Width the `<key>:` label is padded to so every value lines up (value starts at
// column 17 = 2-space indent + 14). Frozen to preserve byte-identical output.
const LABEL_WIDTH = 14;

// renderFactoryGuide(manifest, { json }) -> exact output string (with trailing \n).
function renderFactoryGuide(manifest, opts = {}) {
  if (opts.json) {
    return JSON.stringify(manifest, null, 2) + '\n';
  }
  const lines = [
    `${manifest.command} — factory integration guide (trigger-conditions, not stage names)`,
    ``,
  ];
  for (const key of Object.keys(manifest)) {
    if (NON_FIELD_KEYS.has(key)) continue;
    lines.push(`  ${`${key}:`.padEnd(LABEL_WIDTH)}${manifest[key]}`);
  }
  lines.push(``);
  lines.push(`  edges (every edge tagged BUILT|PLANNED — PLANNED = surface it, do not wire):`);
  for (const e of manifest.edges) lines.push(`    -> ${e.to}  [${e.status}]`);
  return lines.join('\n') + '\n';
}

module.exports = { renderFactoryGuide };
