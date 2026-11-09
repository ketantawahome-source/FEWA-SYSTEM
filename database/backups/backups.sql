-- =====================================================================================================
-- FEWA system - the BACKUPS database (PostgreSQL on the office computer, database "fewa_backups")
-- =====================================================================================================
-- This is NOT run on the main database (Supabase): server.mjs runs it on the backups database set in
-- db-config.json under "backups", creating that database the first time. Safe to run more than once.
-- One row per backup: "Back Up Now" in Settings > System Data Backups, or the daily automatic backup.
-- "data" holds every table's rows: {"students": [...], "courses": [...], "stored_files": [...], ...}.
-- Restoring (from the system) puts those rows back into the main database, after first backing it up.
-- To look at a backup in pgAdmin: fewa_backups > Schemas > backups > Tables > snapshots, e.g.
--   SELECT jsonb_pretty(data->'students') FROM backups.snapshots ORDER BY created_at DESC LIMIT 1;
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS backups;
COMMENT ON SCHEMA backups IS 'FEWA system: full backups of the data';


CREATE TABLE IF NOT EXISTS backups.snapshots (
    id            text PRIMARY KEY,                    -- e.g. 2026-11-06T09-30-00-000Z-a1b2c3
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text,                                -- the staff member who made it, or "automatic"
    note          text,                                -- e.g. "Before the January intake"
    summary       jsonb,                               -- how many students, documents, staff, files
    size_bytes    bigint,
    data          jsonb NOT NULL
);
COMMENT ON TABLE backups.snapshots IS 'Full backups of the FEWA data. Made and restored from Settings > System Data Backups.';
CREATE INDEX IF NOT EXISTS snapshots_created_at ON backups.snapshots (created_at DESC);


-- Uploaded files: one copy of each, however many backups have it. (Backups before Nov 2026 have them in "data".)
CREATE TABLE IF NOT EXISTS backups.files (
    id            text PRIMARY KEY,                    -- the same id as in files.stored_files
    name          text,
    type          text,
    size          bigint,
    content       bytea NOT NULL,
    created_at    timestamptz
);
COMMENT ON TABLE backups.files IS 'The uploaded files of the FEWA backups. Removed by the system once no backup has them.';

-- Which backup has which files
CREATE TABLE IF NOT EXISTS backups.snapshot_files (
    snapshot_id   text NOT NULL REFERENCES backups.snapshots(id) ON DELETE CASCADE,
    file_id       text NOT NULL REFERENCES backups.files(id),
    PRIMARY KEY (snapshot_id, file_id)
);
CREATE INDEX IF NOT EXISTS snapshot_files_file ON backups.snapshot_files (file_id);
