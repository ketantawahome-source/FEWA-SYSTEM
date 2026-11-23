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
-- Manage Units > Programme units maps units per batch (empty: every batch, as Settings > Programme Units adds them)
ALTER TABLE academics.programme_units ADD COLUMN IF NOT EXISTS batch text;  -- the student group (Student Groups)
COMMENT ON COLUMN academics.programme_units.unit_type IS 'Cluster group: Core or Elective';
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
-- Units on offer (unit projection) is per batch and group category (empty: every batch / all group categories)
ALTER TABLE academics.unit_offers ADD COLUMN IF NOT EXISTS batch text;           -- the student group (Student Groups)
ALTER TABLE academics.unit_offers ADD COLUMN IF NOT EXISTS group_category text;  -- the study session, e.g. Full Time
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
-- The programme picked on the tab is the course (Settings > Courses); its year and semester come from its Programme Units
ALTER TABLE academics.unit_lecturers ADD COLUMN IF NOT EXISTS year_of_study integer;
ALTER TABLE academics.unit_lecturers ADD COLUMN IF NOT EXISTS semester integer;
COMMENT ON COLUMN academics.unit_lecturers.programme IS 'the award of the course (Certificate, Diploma...)';
CREATE INDEX IF NOT EXISTS unit_lecturers_term ON academics.unit_lecturers (term, batch);

