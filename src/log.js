'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, assertCompleteFlags, assertIntegerFlags } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openDb } = require('./db');
const { qmdUpdate } = require('./qmd');
const { loadRubric, classifyEntry, ensureProjectFiles } = require('./rubric');
const { isThinEntry } = require('./detect-thin');
const { appendLogEvent } = require('./events');

const VALID_CATEGORIES = [
  'decision', 'structure', 'pattern', 'data', 'integration', 'quality',
  'correction',
];

const VALID_TIERS = ['foundation', 'component', 'detail', 'fleeting'];

const VALID_SOURCES = ['human', 'agent', 'hook'];

function validate(flags) {
  if (flags.cat && !VALID_CATEGORIES.includes(flags.cat)) {
    console.error(`Invalid category "${flags.cat}". Valid: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (flags.tier && !VALID_TIERS.includes(flags.tier)) {
    console.error(`Invalid tier "${flags.tier}". Valid: ${VALID_TIERS.join(', ')}`);
    process.exit(1);
  }
  if (flags.source && !VALID_SOURCES.includes(flags.source)) {
    console.error(`Invalid source "${flags.source}". Valid: ${VALID_SOURCES.join(', ')}`);
    process.exit(1);
  }
}

function formatEntry(timestamp, message, category, tier, source, topics) {
  const comment = `<!-- cat:${category} topic:${topics || ''} tier:${tier} source:${source} -->`;

  const date = timestamp.slice(0, 10);
  let out = `[${date}] [${tier}|${category}] ${message}`;
  if (topics) out += `\n  topics: ${topics}`;
  return { comment, out };
}

// Print the linear supersession chain for one entry. The chain is followed in
// both directions from the given id: backward via `corrects` to the root
// belief, then forward via `invalidated_by` to the current one. Each link
// shows when it stopped being true and what replaced it, so an agent can read
// the decision's evolution instead of just its latest state.
function printHistory(pebblDir, id) {
  const db = openDb(pebblDir);
  const byId = (n) => db.prepare('SELECT id, timestamp, category, tier, message, corrects, valid_from, valid_to, invalidated_by FROM logs WHERE id = ?').get(n);

  const start = byId(id);
  if (!start) {
    console.error(`pebbl: no entry #${id}`);
    process.exit(1);
  }

  // Walk backward to the root (the earliest belief this one descends from).
  let root = start;
  const seenBack = new Set([root.id]);
  while (root.corrects != null) {
    const prev = byId(root.corrects);
    if (!prev || seenBack.has(prev.id)) break; // guard against cycles
    seenBack.add(prev.id);
    root = prev;
  }

  // Walk forward via invalidated_by, collecting the linear chain root → current.
  const chain = [root];
  const seenFwd = new Set([root.id]);
  let cur = root;
  while (cur.invalidated_by != null) {
    const next = byId(cur.invalidated_by);
    if (!next || seenFwd.has(next.id)) break; // guard against cycles
    seenFwd.add(next.id);
    chain.push(next);
    cur = next;
  }

  console.log(`--- HISTORY: #${id} (${chain.length} link${chain.length === 1 ? '' : 's'}) ---`);
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    const date = (e.valid_from || e.timestamp || '').slice(0, 10);
    const status = e.valid_to == null
      ? 'current'
      : `superseded ${e.valid_to.slice(0, 10)} by #${e.invalidated_by}`;
    const marker = e.id === Number(id) ? ' *' : '';
    console.log(`  #${e.id} [${e.tier}|${e.category}] ${date} — ${e.message}  (${status})${marker}`);
  }
  console.log('---');
}

