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


-- =====================================================================================================
-- Manage Finance > Fee Setup (owner, 2026-11-28): the lists fees are built from. Record stores (one row per entry,
-- extra = fields without a column), edited on StudentAdmissions.html (fee-setup.js). Read: finance rights; change:
-- Edit Fee Setup (finance.setup).
-- =====================================================================================================
CREATE TABLE IF NOT EXISTS finance.fee_types (
    id                  text PRIMARY KEY,
    fee_name            text,               -- e.g. Tuition Fee
    applies_to          text,               -- a course; empty = all courses
    income_class        text,               -- Lists > Income class (empty = DEFAULT)
    account             text,               -- Lists > Income / liability account
    fee_type            text,               -- NORMAL FEES or OTHER CHARGES
    priority            numeric,            -- order a payment pays the fees off (1 first)
    consolidation_type  text,               -- another fee type it is shown under on statements
    optional_fee        text,               -- Y / N
    charge_once         text,               -- Y / N: charged once, on admission
    status              text,               -- ACTIVE / INACTIVE
    updated_at          timestamptz,
    updated_by          text,
    extra               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.vote_heads (
    id          text PRIMARY KEY,
    name        text,                       -- e.g. Tuition, Exams, Library
    code        text,
    fee_type    text,                       -- the fee type it belongs to
    priority    numeric,
    status      text,
    updated_at  timestamptz,
    updated_by  text,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.discount_types (
    id           text PRIMARY KEY,
    name         text,                      -- e.g. Sibling discount, Staff child, Bursary
    code         text,
    description  text,
    status       text,
    updated_at   timestamptz,
    updated_by   text,
    extra        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.discount_amounts (
    id             text PRIMARY KEY,
    discount_type  text,
    course         text,                    -- empty = all courses
    fee_type       text,                    -- empty = all fee types
    period         text,                    -- e.g. SEMESTER 1; empty = every semester
    calculated_as  text,                    -- PERCENT or AMOUNT
    value          numeric,
    updated_at     timestamptz,
    updated_by     text,
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.discounts_surcharges (
    id             text PRIMARY KEY,
    kind           text,                    -- DISCOUNT or SURCHARGE
    name           text,
    course         text,                    -- empty = all courses
    fee_type       text,                    -- empty = all fee types
    calculated_as  text,                    -- PERCENT or AMOUNT
    value          numeric,
    condition      text,                    -- when it applies, e.g. Paid in full before the semester starts
    status         text,
    updated_at     timestamptz,
    updated_by     text,
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.payment_methods (
    id               text PRIMARY KEY,
    name             text,                  -- e.g. M-Pesa, Bank Deposit, Cash, Cheque
    code             text,                  -- e.g. MPESA
    needs_reference  text,                  -- Y / N: a transaction code / slip number must be typed
    status           text,
    updated_at       timestamptz,
    updated_by       text,
    extra            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.school_payment_methods (
    id              text PRIMARY KEY,
    school          text,                   -- Settings > Schools
    payment_method  text,
    bank_account    text,                   -- Bank Accounts (account name and number)
    pay_number      text,                   -- Paybill / Till number
    account_format  text,                   -- what to type as the account, e.g. Student AdmNo
    status          text,
    updated_at      timestamptz,
    updated_by      text,
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.bank_accounts (
    id              text PRIMARY KEY,
    bank_name       text,
    branch          text,
    account_name    text,
    account_number  text,
    currency        text,                   -- e.g. KES
    school          text,                   -- empty = all schools
    status          text,
    updated_at      timestamptz,
    updated_by      text,
    extra           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance.finance_lists (
    id          text PRIMARY KEY,
    list_name   text,                       -- e.g. INCOME CLASS, INCOME / LIABILITY ACCOUNT
    item        text,
    updated_at  timestamptz,
    updated_by  text,
    extra       jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE finance.fee_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.vote_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.discount_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.discount_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.discounts_surcharges ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.school_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.finance_lists ENABLE ROW LEVEL SECURITY;

-- Fee Types options added later (owner, 2026-11-28); Y / N each
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS miscellaneous_fee text;
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS discount_eligible text;
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS refundable text;
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS charge_on_transfer text;          -- charged on an inter school transfer (ticked at first)
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS charge_once_year text;            -- once every year
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS charge_once_per_family text;      -- once per family (siblings pay once)
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS continuing_only text;             -- continuing students only (not new ones)
ALTER TABLE finance.fee_types ADD COLUMN IF NOT EXISTS bill_prospective text;            -- billed to applicants before admission

-- VoteHeads fields added later (owner, 2026-11-28)
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS parent text;                    -- the main votehead of a sub-votehead (empty = main)
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS billable_subs numeric;          -- how many sub-voteheads can be billed (empty = not limited)
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS show_on_fee_structure text;    -- Y / N (ticked at first)
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS show_on_invoices text;         -- Y / N (ticked at first)
ALTER TABLE finance.vote_heads ADD COLUMN IF NOT EXISTS extra_curricular text;         -- Y / N
