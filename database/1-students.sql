-- =====================================================================================================
-- FEWA system - schema "students": students, their documents and deferrals
-- =====================================================================================================
-- server.mjs runs every file in this folder (1-students.sql, 2-settings.sql, ...) each time it starts, so the
-- tables are always there. Safe to run more than once. Can also be run by hand in pgAdmin: right-click the
-- database > Query Tool > open the file > Execute (F5).
--
-- Editing in pgAdmin: Schemas > students > Tables > right-click a table > View/Edit Data > All Rows,
-- change a cell, then Save Data (F6). The system shows the change the next time a page is opened.
--
-- Columns and the system's fields: first_name is the field firstName, adm_no is admNo, and so on. A column
-- added in pgAdmin (e.g. ALTER TABLE students.students ADD COLUMN nhif_no text;) becomes the field nhifNo of
-- every student. Fields without a column of their own are kept in "extra", so nothing is ever lost.
-- Dates are YYYY-MM-DD; …_at columns hold the moment something happened.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS students;
COMMENT ON SCHEMA students IS 'FEWA system: students, their documents and deferrals';


-- ---------- Students: one row per student (Student Hub > Add / Edit Student) ----------
CREATE TABLE IF NOT EXISTS students.students (
    id                      text PRIMARY KEY,
    adm_no                  text,           -- AdmNo / Reg. No., e.g. HD01/001/2026
    first_name              text,
    middle_name             text,
    last_name               text,
    gender                  text,           -- FEMALE or MALE
    dob                     date,           -- date of birth
    email                   text,
    id_birth_cert           text,           -- ID / Birth Certificate No.
    phone                   text,           -- saved as +254XXXXXXXXX
    postal_address          text,
    nationality             text,
    passport_no             text,
    specialization          text,
    photo                   jsonb,          -- the student's photo, in files.stored_files

    father_first_name       text,
    father_last_name        text,
    father_phone            text,
    father_email            text,
    father_occupation       text,
    mother_first_name       text,
    mother_last_name        text,
    mother_phone            text,
    mother_email            text,
    mother_occupation       text,
    guardian_first_name     text,
    guardian_last_name      text,
    guardian_phone          text,
    guardian_email          text,
    guardian_occupation     text,

    emergency_name          text,
    emergency_relationship  text,
    emergency_phone         text,
    emergency_alt_phone     text,
    emergency_email         text,
    emergency_address       text,

    campus                  text,
    admission_course        text,           -- a course name from settings.courses
    study_session           text,
    enrollment              text,
    student_type            text,
    "group"                 text,

    active_student          text,           -- yes or no
    exit_date               date,
    exit_reason             text,
    status_recorded_at      timestamptz,    -- when Active Student was last set

    login_hash              text,           -- Student Portal password (hash only)
    login_salt              text,
    must_change_password    boolean,
    admin_reset_required    boolean,
    password_set_at         timestamptz,

    created_at              timestamptz,    -- when the student was admitted in the system
    updated_at              timestamptz,
    extra                   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS students_adm_no ON students.students (adm_no);
CREATE INDEX IF NOT EXISTS students_admission_course ON students.students (admission_course);
COMMENT ON TABLE students.students IS 'One row per student. Edit cells in pgAdmin; the system shows changes on the next page load.';
COMMENT ON COLUMN students.students.active_student IS 'yes = active student, no = left / deferred / suspended';
COMMENT ON COLUMN students.students.gender IS 'FEMALE or MALE';
COMMENT ON COLUMN students.students.admission_course IS 'Must match a course name in settings.courses';
COMMENT ON COLUMN students.students.extra IS 'Any other fields of the student record (e.g. from older versions); kept as they are';


-- ---------- Student documents (Student Documents page); the file itself is in files.stored_files ----------
CREATE TABLE IF NOT EXISTS students.documents (
    id          text PRIMARY KEY,
    student_id  text,                       -- students.students.id
    doc_type    text,                       -- a name from settings.document_types
    description text,
    file_name   text,
    file_type   text,
    size        integer,                    -- bytes
    file        jsonb,                      -- the file, in files.stored_files
    uploaded_at timestamptz,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS documents_student_id ON students.documents (student_id);
COMMENT ON TABLE students.documents IS 'Documents uploaded for students. student_id is the id of the student in students.students.';


-- ---------- Deferred / suspended students (Student Hub > Deferred/Suspended Students) ----------
CREATE TABLE IF NOT EXISTS students.deferrals (
    id          text PRIMARY KEY,
    student_id  text,                       -- students.students.id
    type        text,                       -- Deferral or Suspension
    start_date  date,
    end_date    date,
    reason      text,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS deferrals_student_id ON students.deferrals (student_id);


-- ---------- Online applications (the public form apply.html; Student Hub > Online Applications) ----------
-- Filled in by prospects themselves. Staff then Admit (the details go into a new student record) or Reject.
CREATE TABLE IF NOT EXISTS students.applications (
    id                          text PRIMARY KEY,
    reference                   text,           -- the prospect number given to the applicant, e.g. PRP-00001
    status                      text,           -- Prospect, Verified, Admitted or Rejected
    submitted_at                timestamptz,

    school                      text,           -- from settings.schools
    class_applied               text,           -- a course name from settings.courses
    year_admitted               text,
    term                        text,           -- from settings.academic_terms
    intake                      text,           -- January, May, September

    first_name                  text,
    middle_name                 text,
    last_name                   text,           -- surname
    languages                   text,
    dob                         date,
    gender                      text,           -- FEMALE or MALE
    nationality                 text,
    country_of_residence        text,
    city_of_residence           text,
    id_birth_cert               text,           -- ID / Birth Certificate No.
    birth_certificate           jsonb,          -- copy of the birth certificate, in files.stored_files
    photo                       jsonb,          -- passport photo, in files.stored_files
    heard_about                 text,           -- how they heard about the college
    location                    text,           -- home area
    town                        text,
    phone                       text,
    email                       text,

    mother_first_name           text,
    mother_middle_name          text,
    mother_last_name            text,
    mother_phone                text,
    mother_phone2               text,
    mother_email                text,
    mother_id_type              text,           -- National ID or Passport
    mother_national_id          text,
    mother_nationality          text,
    mother_relationship         text,
    mother_id_copy              jsonb,          -- copy of the ID, in files.stored_files

    father_first_name           text,
    father_middle_name          text,
    father_last_name            text,
    father_phone                text,
    father_phone2               text,
    father_email                text,
    father_id_type              text,
    father_national_id          text,
    father_nationality          text,
    father_relationship         text,
    father_id_copy              jsonb,

    student_id                  text,           -- students.students.id once admitted
    reviewed_by                 text,           -- the staff member who admitted or rejected it
    reviewed_at                 timestamptz,
    review_note                 text,
    extra                       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS applications_status ON students.applications (status);
-- Each prospect number (e.g. PRP-00001) belongs to one applicant only
CREATE UNIQUE INDEX IF NOT EXISTS applications_reference ON students.applications (reference);
COMMENT ON TABLE students.applications IS 'Applications sent through the online application form (apply.html). Admitted ones point to their student in student_id.';


-- Row level security with no policies: only the owner (the FEWA server's login, and you in pgAdmin as postgres)
-- can read or change the rows.
ALTER TABLE students.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE students.deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE students.applications ENABLE ROW LEVEL SECURITY;
