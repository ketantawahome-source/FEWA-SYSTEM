-- =====================================================================================================
-- FEWA system - schema "settings": everything under Settings (courses, campuses, terms, School Setup...)
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
--
-- settings.settings lists every list and form saved in Settings, and the table that holds it (stored_in).
-- A list (courses, campuses, terms...) has one row per item, in the order shown in the system (position:
-- 0 first). If a list has no row in settings.settings, the system shows its built-in starting items (e.g.
-- Full Time / Part Time); once it is saved, its table is used even if it is empty.
-- Adding an item in pgAdmin: give it a unique id (any text, e.g. c5) and fill in its columns.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS settings;
COMMENT ON SCHEMA settings IS 'FEWA system: Settings lists and forms';


CREATE TABLE IF NOT EXISTS settings.settings (
    key         text PRIMARY KEY,           -- the system's name for the list or form, e.g. courses
    data        jsonb,                      -- only for settings that have no table of their own
    updated_at  timestamptz NOT NULL DEFAULT now(),
    stored_in   text                        -- the table that holds it
);
ALTER TABLE settings.settings ALTER COLUMN data DROP NOT NULL;
ALTER TABLE settings.settings ADD COLUMN IF NOT EXISTS stored_in text;
COMMENT ON TABLE settings.settings IS 'Index of the Settings lists and forms, and the table each is kept in (stored_in). Leave as it is.';


-- ---------- Staff job titles and their rights (Settings > Access Management > Roles / Role Operations) ----------
-- Until Nov 2026 these two were in the "staff" schema; they are moved here once, with their rows.
DO $$ BEGIN
    IF to_regclass('staff.staff_roles') IS NOT NULL AND to_regclass('settings.staff_roles') IS NULL THEN
        ALTER TABLE staff.staff_roles SET SCHEMA settings;
    END IF;
    IF to_regclass('staff.role_operations') IS NOT NULL AND to_regclass('settings.role_operations') IS NULL THEN
        ALTER TABLE staff.role_operations SET SCHEMA settings;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS settings.staff_roles (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. Registrar; offered as staff.staff.job_title
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE settings.staff_roles IS 'Staff job titles (Settings > Access Management > Roles).';

CREATE TABLE IF NOT EXISTS settings.role_operations (
    role        text PRIMARY KEY,           -- a name from settings.staff_roles
    rights      jsonb NOT NULL              -- {"assigned": ["students.view", ...], "limits": {...}}
);
COMMENT ON TABLE settings.role_operations IS 'What each staff role may do (Settings > Access Management > Role Operations).';
ALTER TABLE settings.staff_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.role_operations ENABLE ROW LEVEL SECURITY;


-- ---------- Program Setup ----------
CREATE TABLE IF NOT EXISTS settings.schools (
    id          text PRIMARY KEY,
    name        text,
    code        text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Short Courses (Program Setup): the short courses of each school
CREATE TABLE IF NOT EXISTS settings.short_courses (
    id              text PRIMARY KEY,
    name            text,                   -- Short Course Name
    school          text,                   -- from settings.schools
    code            text,
    duration        integer,
    duration_type   text,                   -- WEEKS, MONTHS or DAYS
    position        integer NOT NULL DEFAULT 0,
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.courses (
    id                  text PRIMARY KEY,
    name                text,               -- shown in Admission Course; students.students.admission_course uses it
    institution         text,
    code                text,               -- starts the admission numbers, e.g. HD01 -> HD01/001/2026
    duration            integer,
    duration_type       text,               -- YEARS, MONTHS, WEEKS or DAYS
    institute           text,               -- a school name from settings.schools
    award               text,               -- Certificate, Diploma, Higher Diploma, Degree, Artisan, Short Course
    department          text,               -- a department name from settings.departments
    apply_exam_weight   text,               -- YES or NO
    enabled             text,               -- YES or NO (NO: kept on students, but not offered to new ones)
    use100_conversion   text,               -- YES or NO
    transcript_file     text,
    intake              text,               -- January, May or September
    position            integer NOT NULL DEFAULT 0,
    extra               jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON COLUMN settings.courses.code IS 'Starts the admission numbers of the course, e.g. HD01 -> HD01/001/2026';
COMMENT ON COLUMN settings.courses.enabled IS 'YES or NO';

CREATE TABLE IF NOT EXISTS settings.enrollment_types (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. January 2026
    start_date  date,
    status      text,                       -- Active or Inactive
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.study_sessions (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. Full Time
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);


-- ---------- Organisation Setup ----------
CREATE TABLE IF NOT EXISTS settings.school_setup (
    id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- a single row
    college_name    text,
    motto           text,
    registration_no text,                   -- Registration / TVETA No.
    kra_pin         text,
    year_founded    integer,
    principal       text,
    email           text,
    phone           text,
    website         text,
    address         text,
    postal_address  text,
    county          text,
    logo            text,                   -- the logo picture (data: address), printed on reports
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE settings.school_setup IS 'Settings > Organisation Setup > School Setup (one row).';

CREATE TABLE IF NOT EXISTS settings.campuses (
    id          text PRIMARY KEY,
    name        text,
    location    text,
    phone       text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.academic_terms (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. Term 1 2027
    start_date  date,
    end_date    date,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.departments (
    id          text PRIMARY KEY,
    name        text,
    head        text,                       -- Head of Department
    phone       text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);


-- ---------- Institution Setup ----------
CREATE TABLE IF NOT EXISTS settings.student_types (
    id          text PRIMARY KEY,
    name        text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.student_groups (
    id          text PRIMARY KEY,
    name        text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS settings.document_types (
    id          text PRIMARY KEY,
    name        text,
    position    integer NOT NULL DEFAULT 0,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Registration Number Sequences (Program Setup): the last registration number issued; courses that pick the same
-- sequence (settings.courses.reg_sequence) share its numbering, and the next student gets last_number + 1
CREATE TABLE IF NOT EXISTS settings.reg_number_sequences (
    id              text PRIMARY KEY,
    name            text,                   -- Sequence Name
    last_number     integer,                -- Last number issued
    position        integer NOT NULL DEFAULT 0,
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE settings.courses ADD COLUMN IF NOT EXISTS reg_sequence text;   -- from settings.reg_number_sequences
ALTER TABLE settings.courses ADD COLUMN IF NOT EXISTS short_course text;   -- from settings.short_courses, when the award is Short Course


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE settings.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.enrollment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.school_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.campuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.academic_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.student_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.student_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.reg_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings.short_courses ENABLE ROW LEVEL SECURITY;


-- ---------- System updates (Settings > System Update): one row each time the rocket is run ----------
CREATE TABLE IF NOT EXISTS settings.system_updates (
    id            text PRIMARY KEY,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    started_by    text,                     -- the administrator who pressed Update
    place         text,                     -- office computer or online
    from_version  text,                     -- the GitHub commit before the update
    to_version    text,                     -- the GitHub commit after it
    changes       integer,                  -- how many new changes (commits) came in
    databases     integer,                  -- how many databases had their tables updated
    status        text,                     -- Running, Done, Up to date or Failed
    log           text                      -- every step, as shown on the page
);
ALTER TABLE settings.system_updates ENABLE ROW LEVEL SECURITY;
