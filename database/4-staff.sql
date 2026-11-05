-- =====================================================================================================
-- FEWA system - schema "staff": logins, staff roles and their rights
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Passwords are never stored, only their hashes. Don't edit salt / hash by hand: reset a password from
-- the system instead (Staff Management > Send Reset Link, or Change Password).
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS staff;
COMMENT ON SCHEMA staff IS 'FEWA system: administrator and staff logins, roles and rights';


-- ---------- Administrator and staff logins (Staff Management) ----------
CREATE TABLE IF NOT EXISTS staff.staff_accounts (
    id                    text PRIMARY KEY,
    username              text,             -- the email used to log in
    first_name            text,
    last_name             text,
    phone                 text,
    job_title             text,             -- a role name from staff.staff_roles
    role                  text,             -- Administrator or Staff
    status                text,             -- Active or Inactive
    salt                  text,             -- password (hash only, never the password itself)
    hash                  text,
    admin_reset_required  boolean,
    created_at            timestamptz,
    position              integer NOT NULL DEFAULT 0,   -- order in the Staff list
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON COLUMN staff.staff_accounts.role IS 'Administrator or Staff';
COMMENT ON COLUMN staff.staff_accounts.status IS 'Active or Inactive';


-- ---------- Staff job titles (Settings > Access Management > Roles) ----------
CREATE TABLE IF NOT EXISTS staff.staff_roles (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. Registrar; offered as staff_accounts.job_title
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);


-- ---------- Rights given to each staff role (Settings > Access Management > Role Operations) ----------
CREATE TABLE IF NOT EXISTS staff.role_operations (
    role        text PRIMARY KEY,           -- a name from staff.staff_roles
    rights      jsonb NOT NULL              -- {"assigned": ["students.view", ...], "limits": {...}}
);


-- ---------- Emailed password reset codes (hashes only) until they are used or expire ----------
CREATE TABLE IF NOT EXISTS staff.password_reset_codes (
    email       text PRIMARY KEY,
    data        jsonb NOT NULL
);


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE staff.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.staff_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.role_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.password_reset_codes ENABLE ROW LEVEL SECURITY;
