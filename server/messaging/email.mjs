/* ---------- Emails sent by the server (EmailJS) and who may do what ---------- */
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CODE_MAX_ATTEMPTS, RESET_GRANT_MINUTES, clientIp, codeHash, createSession, endOtherSessions, endSession, forgetSessions, lower, newPasswordDetails, passwordAcceptable, passwordMatches, sameText } from '../auth/sessions.mjs';
import { root } from '../core/config.mjs';
import { pool } from '../core/connection.mjs';
import { ACADEMIC_RIGHTS, ACADEMIC_STORES, EXAM_STORES, SCHEDULE_STORES, T, loadConfig, recordFromRow } from '../core/database.mjs';
import { fileIdsIn } from '../files/stored-files.mjs';
import { getRecord, selectRecords } from '../stores/stores.mjs';

/* ---------- Emails: every email of the system is written and sent here, by the server (through EmailJS) ----------
   A page can only ask for one of the emails below; it never chooses the words or (except for the administrator's
   password link, to a known staff member) who gets it, so nobody can use the system to send emails of their own.
   EmailJS must allow this: Account > Security > "Allow EmailJS API for non-browser applications", and with "Use
   Private Key" on, nobody without that key can send through the account. The private key is kept in the database
   table private_settings.server_keys (read first), the EMAILJS_PRIVATE_KEY setting on Render (Environment), and
   as "emailjsPrivateKey" in this computer's db-config.json; it is never put in the code. */
export const PUBLIC_SITE = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://fewa-system.onrender.com').replace(/\/+$/, '');
const looksLikeEmail = text => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || '').trim());
const maskEmail = email => { const [name, domain] = String(email).split('@'); return name.slice(0, 2) + '•••@' + domain; };
async function emailSettings() {
    const text = await readFile(path.join(root, 'email-config.js'), 'utf8').catch(() => '');
    const pick = name => (text.match(new RegExp(`(?<![A-Za-z])${name}\\s*:\\s*'([^']*)'`)) || [])[1] || '';
    return { serviceId: pick('serviceId'), templateId: pick('templateId'), publicKey: pick('publicKey') };
}
// true when EmailJS accepted the email
async function emailPrivateKey() {
    // First the database's private table (database/7-private-settings.sql), then Render's setting, then db-config.json
    const saved = await pool.query(`SELECT value FROM private_settings.server_keys WHERE name = 'emailjs_private_key'`)
        .then(result => result.rows[0]?.value || '', () => '');
    if (saved) return saved;
    if (process.env.EMAILJS_PRIVATE_KEY) return process.env.EMAILJS_PRIVATE_KEY;
    return (await loadConfig().catch(() => ({}))).emailjsPrivateKey || '';
}
// The same email as HTML, with every web address a real, clickable link (the EmailJS template shows it with
// {{{message_html}}}; plain {{message}} still works, but then only some email apps make the links clickable)
function emailHtml(message) {
    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return String(message).split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])/).map((part, index) => index % 2
        ? `<a href="${escape(part)}" style="color:#31184d;font-weight:bold;text-decoration:underline">${escape(part)}</a>`
        : escape(part)).join('');
}
export async function sendSystemEmail(to, message) {
    const settings = await emailSettings();
    const privateKey = await emailPrivateKey();
    if (!settings.serviceId || !settings.templateId || !settings.publicKey || !looksLikeEmail(to)) return false;
    const organization = (await getRecord('settings', 'organization').catch(() => null)) || {};
    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: settings.serviceId, template_id: settings.templateId, user_id: settings.publicKey,
                ...(privateKey ? { accessToken: privateKey } : {}),
                template_params: {
                    college_name: organization.collegeName || 'FEWA Beauty & Fashion College',
                    login_time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' }),
                    to_email: String(to).trim(), message, message_html: emailHtml(message)
                }
            }),
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) console.log(new Date().toLocaleString(), 'Email not sent:', response.status, (await response.text()).slice(0, 200));
        return response.ok;
    } catch (err) {
        console.log(new Date().toLocaleString(), 'Email not sent:', err.message);
        return false;
    }
}
/* Password reset codes. A code is kept (as a hash) under the staff member's email, or "student:<id>" for a
   student. Made by an administrator's page (Staff Management > Send Reset Link, a new staff member's welcome
   email), or by the server when someone presses "Forgot your password?" on the login page (then the server
   emails it, so nobody but the owner of that email sees it). Checking a code lets that person choose a new
   password within 10 minutes. */
