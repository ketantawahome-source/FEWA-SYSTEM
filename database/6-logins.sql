-- =====================================================================================================
-- FEWA system - schema "logins": who is logged in, and emailed password reset codes
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- These tables are only for the system itself: nothing here needs changing by hand. They are not in backups.
-- Until Nov 2026 they were in the "staff" schema; they are moved here once, with their rows.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS logins;
COMMENT ON SCHEMA logins IS 'FEWA system: logged-in sessions and password reset codes (for the system only)';

DO $$ BEGIN
    IF to_regclass('staff.sessions') IS NOT NULL AND to_regclass('logins.sessions') IS NULL THEN
        ALTER TABLE staff.sessions SET SCHEMA logins;
    END IF;
    IF to_regclass('staff.password_reset_codes') IS NOT NULL AND to_regclass('logins.password_reset_codes') IS NULL THEN
        ALTER TABLE staff.password_reset_codes SET SCHEMA logins;
    END IF;
END $$;


-- ---------- Logged-in sessions (staff, students, and password resets in progress) ----------
-- Only a hash of each session's token is kept. Deleting rows here logs those people out.
CREATE TABLE IF NOT EXISTS logins.sessions (
    token_hash  text PRIMARY KEY,
    kind        text NOT NULL,              -- staff, student or reset
    subject     text NOT NULL,              -- staff.staff.id, students.students.id, or the email being reset
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON logins.sessions (expires_at);


-- ---------- Emailed password reset codes (hashes only) until they are used or expire ----------
CREATE TABLE IF NOT EXISTS logins.password_reset_codes (
    email       text PRIMARY KEY,
    data        jsonb NOT NULL
);


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE logins.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logins.password_reset_codes ENABLE ROW LEVEL SECURITY;
