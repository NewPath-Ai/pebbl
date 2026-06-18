'use strict';

function getVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) return 0;
  const v = parseFloat(row.value) || 0;
  // Legacy: old pebbl used integer versions (1, 2). Normalize to semver.
  // Version 1 = v0.2 era (had categories/tiers but not the v0.3 rename).
  if (v >= 1 && v < 1.0 + Number.EPSILON) return 0.2;
  return v;
}

function setVersion(db, version) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
}

function migrate_v01_to_v02(db) {
  const columns = db.prepare("PRAGMA table_info(logs)").all();
  const colNames = new Set(columns.map(c => c.name));
  if (colNames.has('category')) return;

  const migration = db.transaction(() => {
    db.exec(`
      ALTER TABLE logs ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized';
      ALTER TABLE logs ADD COLUMN tier TEXT NOT NULL DEFAULT 'detail';
      ALTER TABLE logs ADD COLUMN topics TEXT;
      ALTER TABLE logs ADD COLUMN relates_to INTEGER;
      ALTER TABLE logs ADD COLUMN corrects INTEGER;
    `);
    db.prepare("UPDATE logs SET source = 'human' WHERE source = 'manual'").run();
  });
  migration();
}

function migrate_v02_to_v03(db) {
  // Rename signal → component (safe default: most signal entries are module-level)
  db.prepare("UPDATE logs SET tier = 'component' WHERE tier = 'signal'").run();
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  let version = getVersion(db);

  if (version < 0.2) {
    migrate_v01_to_v02(db);
    setVersion(db, 0.2);
    console.error('pebbl: migrated db to v0.2');
  }
  if (version < 0.3) {
    migrate_v02_to_v03(db);
    setVersion(db, 0.3);
    console.error('pebbl: migrated db to v0.3 (signal → component tier)');
  }
  if (version < 0.4) {
    const columns = db.prepare('PRAGMA table_info(handoffs)').all();
    if (columns.length > 0) {
      const colNames = new Set(columns.map(c => c.name));
      if (!colNames.has('docs')) {
        db.exec('ALTER TABLE handoffs ADD COLUMN docs TEXT');
      }
    }
    setVersion(db, 0.4);
    console.error('pebbl: migrated db to v0.4 (handoffs.docs)');
  }
  if (version < 0.5) {
    // Bi-temporal supersession: stamp WHEN a belief stopped being true instead
    // of hiding it. valid_to IS NULL == currently believed; invalidated_by ==
    // the entry that superseded it. Additive, no data loss.
    const cols = new Set(db.prepare('PRAGMA table_info(logs)').all().map(c => c.name));
    if (!cols.has('valid_from')) {
      db.exec(`ALTER TABLE logs ADD COLUMN valid_from TEXT;
               ALTER TABLE logs ADD COLUMN valid_to TEXT;
               ALTER TABLE logs ADD COLUMN invalidated_by INTEGER;`);
    }
    // Backfill: every existing row was valid from its own timestamp.
    db.prepare('UPDATE logs SET valid_from = timestamp WHERE valid_from IS NULL').run();
    // Retro-stamp anything an existing correction pointed at, so today's
    // hide-behavior is preserved as stamped-superseded. The most recent
    // correcting entry wins (linear chain, newest id last).
    db.prepare(`
      UPDATE logs SET
        valid_to = (SELECT c.timestamp FROM logs c WHERE c.corrects = logs.id ORDER BY c.id DESC LIMIT 1),
        invalidated_by = (SELECT c.id FROM logs c WHERE c.corrects = logs.id ORDER BY c.id DESC LIMIT 1)
      WHERE valid_to IS NULL
        AND id IN (SELECT corrects FROM logs WHERE corrects IS NOT NULL)
    `).run();
    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_valid_to ON logs(valid_to)');
    setVersion(db, 0.5);
    console.error('pebbl: migrated db to v0.5 (bi-temporal corrects)');
  }
  if (version < 0.6) {
    // Rerank signals: columns the future weighted score reads. Additive, no
    // data loss. They are NOT populated at runtime in this slice (incrementing
    // access_count on read and setting importance are follow-ups); the score is
    // proven against the audited fixture first. Defaults keep existing rows
    // scorable (importance 0, access_count 0, last_accessed unknown).
    const cols = new Set(db.prepare('PRAGMA table_info(logs)').all().map(c => c.name));
    if (!cols.has('importance')) {
      db.exec('ALTER TABLE logs ADD COLUMN importance REAL DEFAULT 0;');
    }
    if (!cols.has('access_count')) {
      db.exec('ALTER TABLE logs ADD COLUMN access_count INTEGER DEFAULT 0;');
    }
    if (!cols.has('last_accessed')) {
      db.exec('ALTER TABLE logs ADD COLUMN last_accessed TEXT DEFAULT NULL;');
    }
    setVersion(db, 0.6);
    console.error('pebbl: migrated db to v0.6 (rerank signals)');
  }
}

module.exports = { migrate, getVersion };
