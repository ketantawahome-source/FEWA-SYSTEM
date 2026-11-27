/* ---------- Logins and sessions ---------- */
import { browserName, recordSignIn } from './sign-in-activity.mjs';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool, sessionsValidFrom } from '../core/connection.mjs';
import { T, recordFromRow } from '../core/database.mjs';
import { DEFAULT_CONTROLS, closedMessage, globalControls } from '../global-settings/global-settings.mjs';
import { PUBLIC_SITE, sendSystemEmail } from '../messaging/email.mjs';
import { sendWhatsAppTemplate, temporaryPassword } from '../messaging/whatsapp.mjs';
import { mirrorChanged } from '../sync/mirror.mjs';

/* ---------- Logins and sessions (checked here on the server, so the system is safe to put online) ----------
   A correct login gets a session: a random token in an HttpOnly cookie, kept (as a hash) in staff.sessions
   for 12 hours. Every data request is checked against it:
     administrators     everything
     other staff        the settings, and the student data their role (Role Operations) allows; not changing staff
                        accounts, role rights or reset codes
     students           only their own record, documents and deferrals (read), and their own password
     not logged in      only the School Setup (college name and logo, for the login page)
   First-time setup (no staff account yet: creating the first administrator, or restoring a backup) is only
   allowed from this computer itself, never over the internet.
   Passwords are stored with scrypt, which is slow on purpose so that a stolen list cannot be guessed quickly.
   Passwords set before Nov 2026 (and the very first administrator's, made by the login page) are SHA-256 of
   "salt:password"; they still work and are changed to scrypt the next time that person logs in.
   The password details (hash and salt) never leave the server, except in first-time setup. */
const SESSION_HOURS = 12;
export const RESET_GRANT_MINUTES = 10;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 15;
export const CODE_MAX_ATTEMPTS = 5;
export const sha256 = text => createHash('sha256').update(text).digest('hex');
// Emailed reset codes (and passwords from before scrypt): short-lived, and given only a few tries
export const codeHash = (code, salt) => sha256(`${salt}:${code}`);
const scryptAsync = promisify(scrypt);
const SCRYPT_PREFIX = 'scrypt1$';
const scryptHash = async (password, salt) => SCRYPT_PREFIX + (await scryptAsync(String(password), salt, 32, { N: 16384, r: 8, p: 1 })).toString('hex');
export async function newPasswordDetails(password) {
    const salt = randomBytes(16).toString('hex');
    return { salt, hash: await scryptHash(password, salt) };
}
export function sameText(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
}
const passwordIsOldKind = hash => !String(hash).startsWith(SCRYPT_PREFIX);
export const passwordMatches = async (password, salt, hash) =>
    sameText(hash, passwordIsOldKind(hash) ? codeHash(password, salt) : await scryptHash(password, salt));
// The pages ask for more (capital letters and so on); this also stops an empty password sent by other means
export const passwordAcceptable = password => typeof password === 'string' && password.length >= 8 && password.length <= 128;
// Someone's other logins end when their password changes (a stolen login must not outlive the new password)
export async function endOtherSessions(kind, subject, keepTokenHash = '') {
    await pool.query(`DELETE FROM ${T('sessions')} WHERE kind = $1 AND subject = $2 AND token_hash <> $3`, [kind, String(subject), keepTokenHash]);
    forgetSessions();
}
export const lower = text => String(text || '').trim().toLowerCase();
export function parseCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const i = part.indexOf('=');
        return i < 0 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }));
}
export const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
export const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// A request from this computer itself (not through the internet / a hosting proxy)
export const isLocalRequest = req => !req.headers['x-forwarded-for'] &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
/* Staff and students each have their own login cookie, so a staff member and a student can be logged in at the same
   time in the same browser. Each page says which one it uses (the X-FEWA-Portal header, db.js): the Student Portal
   'student', the staff pages 'staff', the login page 'login' (a password reset first, then staff, then student). */
