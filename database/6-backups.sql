-- =====================================================================================================
-- FEWA system - schema "backups": full copies of the system's data, made with "Back Up Now"
-- (Settings > System Data Backups). Kept in Supabase; each one is also saved as a file in Supabase
-- Storage (bucket "backups") when the Supabase service key is set.
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- "data" holds every table's rows: {"students": [...], "courses": [...], "stored_files": [...], ...}.
-- Restoring a backup (from the system) puts those rows back, after first making a backup of the data as it is.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS backups;
COMMENT ON SCHEMA backups IS 'FEWA system: full backups of the data, made from the system (Back Up Now)';


CREATE TABLE IF NOT EXISTS backups.snapshots (
    id            text PRIMARY KEY,                    -- e.g. 2026-11-06T09-30-00-000Z-a1b2c3
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text,                                -- the staff member who made it
    note          text,                                -- e.g. "Before the January intake"
    summary       jsonb,                               -- how many students, documents, staff, files
    size_bytes    bigint,
    storage_path  text,                                -- the file in Supabase Storage, when saved there
    data          jsonb NOT NULL
);
COMMENT ON TABLE backups.snapshots IS 'Full backups of the FEWA data. Made and restored from Settings > System Data Backups.';


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE backups.snapshots ENABLE ROW LEVEL SECURITY;
