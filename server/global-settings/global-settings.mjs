/* ---------- Global Settings (the hidden owner page) ---------- */
import { randomBytes } from 'node:crypto';
import { forgetSessions, isHttps, loginFailed, loginLocked, newPasswordDetails, parseCookies, passwordAcceptable, passwordMatches, sha256 } from '../auth/sessions.mjs';
import { SMALL_BODY_BYTES } from '../core/config.mjs';
import { pool, sessionsValidFrom } from '../core/connection.mjs';
import { T } from '../core/database.mjs';
import { readBody, send } from '../core/http.mjs';
import { readServerKey, writeServerKey } from '../core/server-keys.mjs';
import { forbidden } from '../messaging/email.mjs';
import { logOutEveryone } from '../system-update/system-update.mjs';

/* ---------- Global Settings (the hidden page /GLOBALSETTINGS) ----------
   The owner's switches for the whole system, behind a password of their own. The password (scrypt, as staff
   passwords) and the switches are rows of private_settings.server_keys, so no page, backup or office copy has them:
     global_settings_password  {"salt": ..., "hash": ...}
     global_controls           {"systemOpen", "closedMessage", "staffLogins", "studentLogins", "applications",
                                "shortCourses" (the Short Courses tab and a course's short course fields shown),
                                "attendanceBackdating" (registers may be taken for past days), "attendanceBackdateDays" (how many)}
   The first password can only be set by a logged-in Administrator. A forgotten password: delete the row
   'global_settings_password' in pgAdmin (Supabase), then an Administrator sets a new one. */
const GLOBAL_COOKIE = 'fewa_global';
const GLOBAL_MINUTES = 30;
export const DEFAULT_CONTROLS = { systemOpen: true, closedMessage: '', staffLogins: true, studentLogins: true, applications: true,
    shortCourses: true, attendanceBackdating: false, attendanceBackdateDays: 0 };
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
        const current = await globalControls();
        const next = { ...current };
        for (const key of ['systemOpen', 'staffLogins', 'studentLogins', 'applications', 'shortCourses', 'attendanceBackdating']) {
            if (typeof body[key] === 'boolean') next[key] = body[key];
        }
        if (body.attendanceBackdateDays !== undefined) {
            const days = Number(body.attendanceBackdateDays);
            if (!Number.isInteger(days) || days < 0 || days > 365) throw Object.assign(new Error('The number of days must be a whole number from 0 to 365.'), { status: 400 });
            next.attendanceBackdateDays = days;
        }
        if (body.closedMessage !== undefined) next.closedMessage = String(body.closedMessage).trim().slice(0, 500);
        await writeServerKey('global_controls', JSON.stringify(next));
        controlsCache = { at: Date.now(), value: next };
        forgetSessions(); // switched-off logins end straight away
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