const RESET_REQUEST_MINUTES = 15;
// At most 3 reset emails per username, and 10 requests from one connection, every 15 minutes
const resetRequests = new Map(); // key -> [times]
export function resetRequestAllowed(req, username) {
    const now = Date.now();
    const recent = key => (resetRequests.get(key) || []).filter(t => now - t < 15 * 60000);
    const byName = 'u:' + lower(username);
    const byIp = 'ip:' + clientIp(req);
    if (recent(byName).length >= 3 || recent(byIp).length >= 10) return false;
    resetRequests.set(byName, [...recent(byName), now]);
    resetRequests.set(byIp, [...recent(byIp), now]);
    if (resetRequests.size > 5000) resetRequests.clear();
    return true;
}
async function createResetCode({ email, minutes } = {}) {
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const salt = String(Date.now());
    const data = { salt, hash: codeHash(code, salt), expires: Date.now() + Number(minutes || 15) * 60000, attempts: 0 };
    await pool.query(`INSERT INTO ${T('password_reset_codes')} (email, data) VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`, [lower(email), data]);
    return { code };
}
// Whose password a username resets: { key, email, name, kind } for an active staff member (by email) or
// student (by AdmNo, capital letters or not); null when there is none
async function resetTarget(username) {
    username = String(username || '').trim();
    if (!username) return null;
    if (looksLikeEmail(username)) {
        const { rows } = await pool.query(`SELECT * FROM ${T('staff')} WHERE lower(username) = $1`, [lower(username)]);
        const account = rows.length ? recordFromRow(rows[0]) : null;
        if (!account || account.status === 'Inactive') return null;
        return { kind: 'staff', key: lower(account.username), email: account.username,
            name: [account.firstName, account.lastName].filter(Boolean).join(' '), username: account.username };
    }
    let { rows } = await pool.query(`SELECT * FROM ${T('students')} WHERE adm_no = $1`, [username]);
    if (!rows.length) rows = (await pool.query(`SELECT * FROM ${T('students')} WHERE lower(adm_no) = $1`, [lower(username)])).rows;
    if (rows.length !== 1) return null;
    const student = recordFromRow(rows[0]);
    if (student.activeStudent === 'no') return null;
    return { kind: 'student', key: 'student:' + student.id, email: student.email || '', studentId: student.id,
        name: [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' '), username: student.admNo };
}
// "Forgot your password?" on the login page: emails a link and code to the owner of the username
export async function requestPasswordReset(req, { username } = {}) {
    const target = await resetTarget(username);
    if (!target) return { result: 'unknown' };
    if (!looksLikeEmail(target.email)) return { result: 'no-email' };
    const { code } = await createResetCode({ email: target.key, minutes: RESET_REQUEST_MINUTES });
    const link = `${PUBLIC_SITE}/login.html?reset=${code}&user=${encodeURIComponent(target.username)}`;
    const sent = await sendSystemEmail(target.email,
        `Hello ${target.name || target.username}, a password reset was requested for your FEWA system account ` +
        `(username ${target.username}). Your reset code is ${code}. Open this link to set a new password: ${link} ` +
        `The code and link expire in ${RESET_REQUEST_MINUTES} minutes. If you did not ask for this, ignore this email.`);
    if (!sent) {
        await pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [target.key]);
        return { result: 'failed' };
    }
    return { result: 'sent', to: maskEmail(target.email), minutes: RESET_REQUEST_MINUTES };
}
// An administrator's "Send Reset Link", and the first email to a new staff member
export async function sendStaffPasswordLink({ email, newStaff } = {}) {
    const target = await resetTarget(email);
    if (!target || target.kind !== 'staff') return { result: 'unknown' };
    const minutes = newStaff ? 24 * 60 : RESET_REQUEST_MINUTES;
    const { code } = await createResetCode({ email: target.key, minutes });
    const link = `${PUBLIC_SITE}/login.html?reset=${code}&user=${encodeURIComponent(target.username)}`;
    const expiry = minutes >= 60 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
    const sent = await sendSystemEmail(target.email, newStaff
        ? `Hello ${target.name}, a FEWA system staff account has been created for you. Your username is ${target.username}. ` +
          `To set your password, open this link: ${link} or enter the code ${code} on the login page ` +
          `under "Forgot password?". The link and code expire in ${expiry}.`
        : `A password reset was requested for your FEWA system account. Your reset code is ${code}. ` +
          `Open this link to set a new password: ${link} The code and link expire in ${expiry}. ` +
          'If you did not ask for this, ignore this email.');
    if (!sent) {
        await pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [target.key]);
        return { result: 'failed' };
    }
    return { result: 'sent' };
}
// A student's login details: the welcome email, or a Reset Password. Only goes to the email on their record, and
// only with the temporary password that is really set (so a page can't put anything else in the email).
export async function sendStudentLoginEmail({ studentId, kind, password } = {}) {
    const { rows } = await pool.query(`SELECT * FROM ${T('students')} WHERE id = $1`, [String(studentId)]);
    if (!rows.length) return { result: 'none' };
    const student = recordFromRow(rows[0]);
    if (!looksLikeEmail(student.email)) return { result: 'no-email' };
    if (typeof password !== 'string' || !student.loginHash || !student.mustChangePassword || !await passwordMatches(password, student.loginSalt, student.loginHash)) {
        return { result: 'not-reset' };
    }
    const name = [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ');
    const college = ((await getRecord('settings', 'organization').catch(() => null)) || {}).collegeName || 'FEWA Beauty & Fashion College';
    const link = PUBLIC_SITE + '/student';
    const sent = await sendSystemEmail(student.email, kind === 'welcome'
        ? `Dear ${name}, welcome to ${college}! You have been admitted${student.admissionCourse ? ` to ${student.admissionCourse}` : ''}. ` +
          `Your admission number (AdmNo) is ${student.admNo}. You can log in to the Student Portal at ${link} ` +
          `with your AdmNo ${student.admNo} and the temporary password ${password}. ` +
          'You will be asked to choose your own password the first time you log in. We look forward to seeing you.'
        : `Hello ${name}, your FEWA student portal password has been reset. Log in at ${link} with your AdmNo ${student.admNo} ` +
          `and the temporary password ${password}. You will be asked to choose your own password when you log in.`);
    return { result: sent ? 'sent' : 'failed' };
}
// The note to the first administrator that their account was created (ordinary logins send no email)
export async function sendNewAdminEmail(account) {
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' });
    return sendSystemEmail(account.username, `Your FEWA system administrator account was created and you logged in successfully on ${when}.`);
}
export async function verifyResetCodeOnServer(req, res, { email, code } = {}) {
    const target = await resetTarget(email);
    if (!target) return { result: 'none' };
    const key = target.key;
    const { rows } = await pool.query(`SELECT data FROM ${T('password_reset_codes')} WHERE email = $1`, [key]);
    if (!rows.length) return { result: 'none' };
    const saved = rows[0].data;
    const remove = () => pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [key]);
    if (Date.now() > saved.expires) {
        await remove();
        return { result: 'expired' };
    }
    if (sameText(saved.hash, codeHash(String(code || '').trim(), saved.salt))) {
        await remove();
        await createSession(req, res, 'reset', key, RESET_GRANT_MINUTES);
        return { result: 'ok', username: target.username };
    }
    saved.attempts = (saved.attempts || 0) + 1;
    if (saved.attempts >= CODE_MAX_ATTEMPTS) {
        await remove();
        return { result: 'none' };
    }
    await pool.query(`UPDATE ${T('password_reset_codes')} SET data = $1 WHERE email = $2`, [saved, key]);
    return { result: 'wrong' };
}
// The new password, for the staff member (email) or student ("student:<id>") whose code was accepted
export async function completeResetOnServer(req, res, session, { password } = {}) {
    if (session.kind !== 'reset') return { result: 'expired' };
    if (!passwordAcceptable(password)) return { result: 'weak' };
    const { salt, hash } = await newPasswordDetails(password);
    const studentId = session.email.startsWith('student:') ? session.email.slice('student:'.length) : null;
    const updated = studentId
        ? await pool.query(`UPDATE ${T('students')} SET login_salt = $1, login_hash = $2, must_change_password = false,
            admin_reset_required = false, password_set_at = now(), updated_at = now() WHERE id = $3`, [salt, hash, studentId])
        : await pool.query(`UPDATE ${T('staff')} SET salt = $1, hash = $2, admin_reset_required = false
            WHERE lower(username) = $3 RETURNING id`, [salt, hash, session.email]);
    await endSession(req, res, session);
    if (studentId) await endOtherSessions('student', studentId);
    else if (updated.rows.length) await endOtherSessions('staff', updated.rows[0].id);
    forgetSessions();
    return { result: updated.rowCount ? 'ok' : 'expired', table: studentId ? 'students' : 'staff' };
}
// What the pages may see of the staff accounts: without password details (hash: true when a password is set),
// except in first-time setup
export function accountsForSession(text, full) {
    if (full || !text) return text;
    return JSON.stringify(JSON.parse(text).map(({ salt, hash, ...account }) => ({ ...account, hash: hash ? true : null })));
}
// Saving the accounts list: the password details are always the database's, so a page that was open for a while
// can't bring an old password back. Only deactivating an account (hash null, adminResetRequired) cancels one, and
// only first-time setup may bring its own.
export async function keepPasswords(text, setup) {
    if (text == null || setup) return text;
    const accounts = JSON.parse(text);
    const { rows } = await pool.query(`SELECT id, salt, hash, admin_reset_required, must_change_password FROM ${T('staff')}`);
    const saved = new Map(rows.map(r => [r.id, r]));
    return JSON.stringify(accounts.map(a => {
        if (!a) return a;
        if (a.hash === null && a.adminResetRequired === true && a.status === 'Inactive') return { ...a, salt: null };
        const row = saved.get(String(a.id));
        return { ...a, salt: row ? row.salt : null, hash: row ? row.hash : null, adminResetRequired: row ? row.admin_reset_required : a.adminResetRequired ?? null,
            mustChangePassword: row ? row.must_change_password : null };
    }));
}
// Student records going out: never the password details (loginHash: true when a password is set)
export function hidePasswords(store, record) {
    if (store !== 'students' || !record || typeof record !== 'object') return record;
    if (Array.isArray(record)) return record.map(r => hidePasswords(store, r));
    const { loginHash, loginSalt, ...rest } = record;
    return loginHash ? { ...rest, loginHash: true } : rest;
}
// A student record coming in: the login details stay the database's (a page open for a while can't bring an old
// password back). Only making a student inactive (loginHash null, adminResetRequired) cancels their password.
export async function keepStudentLogin(record) {
    if (!record || typeof record !== 'object') return record;
    if (record.loginHash === null && record.adminResetRequired === true) return { ...record, loginSalt: null };
    const { rows } = await pool.query(`SELECT login_hash, login_salt, must_change_password, admin_reset_required, password_set_at
        FROM ${T('students')} WHERE id = $1`, [String(record.id)]);
    if (!rows.length) return { ...record, loginHash: null, loginSalt: null };
    const before = recordFromRow(rows[0]);
    return { ...record, loginHash: before.loginHash ?? null, loginSalt: before.loginSalt ?? null, mustChangePassword: before.mustChangePassword ?? null,
        adminResetRequired: before.adminResetRequired ?? null, passwordSetAt: before.passwordSetAt ?? null };
}
/* What a staff member may change is checked here too, the same as can() in auth.js shows it on the screen:
   administrators everything; a role never set up in Role Operations everything; otherwise the rights it was given. */
