-- =====================================================================================================
-- FEWA system - schema "finance": Manage Finance
-- =====================================================================================================
-- Run by server.mjs each time it starts (see 1-students.sql). Safe to run more than once.
-- Fee payments themselves are not recorded by the system yet; their tables will go in this schema.
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS finance;
COMMENT ON SCHEMA finance IS 'FEWA system: Manage Finance';


-- ---------- Manage Finance > Fee Payment Details: where fees are paid to ----------
CREATE TABLE IF NOT EXISTS finance.fee_payment_details (
    id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- a single row
    mpesa_paybill       text,               -- M-Pesa Paybill / Till No.
    mpesa_account       text,               -- M-Pesa Account No. to use, e.g. Student AdmNo
    bank_name           text,
    bank_branch         text,
    bank_account_name   text,
    bank_account_no     text,
    extra               jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE finance.fee_payment_details IS 'Manage Finance > Fee Payment Details (one row).';


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE finance.fee_payment_details ENABLE ROW LEVEL SECURITY;
