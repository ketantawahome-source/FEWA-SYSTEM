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


-- ---------- Password reset requests, safe to look at (user 2026-11-26) ----------
-- Who asked for a password reset and when: the email, the time asked, the expiry, wrong tries and whether it can still
-- be used. Never the code (or its hash). The read-only viewer (office copy) may read this view, not the tables above.
CREATE OR REPLACE VIEW logins.reset_requests AS
SELECT email,
       CASE WHEN data->>'salt' ~ '^\d{10,}$' THEN to_timestamp((data->>'salt')::bigint / 1000.0) END AS requested_at,
       CASE WHEN data->>'expires' ~ '^\d{10,}$' THEN to_timestamp((data->>'expires')::bigint / 1000.0) END AS expires_at,
       CASE WHEN data->>'attempts' ~ '^\d+$' THEN (data->>'attempts')::int END AS wrong_tries,
       CASE WHEN data->>'expires' ~ '^\d{10,}$' THEN to_timestamp((data->>'expires')::bigint / 1000.0) > now() END AS still_valid
FROM logins.password_reset_codes;
COMMENT ON VIEW logins.reset_requests IS 'Password reset requests: email, time asked, expiry, wrong tries, still valid. No codes.';


-- ---------- Sign-in activity (owner, 2026-11-27): every login attempt, for Settings > Access Management > Sign-in Activity ----------
-- When, the account typed (email or AdmNo), how (password), the result, the browser and the address. Never a password.
-- Kept 90 days (older rows are deleted by the server). Only the server and administrators (through the page) see it.
CREATE TABLE IF NOT EXISTS logins.sign_in_activity (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    account     text NOT NULL,
    kind        text,                       -- staff, student, or '' when no such account
    how         text,                       -- Password
    ok          boolean NOT NULL,
    result      text,                       -- Signed in, Wrong password, Not registered at this school, ...
    browser     text,                       -- e.g. Chrome on Windows
    address     text                        -- the IP address it came from
);
CREATE INDEX IF NOT EXISTS sign_in_activity_at ON logins.sign_in_activity (at);
ALTER TABLE logins.sign_in_activity ENABLE ROW LEVEL SECURITY;
