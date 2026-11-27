/* ---------- Global Settings (the hidden owner page) ---------- */
import { randomBytes } from 'node:crypto';
import { forgetSessions, isHttps, loginFailed, loginLocked, newPasswordDetails, parseCookies, passwordAcceptable, passwordMatches, sha256 } from '../auth/sessions.mjs';
import { SMALL_BODY_BYTES } from '../core/config.mjs';
import { pool, sessionsValidFrom } from '../core/connection.mjs';
import { T } from '../core/database.mjs';
import { readBody, send } from '../core/http.mjs';
import { readServerKey, writeServerKey } from '../core/server-keys.mjs';
import { forbidden, staffCan } from '../messaging/email.mjs';
import { logOutEveryone } from '../system-update/system-update.mjs';

/* ---------- Global Settings (the hidden page /GLOBALSETTINGS) ----------
   The owner's switches for the whole system, behind a password of their own. The password (scrypt, as staff
   passwords) and the switches are rows of private_settings.server_keys, so no page, backup or office copy has them:
     global_settings_password  {"salt": ..., "hash": ...}
     global_controls           {"systemOpen", "closedMessage", "staffLogins", "studentLogins", "applications",
                                "shortCourses" (short courses on: Settings tab and fields, online applications, new students, Course units panel),
                                "attendanceBackdating" (registers may be taken for past days), "attendanceBackdateDays" (how many),
                                "newSidebar" (the new floating sidebar; false: the classic one)}
   The first password can only be set by a logged-in Administrator. A forgotten password: delete the row
   'global_settings_password' in pgAdmin (Supabase), then an Administrator sets a new one. */
const GLOBAL_COOKIE = 'fewa_global';
const GLOBAL_MINUTES = 30;
export const DEFAULT_CONTROLS = { systemOpen: true, closedMessage: '', staffLogins: true, studentLogins: true, applications: true,
    shortCourses: true, attendanceBackdating: false, attendanceBackdateDays: 0, newSidebar: true,
    // Student Portal Course Registration: the share of their fees (0-100 %) a student must have paid to see their
    // course units and register; 0 = no fee needed (server/academics/online-registration.mjs feePosition)
    registrationFeePercent: 0,
    // Which settings the school may change itself (Settings > Organisation Setup > School Settings), ticked by the owner
    schoolMayChange: {} };

/* The settings, with their kind and limits: used to check every change (owner's page and the school's page) and to show
   the school the ones the owner allows (name and description as on GlobalSettings.html) */
export const SETTING_DEFS = [
    { control: 'systemOpen', label: 'System open', hint: 'No closes the system for everyone.', name: 'SYSTEM_OPEN', type: 'yesNo', description: 'YES: the system works as normal. NO: closes it for everyone (staff, students and online applications) and logs everyone out.' },
    { control: 'closedMessage', label: 'Message while the system is closed', hint: 'Empty: a standard message.', name: 'SYSTEM_CLOSED_MESSAGE', type: 'text', max: 500, description: 'The message people see while the system is closed. Empty: a standard maintenance message.' },
    { control: 'staffLogins', label: 'Staff can log in', hint: '', name: 'STAFF_LOGINS_ENABLED', type: 'yesNo', description: 'NO: staff cannot log in, and staff who are logged in are logged out.' },
    { control: 'studentLogins', label: 'Student Portal open', hint: '', name: 'STUDENT_PORTAL_ENABLED', type: 'yesNo', description: 'NO: students cannot log in to the Student Portal.' },
    { control: 'applications', label: 'Online applications open', hint: '', name: 'ONLINE_APPLICATIONS_ENABLED', type: 'yesNo', description: 'NO: the online application form says applications are closed.' },
    { control: 'attendanceBackdating', label: 'Registers may be taken for past days', hint: '', name: 'ATTENDANCE_BACKDATING_ENABLED', type: 'yesNo', description: 'YES: Roll Call registers may be taken (or corrected) for past days, up to ATTENDANCE_BACKDATE_DAYS back. NO: only for today.' },
    { control: 'attendanceBackdateDays', label: 'Days back a register may be taken', hint: '0 = today only.', name: 'ATTENDANCE_BACKDATE_DAYS', type: 'number', max: 365, description: 'How many days back a register may be taken when ATTENDANCE_BACKDATING_ENABLED is YES (0 to 365).' },
    { control: 'registrationFeePercent', label: 'Fees to be paid before course registration (%)', hint: '0 = no fee needed. 50 = half of the fees.', name: 'COURSE_REGISTRATION_FEE_PERCENT', type: 'number', max: 100, description: 'The share of their fees (0 to 100 %) a student must have paid before the Student Portal shows their course units and lets them register. 0: no fee needed.' },
    { control: 'newSidebar', label: 'New sidebar', hint: '', name: 'NEW_SIDEBAR_ENABLED', type: 'yesNo', description: 'YES: the new floating sidebar. NO: the classic sidebar.' },
    { control: 'shortCourses', label: 'Short courses offered', hint: '', name: 'SHORT_COURSES_ENABLED', type: 'yesNo', description: 'NO hides the short courses (Settings, online applications, new students, Course units). Students already on a short course keep it.' }
];
// Checks the changed values in body (only the controls named in keys) and returns the settings with them
function withChanges(current, body, keys) {
    const next = { ...current };
    for (const def of SETTING_DEFS.filter(d => keys.includes(d.control) && body[d.control] !== undefined)) {
        const value = body[def.control];
        if (def.type === 'yesNo') {
            if (typeof value !== 'boolean') throw Object.assign(new Error(`${def.name} must be YES or NO.`), { status: 400 });
            next[def.control] = value;
        } else if (def.type === 'number') {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0 || n > def.max) throw Object.assign(new Error(`${def.name} must be a whole number from 0 to ${def.max}.`), { status: 400 });
            next[def.control] = n;
        } else next[def.control] = String(value).trim().slice(0, def.max);
    }
    return next;
}
async function saveControls(next) {
    await writeServerKey('global_controls', JSON.stringify(next));
    controlsCache = { at: Date.now(), value: next };
    forgetSessions(); // switched-off logins end straight away
}
// Read at most every 10 seconds (every request asks)
let controlsCache = { at: 0, value: null };
export async function globalControls() {
    if (!controlsCache.value || Date.now() - controlsCache.at > 10000) {
        let saved = {};
        try { saved = JSON.parse(await readServerKey('global_controls') || '{}'); } catch { /* the defaults */ }
        controlsCache = { at: Date.now(), value: { ...DEFAULT_CONTROLS, ...saved } };
    }
    return controlsCache.value;
}
export const closedMessage = controls => controls.closedMessage ||
    'The system is closed for maintenance at the moment. Please try again later.';
