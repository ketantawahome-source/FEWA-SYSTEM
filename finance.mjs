/* ---------- FEWA system: Manage Finance ----------
   Fee structure, charges, payments, receipts, statements and balances. Everything is checked and calculated here on
   the server; the pages only ask. Money rows are never deleted: a mistake is reversed ("voided") with a reason, and
   every row records who made it and when. Receipt numbers (REC-00001, ...) are given by the server.

   API (all under /api/finance, staff unless noted; rights are the Role Operations rights, checked here too)
     GET    summary                          totals for the overview                      finance.view
     GET    find?q=                          students by AdmNo or name                    finance.view
     GET    payments?from&to&method&q        the payments register                        finance.view
     GET    balances?course=                 what each student owes / has paid            finance.view
     GET    student/:id                      one student's statement                      finance.view
     GET    my-statement                     the logged-in student's own statement        student
     POST   payment                          record a payment (receipt number given)      finance.add (up to the role's Auth Limit)
     POST   payment/:id/void                 reverse a payment, with a reason             finance.void
     POST   charge                           charge a student (negative = waiver)         finance.add (waiver: finance.edit)
     POST   charge/:id/void                  reverse a charge, with a reason              finance.void
     GET    fee-structure                    the fee items of every course and term       finance.view
     POST   fee-structure                    add a fee item                               finance.edit
     PUT    fee-structure/:id                change a fee item's name or amount           finance.edit
     DELETE fee-structure/:id                remove a fee item (charges already posted stay)  finance.edit
     POST   fee-structure-copy               copy a term's fee items to another term      finance.edit
     POST   post-fees                        charge the fee structure to the students     finance.add (preview: true only counts) */
import { randomBytes } from 'node:crypto';

let getPool, T, send, readBody, staffCan, mirrorChanged, SMALL_BODY_BYTES;

export function initFinance(from) {
    ({ getPool, T, send, readBody, staffCan, mirrorChanged, SMALL_BODY_BYTES } = from);
}

const METHODS = ['MPESA', 'BANK', 'CASH', 'CHEQUE'];
const NEEDS_REFERENCE = ['MPESA', 'BANK', 'CHEQUE']; // cash has no code
const MAX_AMOUNT = 10000000;
const READ = ['finance.view', 'finance.add', 'finance.edit'];

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const forbidden = () => problem('You are not allowed to do this. Please log in again.', 403);
const newId = prefix => prefix + '-' + Date.now().toString(36) + randomBytes(4).toString('hex');
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDate = text => /^\d{4}-\d{2}-\d{2}$/.test(text) && !isNaN(new Date(text));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); // YYYY-MM-DD in Kenya
const nameOf = s => [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');

function money(value) {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n)) throw problem('Enter a valid amount.');
    return round2(n);
}

function text(value, label, { max = 200, required = false } = {}) {
    const s = String(value ?? '').trim();
    if (required && !s) throw problem(`${label} is required.`);
    if (s.length > max) throw problem(`${label} is too long.`);
    return s;
}

async function need(session, ...rights) {
    if (session.kind !== 'staff' || !await staffCan(session, ...rights)) throw forbidden();
}

// The most one payment may be for, by this person's role (Role Operations > "Record Fee Payments" Auth Limit); null = no limit
async function authLimit(session) {
    if (session.admin) return null;
    const { rows } = await getPool().query(`SELECT rights FROM ${T('role_operations')} WHERE role = $1`, [session.account.jobTitle || '']);
    const limit = Number(rows[0] && rows[0].rights && rows[0].rights.limits && rows[0].rights.limits['finance.add']);
    return limit > 0 ? limit : null;
}

async function studentOf(db, id) {
    const { rows } = await db.query(`SELECT id, adm_no, first_name, middle_name, last_name, admission_course, active_student
        FROM ${T('students')} WHERE id = $1`, [String(id || '')]);
    if (!rows.length) throw problem('That student was not found.', 404);
    return rows[0];
}