-- ---------- Unit hours: the theory and practical hours of a unit on a course (Manage Units > Unit hours) ----------
CREATE TABLE IF NOT EXISTS academics.unit_hours (
    id               text PRIMARY KEY,
    programme        text,                -- the award type (Settings > Program Setup > Award Types)
    course           text,                -- the course as named in Settings > Program Setup > Courses
    unit_code        text,                -- academics.units.code
    certificate      text,                -- e.g. Diploma
    year_of_study    integer,
    theory_hours     numeric,
    practical_hours  numeric,
    updated_at       timestamptz,
    updated_by       text,                -- the staff login that saved it
    extra            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS unit_hours_course ON academics.unit_hours (course);

-- Row level security with no policies: only the system (the owner) reads or changes these, never Supabase's web API
ALTER TABLE academics.unit_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.unit_lecturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.programme_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.unit_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.unit_registrations ENABLE ROW LEVEL SECURITY;

-- ---------- Semester schedule: the dates of each period of a batch (Academic Management > Semester Schedule) ----------
CREATE TABLE IF NOT EXISTS academics.period_schedules (
    id                   text PRIMARY KEY,
    programme            text,            -- the award type (Settings > Program Setup > Award Types)
    batch                text,            -- the student group (Student Groups)
    course               text,            -- the class: the course as named in Settings > Program Setup > Courses
    enrolment            text,            -- the intake (Settings > Enrollment Types), e.g. January 2027
    period               text,            -- e.g. SEMESTER 1
    period_number        integer,         -- 1 for SEMESTER 1, used for the order
    start_date           date,
    end_date             date,
    accounts_start_date  date,            -- empty: the same as the start date
    accounts_end_date    date,            -- empty: the same as the end date
    accounts_status      text,            -- OPEN or CLOSED (closed: no invoices, credit notes or receipts in the period)
    updated_at           timestamptz,
    updated_by           text,            -- the staff login that saved it
    extra                jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS period_schedules_batch ON academics.period_schedules (batch, course);
ALTER TABLE academics.period_schedules ENABLE ROW LEVEL SECURITY;


-- =====================================================================================================
-- Exam Management (Academic Management > Exam Management, Academics.html?page=exams, code in exams.js)
-- Course = Settings > Program Setup > Courses; Batch = Student Groups; Period = SEMESTER 1, 2... (Semester Schedule)
-- =====================================================================================================

-- ---------- Exam groups: the kinds of assessment, e.g. Continuous Assessment (CAT), End of Semester Exam ----------
CREATE TABLE IF NOT EXISTS academics.exam_groups (
    id           text PRIMARY KEY,
    name         text,                    -- e.g. Continuous Assessment
    code         text,                    -- e.g. CAT
    description  text,
    status       text,                    -- ACTIVE or INACTIVE
    updated_at   timestamptz,
    updated_by   text,
    extra        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Exam types: the exams of a course's batch in a period, with their weight and marks out of ----------
CREATE TABLE IF NOT EXISTS academics.exam_types (
    id           text PRIMARY KEY,
    course       text,                    -- "Apply to": empty = every course
    batch        text,                    -- empty = every batch
    exam_group   text,                    -- academics.exam_groups.name
    period       text,                    -- e.g. SEMESTER 1
    description  text,                    -- e.g. CAT 1
    exam_status  text,                    -- OPEN or CLOSED (closed: no more marks are entered)
    weight       numeric,                 -- out of 100
    out_of       numeric,                 -- the marks the exam is out of
    updated_at   timestamptz,
    updated_by   text,
    extra        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS exam_types_batch ON academics.exam_types (batch, period);

-- ---------- Grading system: the grade of a mark, e.g. 70-100 = A (Distinction), in a named grading ----------
CREATE TABLE IF NOT EXISTS academics.grading_systems (
    id            text PRIMARY KEY,
    grading_name  text,                   -- e.g. Diploma grading
    grade         text,                   -- e.g. A
    min_mark      numeric,
    max_mark      numeric,
    points        numeric,
    remark        text,                   -- e.g. Distinction
    updated_at    timestamptz,
    updated_by    text,
    extra         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Group exam types: the exams that make up an exam group, e.g. CAT 1, CAT 2, Assignment ----------
CREATE TABLE IF NOT EXISTS academics.group_exam_types (
    id           text PRIMARY KEY,
    exam_group   text,                    -- academics.exam_groups.name
    name         text,                    -- e.g. CAT 1
    code         text,
    out_of       numeric,
    weight       numeric,                 -- its share of the group, out of 100
    updated_at   timestamptz,
    updated_by   text,
    extra        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Awards setup: the classification of a final average per award, e.g. Diploma 70-100 = Distinction ----------
CREATE TABLE IF NOT EXISTS academics.award_setups (
    id              text PRIMARY KEY,
    award           text,                 -- Settings > Program Setup > Award Types
    classification  text,                 -- e.g. Distinction, Credit, Pass, Fail
    min_average     numeric,
    max_average     numeric,
    remark          text,
    updated_at      timestamptz,
    updated_by      text,
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Course exam groups: the exam groups of a course and their weight in the final mark ----------
CREATE TABLE IF NOT EXISTS academics.course_exam_groups (
    id            text PRIMARY KEY,
    course        text,                   -- Settings > Program Setup > Courses
    exam_group    text,                   -- academics.exam_groups.name
    weight        numeric,                -- out of 100
    grading_name  text,                   -- academics.grading_systems.grading_name
    updated_at    timestamptz,
    updated_by    text,
    extra         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Exam paper types: e.g. Theory, Practical, Oral, Project ----------
CREATE TABLE IF NOT EXISTS academics.exam_paper_types (
    id           text PRIMARY KEY,
    name         text,
    code         text,
    description  text,
    out_of       numeric,                 -- the usual marks out of
    updated_at   timestamptz,
    updated_by   text,
    extra        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Columns added after the tables were first made (each after its table exists)
-- Exam groups as on the Exam groups tab: group weight, Exam Out Of and Include on transcript (Y or N)
ALTER TABLE academics.exam_groups ADD COLUMN IF NOT EXISTS weight numeric;
ALTER TABLE academics.exam_groups ADD COLUMN IF NOT EXISTS out_of numeric;
ALTER TABLE academics.exam_groups ADD COLUMN IF NOT EXISTS on_transcript text;
-- Group exam types as on their tab: course, class (YEAR 1...), batch, period, exam type, weight, main exam (Y/N), unit
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS course text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS class_name text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS batch text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS period text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS exam_type text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS on_main_exam text;
ALTER TABLE academics.group_exam_types ADD COLUMN IF NOT EXISTS unit text;
-- Course exam groups as on their tab: also the mark out of and Include On Main Exam (Y or N)
ALTER TABLE academics.course_exam_groups ADD COLUMN IF NOT EXISTS out_of numeric;
ALTER TABLE academics.course_exam_groups ADD COLUMN IF NOT EXISTS on_main_exam text;
-- Awards setup as on its tab: the recommendation printed for a range of marks of a course
ALTER TABLE academics.award_setups ADD COLUMN IF NOT EXISTS course text;
ALTER TABLE academics.award_setups ADD COLUMN IF NOT EXISTS recommendation text;
ALTER TABLE academics.award_setups ADD COLUMN IF NOT EXISTS marks_from numeric;
ALTER TABLE academics.award_setups ADD COLUMN IF NOT EXISTS marks_to numeric;
-- Grading system per course (the Course box on the Grading system tab), with GPA range and qualification
ALTER TABLE academics.grading_systems ADD COLUMN IF NOT EXISTS course text;
ALTER TABLE academics.grading_systems ADD COLUMN IF NOT EXISTS gpa_from numeric;
ALTER TABLE academics.grading_systems ADD COLUMN IF NOT EXISTS gpa_to numeric;
ALTER TABLE academics.grading_systems ADD COLUMN IF NOT EXISTS qualification text;
-- Exam paper types as on its tab: Name, Position (the order listed in) and Code
ALTER TABLE academics.exam_paper_types ADD COLUMN IF NOT EXISTS position numeric;

ALTER TABLE academics.exam_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.exam_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.grading_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.group_exam_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.award_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.course_exam_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE academics.exam_paper_types ENABLE ROW LEVEL SECURITY;