export async function staffCan(session, ...rights) {
    if (session.admin) return true;
    const { rows } = await pool.query(`SELECT rights FROM ${T('role_operations')} WHERE role = $1`, [session.account.jobTitle || '']);
    if (!rows.length || !rows[0].rights) return true;
    const saved = rows[0].rights;
    const assigned = Array.isArray(saved.assigned) ? saved.assigned
        : Object.entries(saved).flatMap(([part, ops]) => Array.isArray(ops) ? ops.map(op => `${part}.${op}`) : []);
    // A role saved before an operation existed has it if it had the right that used to cover it (as in auth.js)
    const known = Array.isArray(saved.known) ? saved.known : [];
    return rights.some(right => assigned.includes(right)
        || (RIGHT_FROM[right] && !known.includes(right) && assigned.includes(RIGHT_FROM[right])));
}
// Operations added later and the right that covered them before (ROLE_OPERATIONS in auth.js)
const RIGHT_FROM = {
    'queries.view': 'students.view', 'reports.excel': 'reports.view', 'students.applications': 'students.edit',
    'students.status': 'students.edit', 'students.deferrals': 'students.edit', 'students.contacts': 'students.edit',
    'students.password': 'students.edit', 'finance.void': 'finance.edit', 
    'reports.standard': 'reports.view', 'reports.performance': 'reports.view',
    'reports.students': 'reports.view', 'reports.finance': 'reports.view',
    'schedule.view': 'academics.view', 'schedule.edit': 'academics.edit', 'exams.view': 'academics.view', 'exams.edit': 'academics.edit',
    'settings.school': 'settings.edit'
};
// The rights to open groups of reports (each report is built from the student records)
const REPORT_READERS = ['reports.view', 'reports.excel', 'reports.standard', 'reports.performance', 'reports.students', 'reports.finance'];
/* The rights that allow reading a kind of record (any one of them is enough). They include the work that needs the
   records behind the scenes: adding a student checks for duplicates, deleting one removes their documents, and
   renaming a course in Settings renames it on the students who have it. Settings can be read by all staff. */
