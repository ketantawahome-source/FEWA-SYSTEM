/* ---------- FEWA system server: the web pages and the PostgreSQL database ----------
   Started by start-server.bat. Serves the pages at http://localhost:5600/ (the login page opens at the address
   alone) and keeps ALL the system's data in PostgreSQL. Only this computer can open it.

   Database connection: db-config.json in this folder (host, port, user, password, database, and "ssl" for a
   hosted database such as Supabase). On every start the tables defined in the database folder (one .sql file
   per schema) are created if missing (and, on this computer's PostgreSQL, the database "fewa_college").

   Tables, grouped in schemas (see database/*.sql for every column)
     students.students, students.documents, students.deferrals, students.applications, staff.staff
                         one column per field, so they can be read and edited in pgAdmin. A column like
                         first_name is the field firstName; fields without a column of their own are kept in
                         "extra". Columns added in pgAdmin become fields of the records (within 15 seconds).
     settings.settings   which table holds each Settings list or form (stored_in)
     settings.courses, schools, enrollment_types, study_sessions, campuses, batches, departments, qualification_types,
     student_types, document_types, reg_number_sequences, short_courses, award_types, staff_roles
                         one row per item of that Settings list, in the order shown (position)
     settings.school_setup, finance.fee_payment_details
                         the single row of that Settings form
     settings.role_operations    the rights given to each staff role
     academics.units, programme_units, unit_offers, unit_registrations, unit_lecturers, unit_hours, period_schedules,
     exam_groups, exam_types, grading_systems, group_exam_types, award_setups, course_exam_groups, exam_paper_types
                         Academic Management > Manage Units and Semester Schedule (Academics.html); one column per field, as students
     logins.sessions, logins.password_reset_codes
                         who is logged in, and emailed reset codes (hashes only) until used or expired
     files.stored_files  student photos and uploaded documents (bytes), referred to from the records

   Data API (used by db.js; every call must carry the header X-FEWA-Client: 1, so other websites open in the
   browser cannot send requests to it)
     GET    /api/health                       { ok: true }
     GET    /api/stores/:store                every record in the store
     GET    /api/stores/:store/:id            one record, or null
     PUT    /api/stores/:store/:id            add or replace one record
     DELETE /api/stores/:store/:id            remove one record
     POST   /api/stores/:store/replace        { records, merge }: restore a backup (merge keeps other records)
     GET    /api/files/:id                    a stored photo or document
     GET    /api/values                       staff accounts, role rights and reset codes (as db.js keeps them)
     PUT    /api/values/:key                  { value }: change one of them (null removes it)
   In records, a photo or document is { __file: id, type, name, size }; db.js sends a new one as
   { __newFile: true, type, name, data: <base64> } and the server stores its bytes in stored_files. */

/* The server is split into modules, one folder per area, under server/ (as a Nest.js app is):
   core (config, pages, http, database, connection, server keys), auth, stores, settings, files, messaging, sync,
   applications, rollcall, system-update, global-settings, monitoring, and api/router (every /api address). */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { initBackups } from './backups.mjs';
import { initFinance } from './finance.mjs';
import { handleApi } from './server/api/router.mjs';
import { forgetAccountCount, forgetSessions, isHttps, passwordAcceptable } from './server/auth/sessions.mjs';
import { SMALL_BODY_BYTES, listenAddress, port, root } from './server/core/config.mjs';
import { connectDatabase, pool } from './server/core/connection.mjs';
import { SCHEMA_OF, T, columnCache, ensureDatabase, loadConfig, sqlName } from './server/core/database.mjs';
import { readBody, send } from './server/core/http.mjs';
import { serveStatic } from './server/core/static.mjs';
import { PUBLIC_SITE, staffCan } from './server/messaging/email.mjs';
import { SENTRY_ENVIRONMENT, reportError, sentryDsn } from './server/monitoring/sentry.mjs';
import { SYNC_ORDER, mirrorChanged } from './server/sync/mirror.mjs';

/* The backups (database backups, the password-protected download, uploading corrected students) are in backups.mjs */
initBackups({ getPool: () => pool, T, sqlName, SCHEMA_OF, loadConfig, ensureDatabase, root, columnCache, forgetSessions, forgetAccountCount,
    mirrorChanged, SYNC_ORDER, passwordAcceptable, send, readBody, SMALL_BODY_BYTES });