const SESSION_COOKIES = { staff: 'fewa_staff', student: 'fewa_student', reset: 'fewa_reset' };
const PORTAL_KINDS = { staff: ['staff'], student: ['student'], login: ['reset', 'staff', 'student'] };
function setSessionCookie(req, res, kind, token, seconds) {
    const cookie = `${SESSION_COOKIES[kind]}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}` +
        (isHttps(req) ? '; Secure' : '');
    const earlier = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', earlier ? [].concat(earlier, cookie) : cookie);
}
export async function createSession(req, res, kind, subject, minutes) {
    const token = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO ${T('sessions')} (token_hash, kind, subject, expires_at, created_at)
        VALUES ($1, $2, $3, now() + make_interval(mins => $4), now())`, [sha256(token), kind, String(subject), minutes]);
    setSessionCookie(req, res, kind, token, minutes * 60);
    // Old sessions are cleared now and then
    if (Math.random() < 0.05) pool.query(`DELETE FROM ${T('sessions')} WHERE expires_at < now()`).catch(() => { });
}
// Sessions are looked up at most every 20 seconds per token (the database may be far away, e.g. Supabase)
const sessionCache = new Map();
const SESSION_CACHE_MS = 20000;
export const forgetSessions = () => sessionCache.clear();
// The session of the page asking (its portal), or of one kind ('staff', 'student', 'reset')
// { kind: 'staff', account, admin } | { kind: 'student', studentId } | { kind: 'reset', email } | { kind: null }
export async function getSession(req, onlyKind) {
    const portal = String(req.headers['x-fewa-portal'] || 'login');
    for (const kind of onlyKind ? [onlyKind] : PORTAL_KINDS[portal] || PORTAL_KINDS.login) {
        const session = await sessionOfKind(req, kind);
        if (session.kind) return session;
    }
    return { kind: null };
}
async function sessionOfKind(req, cookieKind) {
    const token = parseCookies(req)[SESSION_COOKIES[cookieKind]];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return { kind: null };
    const tokenHash = sha256(token);
    const cached = sessionCache.get(tokenHash);
    if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.session;
    let session = { kind: null };
    const { rows } = await pool.query(`SELECT kind, subject FROM ${T('sessions')} WHERE token_hash = $1 AND expires_at > now()
        AND ($2::timestamptz IS NULL OR created_at >= $2)`, [tokenHash, sessionsValidFrom]);
    // (a session only counts in its own cookie)
    if (rows.length && rows[0].kind === cookieKind) {
        const { kind, subject } = rows[0];
        if (kind === 'staff') {
            const found = await pool.query(`SELECT * FROM ${T('staff')} WHERE id = $1`, [subject]);
            const account = found.rows.length ? recordFromRow(found.rows[0]) : null;
            // A deleted or deactivated account loses its sessions straight away
            if (account && account.status !== 'Inactive') session = { kind, account, admin: account.role === 'Administrator' };
        } else if (kind === 'student') {
            const found = await pool.query(`SELECT active_student FROM ${T('students')} WHERE id = $1`, [subject]);
            if (found.rows.length && found.rows[0].active_student !== 'no') session = { kind, studentId: subject };
        } else if (kind === 'reset') {
            session = { kind, email: subject };
        }
    }
    // Global Settings: a closed system, or logins switched off, ends these sessions
    if (session.kind === 'staff' || session.kind === 'student') {
        const controls = await globalControls().catch(() => DEFAULT_CONTROLS);
        if (!controls.systemOpen || !controls[session.kind === 'staff' ? 'staffLogins' : 'studentLogins']) session = { kind: null };
    }
    session.tokenHash = tokenHash;
    session.cookieKind = cookieKind;
    sessionCache.set(tokenHash, { at: Date.now(), session });
    return session;
}
// Ends this one session (logging out of the staff pages leaves a student logged in, and the other way round)
export async function endSession(req, res, session) {
    if (session.tokenHash) await pool.query(`DELETE FROM ${T('sessions')} WHERE token_hash = $1`, [session.tokenHash]);
    sessionCache.delete(session.tokenHash);
    if (session.cookieKind) setSessionCookie(req, res, session.cookieKind, '', 0);
}
// No staff account yet: the system is being set up (counted at most every 10 seconds)
let accountCount = { at: 0, count: null };
export async function setupNeeded() {
    if (Date.now() - accountCount.at > 10000 || accountCount.count === null) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${T('staff')}`);
        accountCount = { at: Date.now(), count: rows[0].n };
    }
    return accountCount.count === 0;
}
export const forgetAccountCount = () => accountCount = { at: 0, count: null };
/* Too many wrong passwords for one username: locked for a while. Counted from one place, and also from everywhere
   together, because the address a request says it comes from can be faked. */
