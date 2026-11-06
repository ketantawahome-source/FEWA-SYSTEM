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


-- ---------- Staff personal and employment details (Staff Management form) ----------
-- One row per staff member, with the same id as their row in staff.staff_accounts. Kept apart from the
-- accounts because every logged-in staff member's browser receives the accounts list; these details are only
-- ever sent to administrators.
CREATE TABLE IF NOT EXISTS staff.staff_details (
    id                        text PRIMARY KEY,   -- staff.staff_accounts.id
    id_number                 text,               -- National ID or passport number
    gender                    text,               -- FEMALE or MALE
    date_of_birth             date,
    department                text,               -- from settings.departments
    date_employed             date,
    address                   text,               -- physical / postal address
    next_of_kin_name          text,
    next_of_kin_relationship  text,
    next_of_kin_phone         text,
    updated_at                timestamptz,
    updated_by                text,               -- the administrator who last saved them
    extra                     jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE staff.staff_details IS 'Personal and employment details of each staff member (administrators only). id = staff_accounts.id.';


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


-- ---------- Logged-in sessions (staff, students, and password resets in progress) ----------
-- Only a hash of each session's token is kept. Deleting rows here logs those people out.
CREATE TABLE IF NOT EXISTS staff.sessions (
    token_hash  text PRIMARY KEY,
    kind        text NOT NULL,              -- staff, student or reset
    subject     text NOT NULL,              -- staff_accounts.id, students.id, or the email being reset
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON staff.sessions (expires_at);


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE staff.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.staff_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.staff_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.role_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff.password_reset_codes ENABLE ROW LEVEL SECURITY;