async function globalSession(req) {
    const token = parseCookies(req)[GLOBAL_COOKIE];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const { rowCount } = await pool.query(`SELECT 1 FROM ${T('sessions')} WHERE token_hash = $1 AND kind = 'global'
        AND expires_at > now()`, [sha256(token)]);
    return rowCount > 0;
}
async function startGlobalSession(req, res) {
    const token = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO ${T('sessions')} (token_hash, kind, subject, expires_at, created_at)
        VALUES ($1, 'global', 'owner', now() + make_interval(mins => $2), now())`, [sha256(token), GLOBAL_MINUTES]);
    res.setHeader('Set-Cookie', `${GLOBAL_COOKIE}=${token}; Path=/api/global; HttpOnly; SameSite=Strict; ` +
        `Max-Age=${GLOBAL_MINUTES * 60}` + (isHttps(req) ? '; Secure' : ''));
}
async function endGlobalSession(req, res) {
    const token = parseCookies(req)[GLOBAL_COOKIE];
    if (token) await pool.query(`DELETE FROM ${T('sessions')} WHERE token_hash = $1 AND kind = 'global'`, [sha256(token)]);
    res.setHeader('Set-Cookie', `${GLOBAL_COOKIE}=; Path=/api/global; HttpOnly; SameSite=Strict; Max-Age=0`);
}
async function globalPasswordMatches(password) {
    let saved = null;
    try { saved = JSON.parse(await readServerKey('global_settings_password') || 'null'); } catch { /* none */ }
    return !!saved && await passwordMatches(String(password || ''), saved.salt, saved.hash);
}
async function setGlobalPassword(password) {
    if (!passwordAcceptable(password)) throw Object.assign(new Error('The password must have at least 8 characters.'), { status: 400 });
    await writeServerKey('global_settings_password', JSON.stringify(await newPasswordDetails(password)));
}
// Who is logged in now (staff and students), newest first
async function signedInNow() {
    const { rows } = await pool.query(`SELECT s.kind, s.created_at, s.expires_at,
            CASE WHEN s.kind = 'staff' THEN concat_ws(' ', st.first_name, st.last_name) ELSE concat_ws(' ', su.first_name, su.last_name) END AS name,
            CASE WHEN s.kind = 'staff' THEN st.username ELSE su.adm_no END AS login,
            CASE WHEN s.kind = 'staff' THEN coalesce(st.job_title, st.role) ELSE 'Student' END AS role
        FROM ${T('sessions')} s
        LEFT JOIN ${T('staff')} st ON s.kind = 'staff' AND st.id = s.subject
        LEFT JOIN ${T('students')} su ON s.kind = 'student' AND su.id = s.subject
        WHERE s.kind IN ('staff', 'student') AND s.expires_at > now() AND ($1::timestamptz IS NULL OR s.created_at >= $1)
        ORDER BY s.created_at DESC LIMIT 500`, [sessionsValidFrom]);
    return rows.map(r => ({ kind: r.kind, name: r.name || '', login: r.login || '', role: r.role || '',
        since: r.created_at, until: r.expires_at }));
}
export async function handleGlobal(req, res, session, action, method) {
    const passwordSet = !!await readServerKey('global_settings_password');
    const signedIn = passwordSet && await globalSession(req);
    const body = method === 'POST' || method === 'PUT' ? await readBody(req, SMALL_BODY_BYTES) || {} : {};

    if (method === 'GET' && action === 'status') {
        return send(res, 200, {
            passwordSet, signedIn, canSetUp: !passwordSet && session.kind === 'staff' && !!session.admin,
            controls: signedIn ? await globalControls() : null,
            signedInNow: signedIn ? await signedInNow() : null
        });
    }
    // The first password: only an Administrator logged in to the system
    if (method === 'POST' && action === 'setup') {
        if (passwordSet || !(session.kind === 'staff' && session.admin)) throw forbidden();
        await setGlobalPassword(String(body.password || ''));
        await startGlobalSession(req, res);
        return send(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'login') {
        if (!passwordSet) throw forbidden();
        if (loginLocked(req, 'global-settings')) return send(res, 200, { result: 'locked' });
        if (!await globalPasswordMatches(body.password)) {
            loginFailed(req, 'global-settings');
            return send(res, 200, { result: 'wrong' });
        }
        await startGlobalSession(req, res);
        return send(res, 200, { result: 'ok' });
    }
    if (method === 'POST' && action === 'logout') {
        await endGlobalSession(req, res);
        return send(res, 200, { ok: true });
    }

    if (!signedIn) throw Object.assign(new Error('Enter the Global Settings password again.'), { status: 401 });
    if (method === 'PUT' && action === 'controls') {
        const next = withChanges(await globalControls(), body, SETTING_DEFS.map(d => d.control));
        // "School may change it" ticks: { control: true / false }
        if (body.schoolMayChange && typeof body.schoolMayChange === 'object') {
            const may = { ...(next.schoolMayChange || {}) };
            for (const def of SETTING_DEFS) {
                if (typeof body.schoolMayChange[def.control] === 'boolean') may[def.control] = body.schoolMayChange[def.control];
            }
            next.schoolMayChange = Object.fromEntries(Object.entries(may).filter(([, on]) => on));
        }
        await saveControls(next);
        return send(res, 200, { controls: next });
    }
    if (method === 'POST' && action === 'logout-everyone') {
        await logOutEveryone();
        return send(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'password') {
        if (!await globalPasswordMatches(body.current)) return send(res, 200, { result: 'wrong' });
        await setGlobalPassword(String(body.password || ''));
        return send(res, 200, { result: 'ok' });
    }
    send(res, 404, { error: 'Unknown request' });
}

/* ---------- School Settings (Settings > Organisation Setup > School Settings; owner, 2026-11-27) ----------
   The Global Settings the owner ticked "School may change it" for, changed by the school's staff without the Global
   Settings password (shown at the bottom of Settings > Organisation Setup > School Setup with their short label and hint):
                       GET  /api/school-settings   the allowed settings with their values (Access Settings or the right)
                       PUT  /api/school-settings   { control: value, ... }  only allowed ones (Manage School Settings) */
export async function handleSchoolSettings(req, res, session, method) {
    if (!session || session.kind !== 'staff') throw forbidden();
    const controls = await globalControls();
    const allowed = SETTING_DEFS.filter(d => (controls.schoolMayChange || {})[d.control]);
    const canChange = await staffCan(session, 'settings.school');
    if (method === 'GET') {
        if (!canChange && !await staffCan(session, 'settings.view')) throw forbidden();
        return send(res, 200, { canChange, settings: allowed.map(d => ({ ...d, value: controls[d.control] })) });
    }
    if (method === 'PUT') {
        if (!canChange) throw forbidden();
        const body = await readBody(req, SMALL_BODY_BYTES) || {};
        const refused = Object.keys(body).filter(key => !allowed.some(d => d.control === key));
        if (refused.length) throw Object.assign(new Error('The school may not change: ' + refused.join(', ') + '.'), { status: 403 });
        const next = withChanges(controls, body, allowed.map(d => d.control));
        await saveControls(next);
        return send(res, 200, { canChange, settings: allowed.map(d => ({ ...d, value: next[d.control] })) });
    }
    send(res, 404, { error: 'Unknown request' });
}
