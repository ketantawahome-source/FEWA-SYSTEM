-- =====================================================================================================
-- FEWA system - schema "academics": units, programme units, units on offer, unit lecturers and student unit registrations
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Used by Academic Management > Manage Units (Academics.html). Fields without a column of their own are kept
-- in "extra", so nothing is ever lost. Copied to the office database and kept in backups like the other tables.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS academics;
COMMENT ON SCHEMA academics IS 'FEWA system: units, programme units, units on offer and student unit registrations';


-- ---------- Units register: every unit the college teaches (Manage Units > Units register) ----------
CREATE TABLE IF NOT EXISTS academics.units (
    id            text PRIMARY KEY,
    code          text,                   -- unit code, e.g. HBT 101 (unique, as typed)
    title         text,                   -- the title as it prints on transcripts
    credit_hours  numeric,
    created_at    timestamptz,
    extra         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS units_code ON academics.units (lower(code));


-- ---------- Programme units: the units of each course, by year and semester (Manage Units > Programme units) ----------
CREATE TABLE IF NOT EXISTS academics.programme_units (
    id             text PRIMARY KEY,
    course         text,                  -- the course as named in Settings > Program Setup > Courses
    unit_code      text,                  -- academics.units.code
    year_of_study  integer,
    semester       integer,
    unit_type      text,                  -- Core or Elective
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS programme_units_course ON academics.programme_units (course);


-- ---------- Units on offer: the units taught in a term, and their lecturer (Units on offer, Lecturer units) ----------
CREATE TABLE IF NOT EXISTS academics.unit_offers (
    id             text PRIMARY KEY,
    term           text,                  -- the academic term as named in Settings > Organisation Setup > Academic Terms
    unit_code      text,                  -- academics.units.code
    course         text,                  -- the course it is offered to (empty: any course)
    lecturer       text,                  -- the lecturer's login (staff email); empty until assigned
    lecturer_name  text,
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS unit_offers_term ON academics.unit_offers (term);


-- ---------- Student unit registrations: a student taking a unit in a term (Student unit registration / upload) ----------
CREATE TABLE IF NOT EXISTS academics.unit_registrations (
    id             text PRIMARY KEY,
    student_id     text,                  -- students.students.id
    adm_no         text,
    term           text,
    unit_code      text,
    registered_at  timestamptz,
    registered_by  text,                  -- the staff login that registered it
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Added with Unit registration by student and the Excel upload (kept in "extra" before, moved into them by the server)
ALTER TABLE academics.unit_registrations ADD COLUMN IF NOT EXISTS exam_reason text;         -- First attempt, Retake, Supplementary, Special
ALTER TABLE academics.unit_registrations ADD COLUMN IF NOT EXISTS registration_class text;  -- the course the unit was registered under
ALTER TABLE academics.unit_registrations ADD COLUMN IF NOT EXISTS batch text;               -- the student's group (Student Groups)
ALTER TABLE academics.unit_registrations ADD COLUMN IF NOT EXISTS lecturer text;            -- the lecturer's staff code (login email)
ALTER TABLE academics.unit_registrations ADD COLUMN IF NOT EXISTS lecturer_name text;
CREATE INDEX IF NOT EXISTS unit_registrations_student ON academics.unit_registrations (student_id);
CREATE INDEX IF NOT EXISTS unit_registrations_term ON academics.unit_registrations (term);

-- ---------- Unit lecturer mapping: which lecturer teaches a unit to a batch in a period (Manage Units > Lecturer units) ----------
CREATE TABLE IF NOT EXISTS academics.unit_lecturers (
    id              text PRIMARY KEY,
    programme       text,                 -- the award type, e.g. Diploma (Settings > Program Setup > Award Types)
    course          text,                 -- the course as named in Settings > Program Setup > Courses
    unit_code       text,                 -- academics.units.code
    lecturer        text,                 -- the lecturer's login (staff email)
    lecturer_name   text,
    batch           text,                 -- the student group (Student Groups)
    term            text,                 -- the period (Academic Terms)
    group_category  text,                 -- the study session, e.g. Full Time (empty: all)
    allocated_at    timestamptz,
    allocated_by    text,                 -- the staff login that allocated it
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS unit_lecturers_term ON academics.unit_lecturers (term, batch);

-- Row level security with no policies: only the system (the owner) reads or changes these, never Supabase's web API
ALTER TABLE academics.unit_lecturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.programme_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.unit_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.unit_registrations ENABLE ROW LEVEL SECURITY;
