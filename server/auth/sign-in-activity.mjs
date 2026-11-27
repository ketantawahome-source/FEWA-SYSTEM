/* ---------- Sign-in activity (owner, 2026-11-27): Settings > Access Management > Sign-in Activity ----------
   Every login attempt is kept in logins.sign_in_activity: when, the account typed (email or AdmNo), how, whether it
   worked and why not, the browser and the address. Never a password. Kept 90 days. Administrators only:
     GET /api/sign-in-activity              the last 14 days (Kenya time): day, sign-ins, failed
     GET /api/sign-in-activity?day=YYYY-MM-DD   that day's failed sign-ins (?all=1: every attempt that day) */
import { pool } from '../core/connection.mjs';
import { T } from '../core/database.mjs';

const KEEP_DAYS = 90;
const RESULT_WORDS = {
    ok: 'Signed in', wrong: 'Wrong password', 'wrong-password': 'Wrong password',
    'wrong-case': 'AdmNo typed in the wrong capital letters', locked: 'Locked: too many wrong tries',
    closed: 'System closed', 'staff-off': 'Staff logins switched off', 'student-off': 'Student logins switched off',
    inactive: 'Account inactive', 'reset-required': 'Password reset needed', 'no-password': 'No password set yet',
    unknown: 'Not registered at this school'
};

// "Chrome on Windows", "Safari on iPhone", ... from the browser's own description
export function browserName(agent = '') {
    const a = String(agent);
    const browser = /Edg\//.test(a) ? 'Edge' : /OPR\/|Opera/.test(a) ? 'Opera' : /Firefox\//.test(a) ? 'Firefox'
        : /SamsungBrowser/.test(a) ? 'Samsung Internet' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari' : a ? 'Other browser' : 'Unknown';
    const system = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android' : /Windows/.test(a) ? 'Windows'
        : /Mac OS X|Macintosh/.test(a) ? 'Mac' : /Linux/.test(a) ? 'Linux' : '';
    return system ? `${browser} on ${system}` : browser;
}

// Keeps one attempt; never stops a login if it cannot be written
export async function recordSignIn({ account, kind, how = 'Password', result, browser, address }) {
    try {
        await pool.query(`INSERT INTO ${T('sign_in_activity')} (account, kind, how, ok, result, browser, address)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [String(account || '').slice(0, 200), kind || '', how, result === 'ok', RESULT_WORDS[result] || result, browser, String(address || '').slice(0, 100)]);
        if (Math.random() < 0.02) await pool.query(`DELETE FROM ${T('sign_in_activity')} WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    } catch (err) { console.log(new Date().toLocaleString(), 'Sign-in activity not kept:', err.message); }
}

const KENYA = `'Africa/Nairobi'`;
export async function signInActivity(query) {
    const day = String(query.get('day') || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const { rows } = await pool.query(`SELECT at, account, kind, how, ok, result, browser, address FROM ${T('sign_in_activity')}
            WHERE (at AT TIME ZONE ${KENYA})::date = $1::date ${query.get('all') === '1' ? '' : 'AND NOT ok'}
            ORDER BY at DESC LIMIT 1000`, [day]);
        return { day, rows };
    }
    const { rows } = await pool.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
            count(a.id) FILTER (WHERE a.ok)::int AS "signIns", count(a.id) FILTER (WHERE NOT a.ok)::int AS failed
        FROM generate_series((now() AT TIME ZONE ${KENYA})::date - 13, (now() AT TIME ZONE ${KENYA})::date, interval '1 day') d
        LEFT JOIN ${T('sign_in_activity')} a ON (a.at AT TIME ZONE ${KENYA})::date = d::date
        GROUP BY d ORDER BY d DESC`);
    return { days: rows };
}