module.exports = function log(args) {
  const parsed = parseArgs(args);
  // A value-flag given without a value (e.g. `--corrects --cat decision`) must
  // error, not silently drop — a lost --corrects leaves the contradicted entry
  // live. Likewise --corrects/--relates must be integer entry IDs, not NULL.
  assertCompleteFlags(parsed);
  assertIntegerFlags(parsed, ['corrects', 'relates', 'history']);
  const { flags, positional } = parsed;

  // `pebbl log --history <id>`: read-only view of a decision's supersession
  // chain. Branches before the message-required check below.
  if (flags.history != null) {
    printHistory(requirePebblDir(), parseInt(flags.history, 10));
    return;
  }

  const message = positional.join(' ').trim();
  if (!message) {
    console.error('Usage: pebbl log "[message]"');
    process.exit(1);
  }

  validate(flags);

  const pebblDir = requirePebblDir();

  if (isThinEntry(message)) {
    console.error('pebbl: this reads like a spec sheet — consider adding "because..." to explain the rationale');
  }
  ensureProjectFiles(pebblDir);
  const ts = new Date().toISOString();

  let category = flags.cat || null;
  let tier = flags.tier || null;

  // [session] entries are always uncategorized/fleeting — rubric owns this,
  // manual --cat cannot override it. This prevents agents from accidentally
  // tagging session summaries as decisions.
  const isSession = /^\[session\]/i.test(message);
  if (isSession) {
    if (flags.cat && flags.cat !== 'uncategorized') {
      console.error(`pebbl: [session] entries are auto-classified as uncategorized/fleeting — ignoring --cat ${flags.cat}`);
    }
    category = 'uncategorized';
    tier = 'fleeting';
    console.error('pebbl: tip — consider `pebbl handoff` for structured session handoffs with --done/--todo/--blocked');
  } else {
    // --scope foundation explicitly marks an entry as foundational
    if (flags.scope === 'foundation') {
      tier = 'foundation';
    }
    // Always consult rubric for classification. Manual --cat overrides
    // rubric category, but rubric still informs tier when --tier is absent.
    const rules = loadRubric(pebblDir);
    const classified = classifyEntry(rules, message);
    if (!flags.cat && classified) {
      category = classified.category;
    }
    if (!flags.tier && !flags.scope && classified) {
      tier = classified.tier;
    }
  }

  // If --corrects is set, inherit category/tier from the corrected entry
  // as a fallback when neither manual flags nor rubric provided them.
  if (flags.corrects) {
    const origDb = openDb(pebblDir);
    const origId = parseInt(flags.corrects, 10);
    const original = origDb.prepare('SELECT category, tier FROM logs WHERE id = ?').get(origId);
    if (original) {
      if (!category) category = original.category;
      if (!tier) tier = original.tier;
    }
  }

  // Auto-detect foundation scope from message language.
  // Fires when tier hasn't been explicitly set by the user.
  if (!flags.scope && !flags.tier) {
    const FOUNDATION_PATTERNS = /\b(the\s+(system|project|codebase|repo|app|application)\s+(uses?|is|was|will|requires?)|all\s+(modules?|services?|components?)|everywhere|project-?wide|system-?wide|monorepo|tech\s*stack)\b/i;
    if (FOUNDATION_PATTERNS.test(message)) {
      tier = 'foundation';
      // System-wide statements like "the project uses X because Y" are
      // decisions even when the rubric doesn't match a decision verb.
      // "uses" is too broad for the general rubric, but scoped to
      // system/project/app language it's a reliable signal.
      if (!category || category === 'uncategorized') {
        category = 'decision';
      }
    }
    // Entries with no topic + decision/structure category are likely project-wide
    if (!tier && !flags.topic) {
      if (category === 'decision' || category === 'structure') {
        tier = 'foundation';
      }
    }
  }

  // When rubric didn't match and no manual tier, use category-based defaults:
  // decision/structure/pattern are architectural → component tier.
  // Everything else → detail.
  if (!category) category = 'uncategorized';
  if (!tier) {
    const SIGNAL_CATEGORIES = ['decision', 'structure', 'pattern'];
    tier = SIGNAL_CATEGORIES.includes(category) ? 'component' : 'detail';
  }

  const source = flags.source || 'human';
  const topics = flags.topic || null;
  const relatesTo = flags.relates ? parseInt(flags.relates, 10) : null;
  const corrects = flags.corrects ? parseInt(flags.corrects, 10) : null;

  if (!isSession && !flags.cat && category === 'uncategorized') {
    console.error(`pebbl: no --cat given and rubric didn't match — entry stored as 'uncategorized'`);
    console.error(`       pick one: ${VALID_CATEGORIES.join(', ')}`);
  }

  const db = openDb(pebblDir);

  // On --corrects, the target must still be the current belief (valid_to IS
  // NULL) for the correction to make sense. If it is ALREADY superseded, writing
  // a new open entry here would create a second live belief on the same chain
  // (split-brain), because the stamp's `AND valid_to IS NULL` guard refuses to
  // re-stamp the old target. Detect that case BEFORE inserting anything: follow
  // the chain from the target via invalidated_by to its live head (the still-
  // current entry, valid_to IS NULL), tell the user to correct that head
  // instead, and exit without writing. We do not silently re-target to the head
  // because that would change what the user asked without telling them.
  if (corrects != null) {
    const target = db.prepare('SELECT id, valid_to, invalidated_by FROM logs WHERE id = ?').get(corrects);
    // A truly missing id keeps the existing not-found behavior (fall through and
    // insert with a dangling corrects ref). Only the "exists but already
    // superseded" case is the split-brain we must refuse.
    if (target && target.valid_to != null) {
      // Walk forward to the live head: the entry in this chain whose valid_to
      // is still NULL (same "current belief" notion the reads use).
      let head = target;
      const seen = new Set([head.id]);
      while (head.valid_to != null && head.invalidated_by != null) {
        const next = db.prepare('SELECT id, valid_to, invalidated_by FROM logs WHERE id = ?').get(head.invalidated_by);
        if (!next || seen.has(next.id)) break; // guard against cycles / broken links
        seen.add(next.id);
        head = next;
      }
      console.error(`pebbl: entry #${corrects} is already superseded by #${head.id}; did you mean --corrects ${head.id}?`);
      process.exit(1);
    }
  }

  const mdEntry = formatEntry(ts, message, category, tier, source, topics);
  const md = `## ${ts} - ${message}\n${mdEntry.comment}\n\n`;
  fs.appendFileSync(path.join(pebblDir, 'manual-logs.md'), md);

  // Bi-temporal (v0.5): a new entry is the current belief, valid from now with
  // an open valid_to.
  const info = db.prepare(`
    INSERT INTO logs (timestamp, source, category, tier, message, topics, relates_to, corrects, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(ts, source, category, tier, message, topics, relatesTo, corrects, ts);
  const newId = Number(info.lastInsertRowid);

  // On --corrects, stamp the TARGET's valid_to (when it stopped being true) and
  // invalidated_by (what replaced it) instead of hiding it. The target is known
  // current here (the already-superseded case exited above), so this stamp
  // always lands on a live row.
  if (corrects != null) {
    db.prepare(
      'UPDATE logs SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL'
    ).run(ts, newId, corrects);
  }

  qmdUpdate(pebblDir);

  // ADDITIVE event-sourcing path (P0 tracer). On TOP of the SQLite write +
  // markdown projection above (which stay canonical for now), also append
  // an `append` event to .pebbl/events.jsonl and rebuild a view from the
  // fold. The whole append+rebuild is serialized by the per-store lock so a
  // concurrent local write can't interleave. db.sqlite remains the source
  // of truth; this proves the committed-text path end to end alongside it.
  try {
    appendLogEvent(
      pebblDir,
      { ts, category, tier, message, topics },
      (rows) => rebuildEventsView(pebblDir, rows),
    );
  } catch (err) {
    // Never let the new additive path break the existing, canonical write.
    console.error(`pebbl: events.jsonl append skipped (${err.message})`);
  }

  console.log(mdEntry.out);
};

// Rebuild the folded view projection from `append` events. Separate file
// from manual-logs.md so the existing (canonical) projection is untouched;
// this is the read end of the tracer's append -> fold -> read loop. Row
// shape mirrors regenerateMarkdown (compact.js:114-130) for familiarity.
function rebuildEventsView(pebblDir, rows) {
  let md = '# Events View (folded)\n\n';
  for (const row of rows) {
    md += `## ${row.timestamp} - ${row.message}\n`;
    md += `<!-- eid:${row.eid} cat:${row.category} topic:${row.topics} tier:${row.tier} actor:${row.actor} -->\n\n`;
  }
  fs.writeFileSync(path.join(pebblDir, 'events-view.md'), md);
}

module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.VALID_TIERS = VALID_TIERS;
module.exports.VALID_SOURCES = VALID_SOURCES;
module.exports.printHistory = printHistory;

function displayEntry(e) {
  const date = (e.timestamp || '').slice(0, 10);
  let out = `[${e.tier}|${e.category}] ${date} — ${e.message}`;
  if (e.topics) out += `\n  topics: ${e.topics}`;
  return out;
}

module.exports.displayEntry = displayEntry;