/* ---------- Statements and balances ---------- */
async function statement(db, studentId, forStudent = false) {
    const student = await studentOf(db, studentId);
    // A student sees only what stands; staff also see what was reversed, and by whom
    const hide = forStudent ? ' AND NOT voided' : '';
    const [charges, payments] = await Promise.all([
        db.query(`SELECT id, term, description, amount::float8 AS amount, source, voided, void_reason AS "voidReason",
                created_at AS "createdAt", created_by AS "createdBy"
            FROM ${T('charges')} WHERE student_id = $1${hide} ORDER BY created_at, id`, [student.id]),
        db.query(`SELECT id, receipt_no AS "receiptNo", amount::float8 AS amount, method, reference, paid_on AS "paidOn", term, note,
                voided, void_reason AS "voidReason", created_at AS "createdAt", created_by AS "createdBy"
            FROM ${T('payments')} WHERE student_id = $1${hide} ORDER BY paid_on, created_at, id`, [student.id])]);
    const sum = list => round2(list.filter(r => !r.voided).reduce((total, r) => total + r.amount, 0));
    const charged = sum(charges.rows);
    const paid = sum(payments.rows);
    const strip = rows => forStudent ? rows.map(({ createdBy, voidReason, ...rest }) => rest) : rows;
    return {
        student: { id: student.id, admNo: student.adm_no, name: nameOf(student), course: student.admission_course },
        charges: strip(charges.rows), payments: strip(payments.rows),
        charged, paid, balance: round2(charged - paid) // positive: the student owes; negative: paid in advance
    };
}

// Every student who has a charge or a payment, with what they owe (most owing first)
async function balances(db, course) {
    const { rows } = await db.query(`SELECT s.id, s.adm_no AS "admNo", concat_ws(' ', s.first_name, s.middle_name, s.last_name) AS name,
            s.admission_course AS course, s.active_student AS "activeStudent",
            coalesce(c.charged, 0)::float8 AS charged, coalesce(p.paid, 0)::float8 AS paid,
            (coalesce(c.charged, 0) - coalesce(p.paid, 0))::float8 AS balance
        FROM ${T('students')} s
        LEFT JOIN (SELECT student_id, sum(amount) AS charged FROM ${T('charges')} WHERE NOT voided GROUP BY student_id) c ON c.student_id = s.id
        LEFT JOIN (SELECT student_id, sum(amount) AS paid FROM ${T('payments')} WHERE NOT voided GROUP BY student_id) p ON p.student_id = s.id
        WHERE (c.student_id IS NOT NULL OR p.student_id IS NOT NULL) AND ($1 = '' OR lower(s.admission_course) = lower($1))
        ORDER BY balance DESC, name LIMIT 5000`, [course]);
    return rows.map(r => ({ ...r, charged: round2(r.charged), paid: round2(r.paid), balance: round2(r.balance) }));
}

async function summary(db) {
    const now = today();
    const [totals, owing] = await Promise.all([
        db.query(`SELECT
                (SELECT coalesce(sum(amount), 0)::float8 FROM ${T('payments')} WHERE NOT voided) AS collected,
                (SELECT coalesce(sum(amount), 0)::float8 FROM ${T('charges')} WHERE NOT voided) AS charged,
                (SELECT coalesce(sum(amount), 0)::float8 FROM ${T('payments')} WHERE NOT voided AND paid_on = $1) AS today,
                (SELECT coalesce(sum(amount), 0)::float8 FROM ${T('payments')} WHERE NOT voided AND paid_on >= $2) AS month,
                (SELECT count(*)::int FROM ${T('payments')} WHERE NOT voided AND paid_on = $1) AS "receiptsToday"`, [now, now.slice(0, 8) + '01']),
        balances(db, '')]);
    const t = totals.rows[0];
    return {
        collected: round2(t.collected), charged: round2(t.charged), today: round2(t.today), month: round2(t.month),
        receiptsToday: t.receiptsToday,
        // What students owe: only the ones who owe (a student who paid in advance does not reduce it)
        outstanding: round2(owing.filter(b => b.balance > 0).reduce((total, b) => total + b.balance, 0)),
        owing: owing.filter(b => b.balance > 0).length
    };
}