const STUDENT_WRITERS = ['students.edit', 'students.applications', 'students.status', 'students.deferrals', 'students.contacts',
    'students.password', 'students.photos'];
const STUDENT_READERS = ['students.view', 'students.add', 'students.edit', 'students.delete', 'documents.view', 'documents.add',
    'finance.view', 'finance.add', ...REPORT_READERS, 'queries.view', 'settings.edit', 'settings.delete', ...STUDENT_WRITERS,
    ...ACADEMIC_RIGHTS];
export const RIGHTS_TO_READ = {
    students: STUDENT_READERS,
    deferrals: STUDENT_READERS,
    documents: ['documents.view', 'documents.add', 'students.delete', 'reports.view', 'reports.standard', 'reports.students', 'settings.edit', 'settings.delete'],
    applications: ['students.view', 'students.add', 'students.edit', 'students.applications'],
    // Academic Management > Manage Units
    ...Object.fromEntries(ACADEMIC_STORES.map(store => [store, ACADEMIC_RIGHTS])),
    // Programme units are set up in Settings > Program Setup (settings can be read by all staff)
    programme_units: [...ACADEMIC_RIGHTS, 'settings.view', 'settings.add', 'settings.edit', 'settings.delete'],
    units: [...ACADEMIC_RIGHTS, 'settings.view', 'settings.add', 'settings.edit', 'settings.delete'],
    // Reports > Student Reports > Students Attendance reads the Roll Call registers
    attendance_registers: [...ACADEMIC_RIGHTS, ...REPORT_READERS],
    // Finance lists the semesters of the Semester Schedule (fees, charges and payments are per semester)
    period_schedules: [...ACADEMIC_RIGHTS, 'finance.view', 'finance.add', 'finance.edit', 'finance.void']
};
// A stored file: someone who may read documents may open any; someone who may only read student records, not an
// uploaded document (a student's photo is fine)
export async function staffMayOpenFile(session, fileId) {
    if (await staffCan(session, ...RIGHTS_TO_READ.documents)) return true;
    if (!await staffCan(session, ...STUDENT_READERS)) return false;
    return !fileIdsIn(await selectRecords(pool, 'documents')).has(fileId);
}
// The rights that allow saving or deleting one record (any one of them is enough)
export async function rightsToWrite(store, id, method) {
    // Manage Units: registering students is its own right; the rest (units, programme units, offers) is editing
    if (store === 'programme_units') return ['academics.edit', 'settings.edit', method === 'DELETE' ? 'settings.delete' : 'settings.add'];
    if (SCHEDULE_STORES.includes(store)) return ['schedule.edit'];
    // Roll Call Management: taking (and correcting or removing) a register
    if (store === 'attendance_registers') return ['attendance.mark'];
    if (EXAM_STORES.includes(store)) return ['exams.edit'];
    if (ACADEMIC_STORES.includes(store)) return store === 'unit_registrations' ? ['academics.register'] : ['academics.edit'];
    if (method === 'DELETE') return store === 'settings' ? ['settings.delete'] : ['students.delete'];
    if (store === 'students') {
        const { rowCount } = await pool.query(`SELECT 1 FROM ${T('students')} WHERE id = $1`, [id]);
        // (renaming a course in Settings also renames it on the students who have it)
        return rowCount ? [...STUDENT_WRITERS, 'settings.edit'] : ['students.add'];
    }
    if (store === 'documents') return ['documents.add', 'students.add', 'settings.edit']; // (admitting an applicant files their documents)
    if (store === 'deferrals') return ['students.edit', 'students.deferrals'];
    if (store === 'applications') return ['students.edit', 'students.add', 'students.applications'];
    return id === 'paymentDetails' ? ['finance.edit', 'settings.edit'] : ['settings.add', 'settings.edit', 'settings.delete'];
}
// File ids a student may open: those in their own record and their own documents
export async function studentFileIds(studentId) {
    const own = await selectRecords(pool, 'students', studentId);
    const docs = (await selectRecords(pool, 'documents')).filter(d => d.studentId === studentId);
    return fileIdsIn([...own, ...docs]);
}
export const forbidden = () => Object.assign(new Error('You are not allowed to do this. Please log in again.'), { status: 403 });
