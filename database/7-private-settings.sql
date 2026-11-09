-- =====================================================================================================
-- FEWA system - schema "private_settings": keys only the server itself may read
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Deliberately NOT listed in server.mjs (SCHEMA_OF), so no web page, backup, zip download or office sync can
-- reach it. Holds the EmailJS private key (name 'emailjs_private_key').
-- If "Refresh Keys" is pressed on EmailJS, the new key must be saved in this table too.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS private_settings;
COMMENT ON SCHEMA private_settings IS 'FEWA system: keys only the server reads. Not in backups or the office copy.';

CREATE TABLE IF NOT EXISTS private_settings.server_keys (
    name        text PRIMARY KEY,
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE private_settings.server_keys ENABLE ROW LEVEL SECURITY;