/* ---------- Payments ---------- */
async function recordPayment(session, body) {
    const db = getPool();
    const amount = money(body.amount);
    if (amount <= 0) throw problem('The amount must be more than zero.');
    if (amount > MAX_AMOUNT) throw problem('That amount is too large. Check it and try again.');
    const limit = await authLimit(session);
    if (limit && amount > limit) {
        throw problem(`This amount is above your limit of KES ${limit.toLocaleString('en-US')}. Ask an administrator to record it.`, 403);
    }
    const method = text(body.method, 'The payment method').toUpperCase();
    if (!METHODS.includes(method)) throw problem('Choose how the payment was made.');
    const reference = text(body.reference, 'The reference', { max: 60 }).toUpperCase();
    if (NEEDS_REFERENCE.includes(method) && !reference) throw problem('Enter the transaction code / reference number.');
    const paidOn = String(body.paidOn || today());
    if (!isDate(paidOn)) throw problem('The payment date is not valid.');
    if (paidOn > today()) throw problem('The payment date cannot be in the future.');
    const term = text(body.term, 'The term', { max: 100 });
    const note = text(body.note, 'The note', { max: 300 });
    const student = await studentOf(db, body.studentId);

    for (let attempt = 0; ; attempt++) {
        // The next receipt number; two payments at the same moment collide on the unique number, and the second tries again
        const { rows: [{ n }] } = await db.query(`SELECT coalesce(max(substring(receipt_no FROM '^REC-([0-9]+)$')::int), 0) + 1 AS n FROM ${T('payments')}`);
        const receiptNo = 'REC-' + String(n).padStart(5, '0');
        try {
            const { rows } = await db.query(`INSERT INTO ${T('payments')} (id, receipt_no, student_id, adm_no, student_name, amount, method,
                    reference, paid_on, term, note, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING id, receipt_no AS "receiptNo", student_id AS "studentId", adm_no AS "admNo", student_name AS "studentName",
                    amount::float8 AS amount, method, reference, paid_on AS "paidOn", term, note, created_at AS "createdAt", created_by AS "createdBy"`,
                [newId('pay'), receiptNo, student.id, student.adm_no, nameOf(student), amount, method, reference || null, paidOn,
                    term || null, note || null, session.account.username]);
            return rows[0];
        } catch (err) {
            if (err.code !== '23505') throw err;
            if (err.constraint === 'payments_reference') throw problem(`A payment with the reference ${reference} was already recorded.`, 409);
            if (attempt >= 4) throw err;
        }
    }
}

async function paymentsRegister(query) {
    const where = ['true'];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', '$' + params.length)); };
    if (query.get('from')) {
        if (!isDate(query.get('from'))) throw problem('The From date is not valid.');
        add('paid_on >= ?', query.get('from'));
    }
    if (query.get('to')) {
        if (!isDate(query.get('to'))) throw problem('The To date is not valid.');
        add('paid_on <= ?', query.get('to'));
    }
    if (METHODS.includes(String(query.get('method')))) add('method = ?', query.get('method'));
    const q = String(query.get('q') || '').trim().toLowerCase();
    if (q) add(`position(? in lower(concat_ws(' ', adm_no, student_name, reference, receipt_no))) > 0`, q);
    if (query.get('voided') !== 'yes') where.push('NOT voided');
    const { rows } = await getPool().query(`SELECT id, receipt_no AS "receiptNo", student_id AS "studentId", adm_no AS "admNo",
            student_name AS "studentName", amount::float8 AS amount, method, reference, paid_on AS "paidOn", term, note,
            voided, void_reason AS "voidReason", created_at AS "createdAt", created_by AS "createdBy"
        FROM ${T('payments')} WHERE ${where.join(' AND ')} ORDER BY paid_on DESC, created_at DESC LIMIT 1000`, params);
    return rows;
}

// Reverses a payment or a charge (kept, marked, with who and why)
async function voidRow(session, table, id, reason) {
    reason = text(reason, 'The reason', { max: 300, required: true });
    if (reason.length < 3) throw problem('Give a reason for reversing it.');
    const { rowCount } = await getPool().query(`UPDATE ${T(table)} SET voided = true, void_reason = $2, voided_at = now(), voided_by = $3
        WHERE id = $1 AND NOT voided`, [id, reason, session.account.username]);
    if (!rowCount) throw problem('It was not found, or it was already reversed.', 404);
}