const loginFailures = new Map();
const LOGIN_MAX_FAILURES_EVERYWHERE = 50;
export function loginLocked(req, username) {
    const over = (key, limit) => {
        const entry = loginFailures.get(key);
        return !!entry && entry.count >= limit && Date.now() - entry.first < LOGIN_LOCK_MINUTES * 60000;
    };
    return over(clientIp(req) + '|' + lower(username), LOGIN_MAX_FAILURES) || over('everywhere|' + lower(username), LOGIN_MAX_FAILURES_EVERYWHERE);
}
export function loginFailed(req, username) {
    /* The list is kept small, but never by forgetting a username that is locked: clearing everything let someone
       who tried 20,000 made-up usernames wipe the lock on the account they were guessing. Old entries go first,
       then the ones far from a lock. */
    if (loginFailures.size > 20000) {
        const now = Date.now();
        for (const [key, entry] of loginFailures) if (now - entry.first > LOGIN_LOCK_MINUTES * 60000) loginFailures.delete(key);
        if (loginFailures.size > 20000) {
            for (const [key, entry] of loginFailures) {
                if (entry.count < Math.min(LOGIN_MAX_FAILURES, 3) && !key.startsWith('everywhere|')) loginFailures.delete(key);
                if (loginFailures.size <= 15000) break;
            }
        }
    }
    for (const key of [clientIp(req) + '|' + lower(username), 'everywhere|' + lower(username)]) {
        const entry = loginFailures.get(key);
        if (!entry || Date.now() - entry.first > LOGIN_LOCK_MINUTES * 60000) loginFailures.set(key, { count: 1, first: Date.now() });
        else entry.count++;
    }
}
// Staff log in with their email; students with their AdmNo (capital and small letters must match)
// Staff log in with their email, students with their AdmNo: the system knows which from the username
/* Every login attempt is kept for Settings > Access Management > Sign-in Activity (owner, 2026-11-27): the account
   typed, the result (an unknown email / AdmNo shows as "Not registered at this school"), browser and address. */
