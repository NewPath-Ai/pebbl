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
}

module.exports = { migrate, getVersion };