/* ---------- Charges and the fee structure ---------- */
async function addCharge(session, body) {
    const amount = money(body.amount);
    if (amount === 0) throw problem('The amount cannot be zero.');
    if (Math.abs(amount) > MAX_AMOUNT) throw problem('That amount is too large. Check it and try again.');
    // A waiver or bursary (a negative charge) is a decision for those who manage the fees
    if (amount < 0) await need(session, 'finance.edit');
    const student = await studentOf(getPool(), body.studentId);
    const description = text(body.description, 'The description', { required: true });
    const term = text(body.term, 'The term', { max: 100 });
    const { rows } = await getPool().query(`INSERT INTO ${T('charges')} (id, student_id, adm_no, term, description, amount, source, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7) RETURNING id`,
        [newId('chg'), student.id, student.adm_no, term || null, description, amount, session.account.username]);
    return { id: rows[0].id };
}

async function feeItemFields(body) {
    const amount = money(body.amount);
    if (amount < 0 || amount > MAX_AMOUNT) throw problem('Enter an amount between 0 and 10,000,000.');
    return { item: text(body.item, 'The fee item', { required: true, max: 100 }), amount };
}

async function addFeeItem(session, body) {
    const course = text(body.course, 'The course', { required: true, max: 200 });
    const term = text(body.term, 'The term', { required: true, max: 100 });
    const { item, amount } = await feeItemFields(body);
    try {
        await getPool().query(`INSERT INTO ${T('fee_structure')} (id, course, term, item, amount, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [newId('fee'), course, term, item, amount, session.account.username]);
    } catch (err) {
        if (err.code === '23505') throw problem(`${item} is already in the fee structure of ${course} for ${term}. Change its amount instead.`, 409);
        throw err;
    }
}

async function copyTerm(session, body) {
    const from = text(body.fromTerm, 'The term to copy from', { required: true, max: 100 });
    const to = text(body.toTerm, 'The term to copy to', { required: true, max: 100 });
    if (from.toLowerCase() === to.toLowerCase()) throw problem('Choose two different terms.');
    const { rowCount } = await getPool().query(`INSERT INTO ${T('fee_structure')} (id, course, term, item, amount, created_by)
        SELECT 'fee-' || gen_random_uuid()::text, course, $2, item, amount, $3 FROM ${T('fee_structure')} WHERE lower(term) = lower($1)
        ON CONFLICT DO NOTHING`, [from, to, session.account.username]);
    return { copied: rowCount };
}

// Charges the fee structure of a term to the active students of the courses (once each: pressing it again adds nothing).
// preview: true only counts, and changes nothing.
async function postFees(session, body) {
    const term = text(body.term, 'The term', { required: true, max: 100 });
    const course = text(body.course, 'The course', { max: 200 });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`INSERT INTO ${T('charges')} (id, student_id, adm_no, term, description, amount, source, created_by)
            SELECT 'chg-' || gen_random_uuid()::text, s.id, s.adm_no, f.term, f.item, f.amount, 'structure', $3
            FROM ${T('students')} s
            JOIN ${T('fee_structure')} f ON lower(f.course) = lower(s.admission_course) AND lower(f.term) = lower($1)
            WHERE coalesce(s.active_student, 'yes') <> 'no' AND ($2 = '' OR lower(s.admission_course) = lower($2))
            ON CONFLICT DO NOTHING
            RETURNING student_id, amount::float8 AS amount`, [term, course, session.account.username]);
        await client.query(body.preview ? 'ROLLBACK' : 'COMMIT');
        return {
            preview: !!body.preview, charges: rows.length, students: new Set(rows.map(r => r.student_id)).size,
            total: round2(rows.reduce((sum, r) => sum + r.amount, 0))
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/* ---------- The routes ---------- */
export async function handleFinanceRequest(req, res, session, [a, b, c]) {
    const method = req.method;
    const db = getPool();
    const query = new URL('http://x' + req.url).searchParams;
    const body = () => readBody(req, SMALL_BODY_BYTES).then(v => (v && typeof v === 'object' ? v : {}));
    const changed = tables => mirrorChanged(tables);

    // A student's own statement
    if (a === 'my-statement' && method === 'GET') {
        if (session.kind !== 'student') throw forbidden();
        return send(res, 200, await statement(db, session.studentId, true));
    }
    if (session.kind !== 'staff') throw forbidden();

    if (method === 'GET') {
        await need(session, ...READ);
        if (a === 'summary') return send(res, 200, await summary(db));
        if (a === 'find') {
            const q = String(query.get('q') || '').trim().toLowerCase();
            if (q.length < 2) return send(res, 200, []);
            const { rows } = await db.query(`SELECT id, adm_no AS "admNo", concat_ws(' ', first_name, middle_name, last_name) AS name,
                    admission_course AS course, active_student AS "activeStudent"
                FROM ${T('students')}
                WHERE position($1 in lower(concat_ws(' ', adm_no, first_name, middle_name, last_name))) > 0
                ORDER BY adm_no LIMIT 10`, [q]);
            return send(res, 200, rows);
        }
        if (a === 'payments') return send(res, 200, await paymentsRegister(query));
        if (a === 'balances') return send(res, 200, await balances(db, String(query.get('course') || '').trim()));
        if (a === 'student' && b) return send(res, 200, await statement(db, b));
        if (a === 'fee-structure') {
            const { rows } = await db.query(`SELECT id, course, term, item, amount::float8 AS amount FROM ${T('fee_structure')}
                ORDER BY course, term, created_at, id`);
            return send(res, 200, rows);
        }
    }

    if (method === 'POST' && a === 'payment' && !b) {
        await need(session, 'finance.add');
        const payment = await recordPayment(session, await body());
        changed(['payments']);
        return send(res, 200, payment);
    }
    if (method === 'POST' && a === 'payment' && b && c === 'void') {
        await need(session, 'finance.void');
        await voidRow(session, 'payments', b, (await body()).reason);
        changed(['payments']);
        return send(res, 200, { ok: true });
    }
    if (method === 'POST' && a === 'charge' && !b) {
        await need(session, 'finance.add');
        const result = await addCharge(session, await body());
        changed(['charges']);
        return send(res, 200, result);
    }
    if (method === 'POST' && a === 'charge' && b && c === 'void') {
        await need(session, 'finance.void');
        await voidRow(session, 'charges', b, (await body()).reason);
        changed(['charges']);
        return send(res, 200, { ok: true });
    }
    if (method === 'POST' && a === 'post-fees') {
        await need(session, 'finance.add');
        const input = await body();
        const result = await postFees(session, input);
        if (!input.preview) changed(['charges']);
        return send(res, 200, result);
    }
    if (a === 'fee-structure' || a === 'fee-structure-copy') {
        await need(session, 'finance.edit');
        if (method === 'POST' && a === 'fee-structure') await addFeeItem(session, await body());
        else if (method === 'POST' && a === 'fee-structure-copy') {
            const result = await copyTerm(session, await body());
            changed(['fee_structure']);
            return send(res, 200, result);
        } else if (method === 'PUT' && a === 'fee-structure' && b) {
            const { item, amount } = await feeItemFields(await body());
            try {
                const { rowCount } = await db.query(`UPDATE ${T('fee_structure')} SET item = $2, amount = $3 WHERE id = $1`, [b, item, amount]);
                if (!rowCount) throw problem('That fee item was not found.', 404);
            } catch (err) {
                if (err.code === '23505') throw problem(`${item} is already in this course and term.`, 409);
                throw err;
            }
        } else if (method === 'DELETE' && a === 'fee-structure' && b) {
            await db.query(`DELETE FROM ${T('fee_structure')} WHERE id = $1`, [b]);
        } else {
            return send(res, 404, { error: 'Unknown request' });
        }
        changed(['fee_structure']);
        return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Unknown request' });
}