export async function login(req, res, body = {}) {
    const out = await checkLogin(req, res, body);
    const account = String((body && body.username) || '').trim();
    if (account) {
        let result = out.result, kind = out.kind || '';
        if (result !== 'ok' && !kind) {
            const staff = await pool.query(`SELECT 1 FROM ${T('staff')} WHERE lower(username) = $1`, [lower(account)]);
            const student = staff.rowCount ? null : await pool.query(`SELECT 1 FROM ${T('students')} WHERE lower(adm_no) = $1`, [lower(account)]);
            kind = staff.rowCount ? 'staff' : student.rowCount ? 'student' : '';
            if (result === 'wrong' && !kind) result = 'unknown';
        }
        if (result === 'ok' && !kind) kind = 'student';
        await recordSignIn({ account, kind, result, browser: browserName(req.headers['user-agent']), address: clientIp(req) });
    }
    return out;
}
async function checkLogin(req, res, { username, password } = {}) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) return { result: 'wrong' };
    if (loginLocked(req, username)) return { result: 'locked' };
    // Global Settings: the whole system closed, or this kind of login switched off
    const controls = await globalControls();
    if (!controls.systemOpen) return { result: 'closed', message: closedMessage(controls) };

    const staff = await pool.query(`SELECT * FROM ${T('staff')} WHERE lower(username) = $1`, [lower(username)]);
    if (staff.rows.length && !controls.staffLogins) return { result: 'staff-off' };
    if (staff.rows.length) {
        const account = recordFromRow(staff.rows[0]);
        let result = 'ok';
        if (account.status === 'Inactive') result = 'inactive';
        else if (!account.hash) result = account.adminResetRequired ? 'reset-required' : 'no-password';
        else if (!await passwordMatches(password, account.salt, account.hash)) result = 'wrong';
        if (result !== 'ok') {
            if (result === 'wrong') loginFailed(req, username);
            return { result };
        }
        loginFailures.delete(clientIp(req) + '|' + lower(username));
        if (passwordIsOldKind(account.hash)) {
            const { salt, hash } = await newPasswordDetails(password);
            await pool.query(`UPDATE ${T('staff')} SET salt = $1, hash = $2 WHERE id = $3`, [salt, hash, account.id]);
            mirrorChanged(['staff']);
        }
        await createSession(req, res, 'staff', account.id, SESSION_HOURS * 60);
        return { result, kind: 'staff', username: account.username };
    }

    const exact = await pool.query(`SELECT * FROM ${T('students')} WHERE adm_no = $1`, [username]);
    if (!exact.rows.length) {
        const anyCase = await pool.query(`SELECT 1 FROM ${T('students')} WHERE lower(adm_no) = $1`, [lower(username)]);
        loginFailed(req, username);
        return { result: anyCase.rows.length ? 'wrong-case' : 'wrong' };
    }
    if (!controls.studentLogins) return { result: 'student-off' };
    const student = recordFromRow(exact.rows[0]);
    let result = 'ok';
    if (student.activeStudent === 'no') result = 'inactive';
    else if (!student.loginHash) result = student.adminResetRequired ? 'reset-required' : 'no-password';
    else if (!await passwordMatches(password, student.loginSalt, student.loginHash)) result = 'wrong-password';
    if (result !== 'ok') {
        if (result === 'wrong-password') loginFailed(req, username);
        return { result };
    }
    loginFailures.delete(clientIp(req) + '|' + lower(username));
    if (passwordIsOldKind(student.loginHash)) {
        const { salt, hash } = await newPasswordDetails(password);
        await pool.query(`UPDATE ${T('students')} SET login_salt = $1, login_hash = $2 WHERE id = $3`, [salt, hash, student.id]);
        mirrorChanged(['students']);
    }
    await createSession(req, res, 'student', student.id, SESSION_HOURS * 60);
    return { result, kind: 'student', studentId: student.id, admNo: student.admNo };
}
// A staff member's own new password ('same': it is the current one)
export async function setOwnPassword(session, password) {
    const account = session.account;
    if (!passwordAcceptable(password)) return { result: 'weak' };
    if (account.hash && await passwordMatches(password, account.salt, account.hash)) return { result: 'same' };
    const { salt, hash } = await newPasswordDetails(password);
    await pool.query(`UPDATE ${T('staff')} SET salt = $1, hash = $2, admin_reset_required = false, must_change_password = false WHERE id = $3`,
        [salt, hash, account.id]);
    await endOtherSessions('staff', account.id, session.tokenHash);
    return { result: 'ok' };
}
/* Staff Management > Reset Password (administrators): a new temporary password, made here, set at once and shown to
   the administrator once (to read out or send on WhatsApp), and emailed to the staff member's username. They are
   logged out everywhere and must choose their own password when they next sign in (must_change_password). */
export async function resetStaffPasswordOnServer({ id } = {}) {
    const { rows } = await pool.query(`SELECT * FROM ${T('staff')} WHERE id = $1`, [String(id || '')]);
    if (!rows.length) return { result: 'none' };
    const account = recordFromRow(rows[0]);
    if (account.status === 'Inactive') return { result: 'inactive' };
    const password = temporaryPassword();
    const { salt, hash } = await newPasswordDetails(password);
    await pool.query(`UPDATE ${T('staff')} SET salt = $1, hash = $2, admin_reset_required = false, must_change_password = true WHERE id = $3`,
        [salt, hash, account.id]);
    await endOtherSessions('staff', account.id, '');
    const name = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username;
    const [emailed, whatsapp] = await Promise.all([
        sendSystemEmail(account.username, `Hello ${name}, your FEWA staff password has been reset. ` +
            `Sign in at ${PUBLIC_SITE} with your username ${account.username} and the temporary password ${password}. ` +
            'You will be asked to choose your own password when you sign in.'),
        sendWhatsAppTemplate(account.phone, [name, account.username, password, PUBLIC_SITE])]);
    return { result: 'ok', password, username: account.username, phone: account.phone || '', emailed, whatsapp, site: PUBLIC_SITE };
}
