'use strict';

function migrate(db) {
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
  console.error('pebbl: migrated db to v0.2');
}

module.exports = { migrate };
