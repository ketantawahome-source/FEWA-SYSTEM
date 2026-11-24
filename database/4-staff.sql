-- =====================================================================================================
-- FEWA system - schema "staff": the staff table (one row per staff member: login and personal details)
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Passwords are never stored, only their hashes. Don't edit salt / hash by hand: reset a password from
-- the system instead (Staff Management > Send Reset Link, or Change Password).
-- The job titles and their rights are in the settings schema (staff_roles, role_operations); logins in
-- progress and password reset codes in the logins schema.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS staff;
COMMENT ON SCHEMA staff IS 'FEWA system: the staff';


-- Until Nov 2026 staff were in two tables, staff_accounts and staff_details: they become this one table
DO $$ BEGIN
    IF to_regclass('staff.staff_accounts') IS NOT NULL AND to_regclass('staff.staff') IS NULL THEN
        ALTER TABLE staff.staff_accounts RENAME TO staff;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff.staff (
    id                        text PRIMARY KEY,
    -- Account (Staff Management)
    username                  text,             -- the email used to log in
    first_name                text,
    last_name                 text,
    phone                     text,
    job_title                 text,             -- a role name from settings.staff_roles
    role                      text,             -- Administrator or Staff
    status                    text,             -- Active or Inactive
    salt                      text,             -- password (hash only, never the password itself)
    hash                      text,
    admin_reset_required      boolean,
    created_at                timestamptz,
    position                  integer NOT NULL DEFAULT 0,   -- order in the Staff list
    extra                     jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Personal & employment details (only administrators ever see these)
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS id_number text;                 -- National ID or passport number
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS gender text;                    -- FEMALE or MALE
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS department text;                -- from settings.departments
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS date_employed date;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS address text;                   -- physical / postal address
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS next_of_kin_name text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS next_of_kin_relationship text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS next_of_kin_phone text;
-- The bio data screen (Nov 2026): biodata, contacts, school access, employment history and payroll details
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS second_name text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS preferred_name text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS title text;                     -- Mr, Mrs, Ms, Dr...
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS marital_status text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS passport_no text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS nationality text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS work_email text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS ethnicity text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS personal_email text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS school_access text;             -- the schools ticked, joined by " | "
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS date_left date;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS profession text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS staff_rank text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS bank text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS bank_branch text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS pin_number text;                -- KRA PIN
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS bank_account text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS sha_number text;                -- formerly NHIF
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS sacco_no text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS pension_no text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS nssf_number text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS staff_number text;              -- payroll / staff number
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS tax_exempt text;                -- No or Yes
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS tax_exempt_reason text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS supervisor text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS deduct_helb text;               -- No or Yes
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS exam_supervisor text;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS photo jsonb;                    -- reference to the picture in files.stored_files
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS signature jsonb;                -- reference to the picture in files.stored_files
-- After an administrator's Reset Password: the temporary password works once, then they must choose their own
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS must_change_password boolean;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS details_updated_at timestamptz;
ALTER TABLE staff.staff ADD COLUMN IF NOT EXISTS details_updated_by text;        -- the administrator who last saved them
COMMENT ON TABLE staff.staff IS 'The staff: login account and personal & employment details, one row per staff member.';
COMMENT ON COLUMN staff.staff.role IS 'Administrator or Staff';
COMMENT ON COLUMN staff.staff.status IS 'Active or Inactive';

-- The details kept in staff_details (Nov 2026) move into staff.staff, then that table goes
DO $$ BEGIN
    IF to_regclass('staff.staff_details') IS NOT NULL THEN
        UPDATE staff.staff s SET id_number = d.id_number, gender = d.gender, date_of_birth = d.date_of_birth,
            department = d.department, date_employed = d.date_employed, address = d.address,
            next_of_kin_name = d.next_of_kin_name, next_of_kin_relationship = d.next_of_kin_relationship,
            next_of_kin_phone = d.next_of_kin_phone, details_updated_at = d.updated_at, details_updated_by = d.updated_by
        FROM staff.staff_details d WHERE d.id = s.id;
        DROP TABLE staff.staff_details;
    END IF;
END $$;


-- Row level security with no policies: only the owner (the FEWA server's login, and you in pgAdmin as postgres)
-- can read or change the rows
ALTER TABLE staff.staff ENABLE ROW LEVEL SECURITY;
