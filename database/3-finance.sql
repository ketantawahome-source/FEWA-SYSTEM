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

-- WHERE: open database/3-finance.sql and paste everything BELOW this line at the very END of the file.
-- Nothing to run by hand: the server creates these tables when it starts.

-- ---------- Fee structure: what each course costs, term by term ----------
CREATE TABLE IF NOT EXISTS finance.fee_structure (
    id          text PRIMARY KEY,
    course      text NOT NULL,              -- as saved on the student (students.admission_course)
    term        text NOT NULL,              -- an Academic Term name from Settings
    item        text NOT NULL,              -- e.g. Tuition, Registration, Exam Fee
    amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS fee_structure_once ON finance.fee_structure (lower(course), lower(term), lower(item));
COMMENT ON TABLE finance.fee_structure IS 'Manage Finance > Fee Structure: the fee items of a course in a term.';


-- ---------- Charges: what a student owes (from the fee structure, or added by hand). Negative = waiver / bursary ----------
CREATE TABLE IF NOT EXISTS finance.charges (
    id           text PRIMARY KEY,
    student_id   text NOT NULL,             -- students.students.id (no foreign key: restoring a backup replaces students)
    adm_no       text,
    term         text,
    description  text NOT NULL,
    amount       numeric(12,2) NOT NULL CHECK (amount <> 0),
    source       text NOT NULL DEFAULT 'manual',   -- structure or manual
    voided       boolean NOT NULL DEFAULT false,
    void_reason  text,
    voided_at    timestamptz,
    voided_by    text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   text
);
CREATE INDEX IF NOT EXISTS charges_student_id ON finance.charges (student_id);
-- A fee item is posted to a student once per term, however many times "Post fees" is pressed
CREATE UNIQUE INDEX IF NOT EXISTS charges_structure_once ON finance.charges (student_id, lower(term), lower(description))
    WHERE source = 'structure' AND NOT voided;
COMMENT ON TABLE finance.charges IS 'What students owe. Never deleted: a wrong charge is voided.';


-- ---------- Payments: money received, each with its own receipt number ----------
CREATE TABLE IF NOT EXISTS finance.payments (
    id            text PRIMARY KEY,
    receipt_no    text NOT NULL,            -- REC-00001, REC-00002, ... given by the server
    student_id    text NOT NULL,
    adm_no        text,                     -- kept as it was when the payment was received
    student_name  text,
    amount        numeric(12,2) NOT NULL CHECK (amount > 0),
    method        text NOT NULL,            -- MPESA, BANK, CASH or CHEQUE
    reference     text,                     -- M-Pesa code, bank slip or cheque number
    paid_on       date NOT NULL,
    term          text,
    note          text,
    voided        boolean NOT NULL DEFAULT false,
    void_reason   text,
    voided_at     timestamptz,
    voided_by     text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_no ON finance.payments (receipt_no);
CREATE INDEX IF NOT EXISTS payments_student_id ON finance.payments (student_id);
CREATE INDEX IF NOT EXISTS payments_paid_on ON finance.payments (paid_on);
-- The same M-Pesa code / bank slip cannot be recorded twice (unless the first was voided)
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference ON finance.payments (lower(reference))
    WHERE reference IS NOT NULL AND reference <> '' AND NOT voided;
COMMENT ON TABLE finance.payments IS 'Fee payments received. Never deleted: a wrong payment is voided with a reason.';


-- Row level security with no policies: only the owner can read or change the rows
ALTER TABLE finance.fee_structure ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payments ENABLE ROW LEVEL SECURITY;