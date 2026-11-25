/* ---------- Weekly security check (Windows Task Scheduler: "FEWA Security Check", Mondays 08:00) ----------
   Checks the online system and the office server from the outside, as an attacker would, without logging in:
     - the protections every page must carry (frame, sniffing, referrer, permissions; https-only online)
     - no "X-Powered-By" (it would say what software runs the system)
     - private files cannot be downloaded (password file, server code, backups, notes, git, packages)
     - no data without logging in (students, staff, registers, files, backups)
   Each run writes one line per check to security-check.log in this folder (no college data, only pass/fail).
   Any problem is sent to Sentry (the DSN the servers use), so it arrives as an email. If the office server is
   not running, it is started (start-server.bat). Run by hand with: node security-check.mjs */
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const SITES = [{ name: 'online', url: 'https://fewa-system.onrender.com', https: true }, { name: 'office', url: 'http://localhost:5600', https: false }];
const PRIVATE = ['/db-config.json', '/server.mjs', '/backups.mjs', '/finance.mjs', '/package.json', '/.env', '/.git/config',
    '/CLAUDE.md', '/render.yaml', '/start-server.bat', '/security-check.mjs', '/database/1-students.sql', '/node_modules/pg/package.json',
    '/%2e%2e/%2e%2e/Windows/win.ini', '/..%5c..%5cWindows%5cwin.ini', '/vendor/../db-config.json'];
const LOCKED_API = ['/api/stores/students', '/api/stores/staff', '/api/stores/attendance_registers', '/api/files/x', '/api/backups'];
const HEADERS = ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy', 'permissions-policy'];

const problems = [], lines = [];
const note = (site, ok, text) => { lines.push(`${ok ? 'ok     ' : 'PROBLEM'} ${site}: ${text}`); if (!ok) problems.push(`${site}: ${text}`); };
const get = (url, options = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(90000), ...options });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function checkSite(site) {
    let page;
    try { page = await get(site.url + '/login.html'); } catch (err) { return note(site.name, false, `not answering (${err.message})`); }
    note(site.name, page.status === 200, `login page answers (${page.status})`);
    for (const h of HEADERS) note(site.name, !!page.headers.get(h), `protection ${h}`);
    if (site.https) note(site.name, !!page.headers.get('strict-transport-security'), 'protection strict-transport-security (https only)');
    note(site.name, !page.headers.get('x-powered-by'), 'no X-Powered-By');
    for (const p of PRIVATE) {
        const r = await get(site.url + p).catch(() => null);
        note(site.name, !r || r.status !== 200, `private file not served: ${p}${r ? ` (${r.status})` : ''}`);
    }
    for (const p of LOCKED_API) {
        const r = await get(site.url + p, { headers: { 'X-FEWA-Client': '1' } }).catch(() => null);
        note(site.name, !r || r.status >= 400, `no data without logging in: ${p}${r ? ` (${r.status})` : ''}`);
    }
    const values = await get(site.url + '/api/values', { headers: { 'X-FEWA-Client': '1' } }).then(r => r.text()).catch(() => '{}');
    note(site.name, values.trim() === '{}', 'no staff accounts without logging in');
}

// The office server: started again when it is not running
async function officeRunning() {
    try { return (await get('http://localhost:5600/api/health')).ok; } catch { return false; }
}
if (!(await officeRunning())) {
    note('office', false, 'the office server was not running - started it again');
    spawn('cmd', ['/c', 'start', '"FEWA System Server"', '/min', path.join(root, 'start-server.bat'), 'startup'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 12 && !(await officeRunning()); i++) await wait(5000);
}

for (const site of SITES) await checkSite(site);

const stamp = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' });
await appendFile(path.join(root, 'security-check.log'),
    `\n=== ${stamp} - ${problems.length ? problems.length + ' PROBLEM(S)' : 'all ' + lines.length + ' checks passed'}\n` + lines.join('\n') + '\n');
console.log(problems.length ? `${problems.length} problem(s):\n` + problems.join('\n') : `All ${lines.length} checks passed.`);

// Problems go to Sentry as one alert (the DSN the servers use, from whichever answers)
if (problems.length) {
    let dsn = '';
    for (const site of [...SITES].reverse()) {
        const text = await get(site.url + '/sentry-config.js').then(r => r.text()).catch(() => '');
        const m = text.match(/"dsn":"([^"]+)"/);
        if (m) { dsn = m[1]; break; }
    }
    if (dsn) {
        const Sentry = await import('@sentry/node');
        Sentry.init({ dsn, environment: 'security-check', sendDefaultPii: false, tracesSampleRate: 0 });
        Sentry.captureMessage(`Weekly security check: ${problems.length} problem(s) - ${problems.slice(0, 3).join(' | ')}`, {
            level: 'warning', tags: { where: 'security-check' }, extra: undefined });
        await Sentry.flush(10000);
        console.log('Sent to Sentry.');
    } else console.log('Sentry is not reachable: see security-check.log.');
}
