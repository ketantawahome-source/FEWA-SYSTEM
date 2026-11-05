-- =====================================================================================================
-- FEWA system - schema "files": student photos and uploaded documents (the files themselves)
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Records point to a file with {"__file": "<id>", "type": ..., "name": ..., "size": ...} (e.g. the photo
-- column of students.students). Files no record uses any more are deleted by the system.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS files;
COMMENT ON SCHEMA files IS 'FEWA system: student photos and uploaded documents';


CREATE TABLE IF NOT EXISTS files.stored_files (
    id          text PRIMARY KEY,
    name        text,
    type        text,                       -- e.g. image/jpeg, application/pdf
    size        integer NOT NULL,           -- bytes
    content     bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE files.stored_files IS 'Student photos and uploaded documents. Records point to a file with {"__file": "<id>", ...}.';


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE files.stored_files ENABLE ROW LEVEL SECURITY;
