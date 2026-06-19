'use strict';
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { openReadDb, topicFilter, notCorrected } = require('./db');
const { storeMode } = require('./store-mode');
const { qmdAvailable, qmdQuery } = require('./qmd');
const { displayEntry } = require('./log');
const { ensureProjectFiles, loadConfig } = require('./rubric');
const { splitItems } = require('./handoff');
const { mirrorLogs, mirrorHandoffs } = require('./mirror');
const { searchSources } = require('./sources');

// Normalize a message for near-duplicate comparison.
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Split a query into lowercased whitespace-delimited terms for the SQLite
// fallback. The fallback used to LIKE the whole query as one string, so a
// multi-word search ("invite code") only matched docs containing that exact
// adjacent phrase and missed almost everything. Tokenizing into AND-of-terms
// makes each term a separate filter, recovering recall when the words are
// scattered. An empty/blank query yields [] (callers treat that as "match all").
function queryTerms(query) {
  return (query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// True when every term in `terms` appears (substring) in `text`. AND semantics,
// matching the SQL we build below; an empty term list matches everything.
function matchesAllTerms(text, terms) {
  const t = (text || '').toLowerCase();
  return terms.every(term => t.includes(term));
}

// Strip the deterministic "handoff #N field: " prefix from a materialized item.
function stripHandoffPrefix(message) {
  const m = message.match(/^handoff #\d+ (?:summary|done|todo|blocked): (.+)$/i);
  return m ? m[1] : message.replace(/^handoff #\d+: /i, '');
}

// Render a structured result object to a display line. Results read from
// another machine's mirror carry r.machine and get a leading [machine] tag.
function formatResult(r) {
  // Source-doc discovery hits: external truth, tagged [source], no machine/topics.
  if (r.isSource) return `[source] ${r.source} — ${r.message}`;
  // Compacted/archived history, surfaced only under --include-archive, tagged
  // and ranked lowest so it never re-bloats live results.
  if (r.tier === 'archived') return `[archived] [${r.cat}] ${r.date} — ${r.message}`;
  let out;
  if (r.isHandoff) {
    const open = r.status === 'open' ? ' · OPEN' : '';
    out = `[handoff #${r.handoffId}${open} · ${r.field}] ${r.date} — ${stripHandoffPrefix(r.message)}`;
  } else {
    out = `[${r.tier}|${r.cat}] ${r.date} — ${r.message}`;
  }
  if (r.machine) out = `[${r.machine}] ` + out;
  if (r.topics) out += `\n  topics: ${r.topics}`;
  return out;
}

// Matches from other machines' synced memory (.pebbl/mirror/<machine>/).
// Plain substring scan over the parsed projections; returns [] when no
// mirrors exist so search output is unchanged until then.
function searchMirrors(pebblDir, query, cat, topic) {
  // Same AND-of-terms recall fix as the SQLite fallback: mirror search is also
  // a qmd-less substring scan, so a multi-word query must match on all terms
  // rather than the exact adjacent phrase.
  const terms = queryTerms(query);
  const topicMatch = topics => !topic ||
    (topics || '').split(',').map(t => t.trim()).includes(topic);

  const results = [];
  for (const e of mirrorLogs(pebblDir)) {
    if (cat && e.cat !== cat) continue;
    if (!topicMatch(e.topics)) continue;
    if (!matchesAllTerms(e.message, terms)) continue;
    results.push({
      isHandoff: false, machine: e.machine, tier: e.tier, cat: e.cat,
      topics: e.topics, date: e.date, message: e.message,
    });
  }
  // Handoff items carry no category — same as the local handoff paths.
  for (const h of mirrorHandoffs(pebblDir)) {
    if (!topicMatch(h.topics)) continue;
    if (!matchesAllTerms(h.message, terms)) continue;
    results.push({
      isHandoff: true, machine: h.machine, handoffId: h.handoffId,
      field: h.field, status: h.status, topics: h.topics,
      date: h.date, message: h.message,
    });
  }
  return results.slice(0, 10);
}

// qmd indexes the whole .pebbl dir, so once mirrors exist it returns mirror
// blocks too — without attribution. Drop local results that duplicate a
// mirror match and keep the attributed version. No mirrors → no-op.
function mergeMirror(results, mirrorResults) {
  if (mirrorResults.length === 0) return results;
  const mirrorKeys = new Set(mirrorResults.map(r => normalize(r.message)));
  const kept = results.filter(r => {
    const key = normalize(stripHandoffPrefix(r.message || ''));
    return !key || !mirrorKeys.has(key);
  });
  return [...kept, ...mirrorResults];
}

// Drop handoff items that near-duplicate a log entry already in the results —
// the atomic log entry is the authority, the handoff item is a recap of it.
function dedupeResults(results) {
  const logKeys = new Set(
    results.filter(r => !r.isHandoff && r.message).map(r => normalize(r.message))
  );
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = normalize(stripHandoffPrefix(r.message || ''));
    if (r.isHandoff) {
      if (logKeys.has(key)) continue;       // suppressed by an authoritative log entry
      if (seen.has('h:' + key)) continue;    // collapse repeats across handoffs
      seen.add('h:' + key);
    }
    out.push(r);
  }
  return out;
}

function parseQmdResults(raw, cat, topic) {
  const blocks = raw.split('\nqmd://');
  const results = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = (i === 0 ? '' : '\n') + blocks[i];

    const handoffMatch = block.match(/<!--\s*handoff:(\d+)\s+field:(\S+)\s+topic:(\S*)(?:\s+status:(\S+))?\s*-->/);
    const logMatch = block.match(/<!--\s*cat:(\S+)\s+topic:(\S*)\s+tier:(\S+)\s+source:(\S+)\s*-->/);

    if (handoffMatch) {
      const entryTopics = handoffMatch[3];
      if (topic) {
        const topicParts = (entryTopics || '').split(',').map(t => t.trim());
        if (!topicParts.includes(topic)) continue;
      }
      const dateMatch = block.match(/##\s+(\S+)\s+-\s+(.+)/);
      results.push({
        isHandoff: true,
        handoffId: handoffMatch[1],
        field: handoffMatch[2],
        topics: entryTopics,
        status: handoffMatch[4] || 'closed',
        date: dateMatch ? dateMatch[1].slice(0, 10) : 'unknown',
        message: dateMatch ? dateMatch[2] : '(unknown)',
      });
    } else if (logMatch) {
      const entryCat = logMatch[1];
      const entryTopics = logMatch[2];
      const entryTier = logMatch[3];

      if (cat && entryCat !== cat) continue;
      if (topic) {
        const topicParts = (entryTopics || '').split(',').map(t => t.trim());
        if (!topicParts.includes(topic)) continue;
      }
      const dateMatch = block.match(/##\s+(\S+)\s+-\s+(.+)/);
      results.push({
        isHandoff: false,
        tier: entryTier,
        cat: entryCat,
        topics: entryTopics,
        date: dateMatch ? dateMatch[1].slice(0, 10) : 'unknown',
        message: dateMatch ? dateMatch[2] : (block.split('\n')[1] || '(unknown)'),
      });
    } else {
      const trimmed = block.trim();
      if (trimmed) results.push({ raw: trimmed, message: '' });
    }
  }

  return results;
}

// SQLite fallback: scan closed-handoff fields for the query and emit matching items.
function searchHandoffsSqlite(db, query, topic) {
  const terms = queryTerms(query);
  // Row pre-filter: each term must appear in at least one handoff field. This
  // is just to narrow the candidate rows cheaply; the authoritative per-item
  // AND-of-terms check happens below so we don't emit an item that only matches
  // because different terms landed in different fields.
  const perTerm = '(summary LIKE ? OR done LIKE ? OR todo LIKE ? OR blocked LIKE ?)';
  const where = terms.length ? terms.map(() => perTerm).join(' AND ') : '1=1';
  const params = [];
  for (const t of terms) { const like = `%${t}%`; params.push(like, like, like, like); }
  const rows = db.prepare(`
    SELECT id, summary, done, todo, blocked, topics, status, closed_at, timestamp
    FROM handoffs
    WHERE ${where}
  `).all(...params);

  const results = [];
  for (const row of rows) {
    if (topic) {
      const topicParts = (row.topics || '').split(',').map(t => t.trim());
      if (!topicParts.includes(topic)) continue;
    }
    const date = (row.closed_at || row.timestamp || '').slice(0, 10);
    const status = row.status || 'open';
    for (const field of ['done', 'todo', 'blocked']) {
      for (const item of splitItems(row[field])) {
        if (matchesAllTerms(item, terms)) {
          results.push({
            isHandoff: true, handoffId: String(row.id), field, status,
            topics: row.topics, date, message: item,
          });
        }
      }
    }
    if (matchesAllTerms(row.summary, terms)) {
      results.push({
        isHandoff: true, handoffId: String(row.id), field: 'summary', status,
        topics: row.topics, date, message: row.summary,
      });
    }
  }
  return results;
}

function searchSqlite(pebblDir, query, cat, topic, mirrorResults, sourceResults) {
  // Wire 2 — reads-from-fold: events-mode reads the folded view.sqlite (so a
  // pulled events.jsonl is searchable), legacy reads db.sqlite unchanged. The
  // SQLite fallback is the only search path that touches a db handle; the qmd
  // path searches the markdown the fold ALSO regenerates, so it is already
  // fold-aware. searchHandoffsSqlite reuses this same handle (handoffs table is
  // in the view too), so both log and handoff hits come from the fold.
  const db = openReadDb(pebblDir);

  // AND-of-terms: each whitespace-delimited term becomes its own LIKE clause,
  // so a multi-word query matches rows containing all the words (in any order),
  // not only rows with the exact adjacent phrase. A blank query (no terms)
  // degrades to "1=1" so it still returns recent rows rather than nothing.
  const terms = queryTerms(query);
  const messageClause = terms.length
    ? terms.map(() => 'message LIKE ?').join(' AND ')
    : '1=1';
  // Bi-temporal (v0.5): search surfaces the CURRENT belief only — superseded
  // entries are excluded by the same `valid_to IS NULL` predicate the context
  // read sites use (one definition, via notCorrected()), instead of the old
  // hide-by-subquery. Their history stays reachable via `pebbl log --history`.
  let sql = `SELECT timestamp, source, category, tier, message, topics FROM logs WHERE tier != 'archived' AND ${notCorrected()} AND ${messageClause}`;
  const params = terms.map(t => `%${t}%`);

  if (cat) {
    sql += ' AND category = ?';
    params.push(cat);
  }
  if (topic) {
    const filter = topicFilter(topic);
    sql += ' ' + filter.clause;
    params.push(...filter.params);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 20';
  const rows = db.prepare(sql).all(...params);

  const logResults = rows.map(row => ({
    isHandoff: false,
    tier: row.tier,
    cat: row.category,
    topics: row.topics,
    date: (row.timestamp || '').slice(0, 10),
    message: row.message,
  }));

  const handoffResults = searchHandoffsSqlite(db, query, topic);
  // Source-doc hits rank BELOW curated + mirror entries — appended last.
  const results = [
    ...mergeMirror(dedupeResults([...logResults, ...handoffResults]), mirrorResults || []),
    ...(sourceResults || []),
  ];

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\n--- SEARCH: ${query} ---`);
  for (const r of results) {
    console.log(r.raw || formatResult(r));
    console.log();
  }
  console.log('---\n');
}

module.exports = function search(args) {
  const { flags, positional } = parseArgs(args);
  const query = positional.join(' ').trim();

  if (!query) {
    console.error('Usage: pebbl search "[query]"');
    process.exit(1);
  }

  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);

  // Wire 2 — reads-from-fold for BOTH search paths. The qmd path below searches
  // the MARKDOWN files (manual-logs.md / handoffs.md), which the fold also
  // regenerates from events.jsonl; but unlike the sqlite path it never opens a
  // db handle, so openDb's lazy fold never runs for it. Trigger the fold here in
  // events-mode so a just-pulled/merged events.jsonl is materialized into BOTH
  // the markdown (for qmd) AND view.sqlite (for the sqlite fallback) before
  // either reads. Cheap when already fresh (a fingerprint compare, no fold) and
  // best-effort — a fold failure must never break search (db.sqlite/markdown are
  // still there as the canonical read).
  if (storeMode(pebblDir) === 'events') {
    try { require('./staleness').ensureFresh(pebblDir); } catch { /* never break search */ }
  }

  const mirrorResults = searchMirrors(pebblDir, query, flags.cat, flags.topic);
  // Read-only [source] discovery hits, ranked BELOW curated entries (appended last).
  const config = loadConfig(pebblDir) || {};
  const sourceResults = searchSources(pebblDir, query, config);

  if (qmdAvailable()) {
    const raw = qmdQuery(pebblDir, query);

    const all = raw.trim()
      ? dedupeResults(parseQmdResults(raw, flags.cat, flags.topic))
      : [];
    // Archived (compacted) history is hidden by default and only restored,
    // ranked lowest, under --include-archive — recoverability without re-bloat.
    const local = all.filter(r => r.tier !== 'archived');
    const archived = flags['include-archive'] ? all.filter(r => r.tier === 'archived') : [];
    const results = [...mergeMirror(local, mirrorResults), ...sourceResults, ...archived];

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`\n--- SEARCH: ${query} ---`);
    for (const r of results) {
      console.log(r.raw || formatResult(r));
      console.log();
    }
    console.log('---\n');
  } else {
    searchSqlite(pebblDir, query, flags.cat, flags.topic, mirrorResults, sourceResults);
  }
};

module.exports._internal = { parseQmdResults, dedupeResults, formatResult, stripHandoffPrefix, normalize, queryTerms, matchesAllTerms, searchHandoffsSqlite, searchMirrors, mergeMirror, searchSources, searchSqlite };