/* Manage Finance (fee structure, charges, payments, statements) is in finance.mjs */
initFinance({ getPool: () => pool, T, send, readBody, staffCan, mirrorChanged,
SMALL_BODY_BYTES });
/* ---------- Start ---------- */
const handleRequest = async (req, res) => {
    // Protections every browser understands: no showing the system inside another website, no guessing file types,
    // and the address of a page (a reset link has a code in it) is never told to other websites
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'");
    res.setHeader('Referrer-Policy', 'same-origin');
    // The system never uses the camera, microphone, location or payments: browsers refuse them to any page script,
    // and other websites may not load the system's files into theirs
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    // (pictures stay open to others: an email may show the college logo straight from the website)
    if (!/\.(jpe?g|png|gif|svg|ico)$/i.test(String(req.url || '').split('?')[0])) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    // A strange address (e.g. "//" or a broken %-code) gets "Bad request" instead of stopping the server
    let file;
    try {
        file = decodeURIComponent(new URL('http://localhost' + req.url).pathname);
    } catch {
        return send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
    }
    try {
        if (file.startsWith('/api/')) return await handleApi(req, res, file.slice(5).split('/').filter(Boolean));
        // Short addresses: /staff and /student open the login page (it knows staff from students by the username);
        // /GLOBALSETTINGS is the owner's
        // hidden page (any capitals). With a "/" at the end the page's pictures and styles would not be found.
        const short = file.replace(/\/+$/, '').toLowerCase();
        if (short === '/staff' || short === '/student') {
            res.writeHead(302, { Location: '/login.html' });
            return res.end();
        }
        if (short === '/globalsettings' && file !== '/GLOBALSETTINGS' && file.endsWith('/')) {
            res.writeHead(302, { Location: '/GLOBALSETTINGS' });
            return res.end();
        }
        if (short === '/globalsettings') file = '/GlobalSettings.html';
        // The pages' error monitoring: the Sentry DSN (public by design: it only lets errors be sent), or nothing
        if (file === '/sentry-config.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(`window.FEWA_SENTRY = ${JSON.stringify(sentryDsn ? { dsn: sentryDsn, environment: SENTRY_ENVIRONMENT } : null)};`);
        }
        await serveStatic(req, res, file);
    } catch (err) {
        if (!err.status) {
            console.error(new Date().toLocaleString(), req.method, file, err);
            reportError(err, `${req.method} ${file}`);
        }
        // e.g. a column added in pgAdmin is not picked up yet, or a value does not fit its column's type
        if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'The database could not do this: ' + err.message });
        else res.end();
    }
};
const server = http.createServer(handleRequest).on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is already in use - the FEWA system is probably already running.`);
        console.log(`Open http://localhost:${port}/ in the browser.`);
    } else {
        console.log('The server could not start: ' + err.message);
    }
    process.exit(1);
});
server.listen(port, listenAddress, () => {
    /* On the office computer "localhost" is tried as ::1 (IPv6) first: with no answer there, every request waited
       about 0.2 seconds before trying 127.0.0.1, which made each page slow. So the server answers on both (still
       only this computer itself can reach them). */
    if (!process.env.PORT) http.createServer(handleRequest).on('error', () => { }).listen(port, '::1');
    console.log(`FEWA system is running at http://localhost:${port}/` + (process.env.PORT ? ' (online)' : ''));
    console.log('Keep this window open while using the system. Close it to stop the server.');
    // start-server.bat asks for the browser ("open") only now that the server answers, so it never shows
    // "can't reach this page"
    if (!process.env.PORT && process.argv[3] === 'open' && process.platform === 'win32') {
        execFile('cmd', ['/c', 'start', '', `http://localhost:${port}/`], () => { });
    }
    connectDatabase();
    // Render's free plan puts the online system to sleep after 15 minutes without visitors, and the first visit
    // after that waits 20+ seconds. While the office computer is on, it visits the online system every 10 minutes
    // so it stays awake.
    if (!process.env.PORT) {
        const keepAwake = () => fetch(PUBLIC_SITE + '/login.html', { method: 'HEAD', signal: AbortSignal.timeout(60000) })
            .catch(() => { });
        keepAwake();
        setInterval(keepAwake, 10 * 60 * 1000).unref();
    }
});
