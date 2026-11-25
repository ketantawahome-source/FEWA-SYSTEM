/* ---------- The API: every /api/... address and which module answers it ---------- */
import { handleBackupRequest } from '../../backups.mjs';
import { handleFinanceRequest } from '../../finance.mjs';
import { applicationEnded, applicationOptions, applicationStarted, checkApplyLimits, receiveApplication } from '../applications/applications.mjs';
import { ACCOUNTS_KEY, RESET_PREFIX, ROLE_OPERATIONS_KEY, STAFF_DETAIL_FIELDS, STAFF_DETAIL_FILES, STAFF_IMAGE_MAX_BYTES, getValues, onlyDetails, setValue } from '../auth/accounts.mjs';
import { endSession, forgetAccountCount, forgetSessions, getSession, isLocalRequest, login, loginFailed, loginLocked, resetStaffPasswordOnServer, setOwnPassword, setupNeeded } from '../auth/sessions.mjs';
import { APPLY_BODY_BYTES, SMALL_BODY_BYTES } from '../core/config.mjs';
import { databaseError, inTransaction, pool } from '../core/connection.mjs';
import { ADMIN_STORES, T, recordFromRow, snakeToCamel, sqlName, tableColumns } from '../core/database.mjs';
import { readBody, send } from '../core/http.mjs';
import { deleteUnusedFiles, storeNewFiles } from '../files/stored-files.mjs';
import { DEFAULT_CONTROLS, globalControls, handleGlobal } from '../global-settings/global-settings.mjs';
import { RIGHTS_TO_READ, accountsForSession, completeResetOnServer, forbidden, hidePasswords, keepPasswords, keepStudentLogin, requestPasswordReset, resetRequestAllowed, rightsToWrite, sendNewAdminEmail, sendStaffPasswordLink, sendStudentLoginEmail, staffCan, staffMayOpenFile, studentFileIds, verifyResetCodeOnServer } from '../messaging/email.mjs';
import { setStudentPasswordOnServer } from '../messaging/whatsapp.mjs';
import { attendanceBackDays, attendanceDayProblem } from '../rollcall/attendance-rules.mjs';
import { STORES, deleteRecord, getAllRecords, getRecord, putRecord, replaceRecords, selectRecords } from '../stores/stores.mjs';
import { STORE_TABLES, mirrorChanged, mirrorState, valueTables } from '../sync/mirror.mjs';
import { lastSystemUpdate, runSystemUpdate, updateInfo, updateRun, validTimeZone } from '../system-update/system-update.mjs';

export async function handleApi(req, res, parts) {
    const [area, a, b] = parts;
    const method = req.method;
    // Azure's health check (and other hosts') checks that the server is up; this answer gives nothing away
    if (area === 'health' && method === 'GET' && req.headers['x-fewa-client'] !== '1') return send(res, 200, { ok: !!pool });
    // Only the system's own pages send this header; a request from another website cannot
    if (req.headers['x-fewa-client'] !== '1') return send(res, 403, { error: 'Forbidden' });
    if (!pool) return send(res, 503, { error: databaseError || 'The database is not connected yet.' });

    const session = await getSession(req);
    const staff = session.kind === 'staff';
    const admin = staff && session.admin;
    // No staff account yet, and the request comes from this computer: setting the system up
    const setup = await setupNeeded() && isLocalRequest(req);
    const fullAccess = setup || staff;
    // Signed in with a temporary password (Reset Password): only choosing their own password, until they do
    if (staff && session.account.mustChangePassword && !['session', 'password', 'values', 'health', 'global'].includes(area)) {
        return send(res, 403, { error: 'Choose your own password first (you signed in with a temporary password).' });
    }

    if (area === 'health' && method === 'GET') return send(res, 200, { ok: true, mirror: mirrorState });
    if (area === 'global') return await handleGlobal(req, res, session, a, method);

    /* ---------- Logging in and out, passwords ---------- */
    if (area === 'session' && method === 'GET' && !a) {
        const blocked = await setupNeeded() && !isLocalRequest(req);
        // The login page shows who is logged in already in this browser (a staff member, a student, or both)
        const loggedIn = { staff: null, student: null };
        if (req.headers['x-fewa-portal'] === 'login') {
            const staffNow = await getSession(req, 'staff');
            if (staffNow.kind) loggedIn.staff = staffNow.account.username;
            const studentNow = await getSession(req, 'student');
            if (studentNow.kind) {
                const { rows } = await pool.query(`SELECT adm_no FROM ${T('students')} WHERE id = $1`, [studentNow.studentId]);
                loggedIn.student = rows.length ? rows[0].adm_no || 'a student' : null;
            }
        }
        return send(res, 200, {
            loggedIn,
            setupNeeded: setup, setupBlocked: blocked, kind: session.kind,
            accountId: staff ? session.account.id : null, username: staff ? session.account.username : null,
            admin: !!admin, studentId: session.kind === 'student' ? session.studentId : null,
            // Global Settings: the short courses part shown or hidden
            shortCourses: (await globalControls().catch(() => DEFAULT_CONTROLS)).shortCourses !== false,
            // Global Settings: the new floating sidebar, or the classic one
            newSidebar: (await globalControls().catch(() => DEFAULT_CONTROLS)).newSidebar !== false,
            // Roll Call: how many days back a register may be taken (0: today only)
            attendanceBackDays: await attendanceBackDays(),
            resetEmail: session.kind === 'reset' ? session.email : null
        });
    }
    if (area === 'session' && a === 'login' && method === 'POST') return send(res, 200, await login(req, res, await readBody(req, SMALL_BODY_BYTES)));
    if (area === 'session' && a === 'logout' && method === 'POST') {
        await endSession(req, res, session);
        return send(res, 200, { ok: true });
    }
    if (area === 'password' && method === 'POST' && !a) {
        if (!staff) throw forbidden();
        const result = await setOwnPassword(session, String((await readBody(req) || {}).password || ''));
        mirrorChanged(['staff']);
        return send(res, 200, result);
    }
    if (area === 'student-password' && method === 'POST') {
        if (!staff && session.kind !== 'student') throw forbidden();
        if (staff && !await staffCan(session, 'students.edit', 'students.add', 'students.password')) throw forbidden();
        const result = await setStudentPasswordOnServer(session, await readBody(req, SMALL_BODY_BYTES) || {});
        mirrorChanged(['students']);
        return send(res, 200, result);
    }
    if (area === 'staff-password-reset' && method === 'POST') {
        if (!admin) throw forbidden();
        const result = await resetStaffPasswordOnServer(await readBody(req, SMALL_BODY_BYTES) || {});
        mirrorChanged(['staff']);
        return send(res, 200, result);
    }
    if (area === 'password-link' && method === 'POST') {
        if (!admin) throw forbidden();
        const result = await sendStaffPasswordLink(await readBody(req, SMALL_BODY_BYTES) || {});
        mirrorChanged(['password_reset_codes']);
        return send(res, 200, result);
    }
    if (area === 'student-email' && method === 'POST') {
        if (!staff || !await staffCan(session, 'students.edit', 'students.add', 'students.password')) throw forbidden();
        return send(res, 200, await sendStudentLoginEmail(await readBody(req, SMALL_BODY_BYTES) || {}));
    }
    if (area === 'new-admin-email' && method === 'POST') {
        if (!staff) throw forbidden();
        return send(res, 200, { sent: await sendNewAdminEmail(session.account) });
    }
    if (area === 'password-reset' && a === 'verify' && method === 'POST') {
        const body = await readBody(req, SMALL_BODY_BYTES) || {};
        if (loginLocked(req, 'reset:' + body.email)) return send(res, 200, { result: 'none' });
        const result = await verifyResetCodeOnServer(req, res, body);
        if (result.result !== 'ok') loginFailed(req, 'reset:' + body.email);
        mirrorChanged(['password_reset_codes']);
        return send(res, 200, result);
    }
    if (area === 'password-reset' && !a && method === 'POST') {
        const { table, ...result } = await completeResetOnServer(req, res, session, await readBody(req, SMALL_BODY_BYTES) || {});
        mirrorChanged([table || 'staff']);
        return send(res, 200, result);
    }
    // "Forgot your password?" (staff by email, students by AdmNo): a few requests per username per 15 minutes
    if (area === 'password-reset' && a === 'request' && method === 'POST') {
        const body = await readBody(req, SMALL_BODY_BYTES) || {};
        if (!resetRequestAllowed(req, body.username)) return send(res, 200, { result: 'locked' });
        const result = await requestPasswordReset(req, body);
        mirrorChanged(['password_reset_codes']);
        return send(res, 200, result);
    }

    /* ---------- Online applications: open to everyone ---------- */
    if (area === 'apply' && a === 'options' && method === 'GET') return send(res, 200, await applicationOptions());
    if (area === 'apply' && !a && method === 'POST') {
        checkApplyLimits(req);
        applicationStarted();
        try {
            return send(res, 200, await receiveApplication(req, await readBody(req, APPLY_BODY_BYTES)));
        } finally {
            applicationEnded();
        }
    }

    /* ---------- Manage Finance: staff by their rights, a student only their own statement ---------- */
    if (area === 'finance') return await handleFinanceRequest(req, res, session, parts.slice(1));

    /* ---------- Records ---------- */
    if (area === 'stores' && STORES[a]) {
        // Staff qualifications: administrators only (other staff get nothing and can change nothing)
        if (ADMIN_STORES.includes(a) && !(setup || admin)) {
            if (method === 'GET' && staff) return send(res, 200, b ? null : []);
            throw forbidden();
        }
        if (method === 'GET') {
            // A role without the right simply gets nothing, so its screens open empty instead of showing an error
            if (staff && RIGHTS_TO_READ[a] && !await staffCan(session, ...RIGHTS_TO_READ[a])) return send(res, 200, b ? null : []);
            if (fullAccess) return send(res, 200, hidePasswords(a, b ? await getRecord(a, b) : await getAllRecords(a)));
            if (session.kind === 'student') {
                if (a === 'applications') throw forbidden();
                const mine = record => a === 'students' ? record.id === session.studentId
                    : a === 'settings' ? true : record.studentId === session.studentId;
                if (b) {
                    const record = await getRecord(a, b);
                    return send(res, 200, record && mine(record) ? hidePasswords(a, record) : null);
                }
                return send(res, 200, a === 'students'
                    ? hidePasswords(a, await selectRecords(pool, 'students', session.studentId))
                    : (await getAllRecords(a)).filter(mine));
            }
            // Not logged in: the college name and logo for the login page only
            if (a === 'settings' && b === 'organization') return send(res, 200, await getRecord(a, b));
            if (a === 'settings' && !b) return send(res, 200, (await getAllRecords(a)).filter(s => s.key === 'organization'));
            throw forbidden();
        }
        if (!fullAccess) throw forbidden();
        if ((method === 'PUT' || method === 'DELETE') && b && staff && !await staffCan(session, ...await rightsToWrite(a, b, method))) throw forbidden();
        // Roll Call: registers only for the days Global Settings allows (a register already saved too)
        const registerDayCheck = async (...days) => {
            for (const day of days) {
                const problem = await attendanceDayProblem(day);
                if (problem) throw Object.assign(new Error(problem), { status: 400 });
            }
        };
        if (a === 'attendance_registers' && b && method === 'DELETE') {
            const before = await getRecord(a, b);
            if (before) await registerDayCheck(before.registerDate);
        }
        if (method === 'PUT' && b) {
            const body = await readBody(req);
            if (a === 'attendance_registers') {
                const before = await getRecord(a, b);
                await registerDayCheck(body && body.registerDate, ...(before ? [before.registerDate] : []));
            }
            const saved = await putRecord(a, b, a === 'students' ? await keepStudentLogin(body) : body);
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, hidePasswords(a, saved));
        }
        if (method === 'DELETE' && b) {
            // Students are never deleted through the system: only by the administrator, in the databases themselves
            if (a === 'students') throw forbidden();
            await deleteRecord(a, b);
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, { ok: true });
        }
        if (method === 'POST' && b === 'replace') {
            if (!(setup || admin)) throw forbidden();
            const body = await readBody(req) || {};
            await replaceRecords(a, Array.isArray(body.records) ? body.records : [], !!body.merge);
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, { ok: true });
        }
    }

    if (area === 'files' && a && method === 'GET') {
        if (!fullAccess && !(session.kind === 'student' && (await studentFileIds(session.studentId)).has(a))) throw forbidden();
        if (staff && !await staffMayOpenFile(session, a)) throw forbidden();
        const { rows } = await pool.query(`SELECT type, content FROM ${T('stored_files')} WHERE id = $1`, [a]);
        if (!rows.length) return send(res, 404, { error: 'File not found' });
        // A stored file never changes (a new upload gets a new id), so the browser may keep it
        res.writeHead(200, { 'Content-Type': rows[0].type || 'application/octet-stream',
            'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(rows[0].content);
    }

    /* ---------- Staff personal and employment details (administrators only; columns of staff.staff) ---------- */
    if (area === 'staff-details') {
        if (!(setup || admin)) throw forbidden();
        if (method === 'GET' && !a) {
            const { rows } = await pool.query(`SELECT * FROM ${T('staff')} ORDER BY id`);
            return send(res, 200, rows.map(row => ({ id: row.id, ...onlyDetails(recordFromRow(row)) })));
        }
        if (method === 'PUT' && a) {
            const known = await pool.query(`SELECT 1 FROM ${T('staff')} WHERE id = $1`, [a]);
            if (!known.rowCount) return send(res, 404, { error: 'There is no staff member with this id.' });
            const body = await readBody(req) || {};
            const details = {};
            for (const field of STAFF_DETAIL_FIELDS) {
                const value = String(body[field] ?? '').trim();
                if (value.length > 300) throw Object.assign(new Error('One of the details is too long.'), { status: 400 });
                if (value) details[field] = value;
            }
            for (const field of ['dateOfBirth', 'dateEmployed', 'dateLeft']) {
                if (details[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(details[field]) || isNaN(new Date(details[field])))) {
                    throw Object.assign(new Error('A date is not valid.'), { status: 400 });
                }
            }
            // A new photo or signature: checked, stored, and the one it replaces deleted
            const pictures = {};
            for (const field of STAFF_DETAIL_FILES) {
                const file = body[field];
                if (!file || !file.__newFile) continue;
                if (!['image/jpeg', 'image/png'].includes(file.type)) throw Object.assign(new Error('The photo and signature must be JPG or PNG pictures.'), { status: 400 });
                if (String(file.data || '').length * 3 / 4 > STAFF_IMAGE_MAX_BYTES) throw Object.assign(new Error('A picture is larger than 10MB.'), { status: 400 });
                pictures[field] = { __newFile: true, type: file.type, name: String(file.name || field).slice(0, 120), data: String(file.data) };
            }
            // Only the detail columns of this staff member's row change
            const columns = (await tableColumns(pool, 'staff')).map(c => c.name);
            const saved = await inTransaction(async client => {
                const before = onlyDetails(recordFromRow((await client.query(`SELECT * FROM ${T('staff')} WHERE id = $1 FOR UPDATE`, [a])).rows[0]));
                const values = { ...Object.fromEntries(STAFF_DETAIL_FIELDS.map(f => [f, details[f] || null])),
                    detailsUpdatedAt: new Date().toISOString(), detailsUpdatedBy: staff ? session.account.username : '' };
                for (const [field, file] of Object.entries(pictures)) {
                    const stored = await storeNewFiles(client, file);
                    await deleteUnusedFiles(client, before[field], stored);
                    values[field] = JSON.stringify(stored);
                }
                const sets = Object.keys(values).map(f => f.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())).filter(c => columns.includes(c));
                await client.query(`UPDATE ${T('staff')} SET ${sets.map((c, i) => `${sqlName(c)} = $${i + 2}`).join(', ')} WHERE id = $1`,
                    [a, ...sets.map(c => values[snakeToCamel(c)])]);
                return onlyDetails(recordFromRow((await client.query(`SELECT * FROM ${T('staff')} WHERE id = $1`, [a])).rows[0]));
            });
            mirrorChanged(['stored_files', 'staff']);
            return send(res, 200, { ok: true, details: saved });
        }
        // (Deleting a staff member removes their row, details and all, through the accounts list)
        if (method === 'DELETE' && a) return send(res, 200, { ok: true });
    }

    /* ---------- Staff accounts and role rights ---------- */
    if (area === 'values' && method === 'GET' && !a) {
        if (!fullAccess) return send(res, 200, {});
        const values = await getValues();
        const visible = {};
        if (values[ACCOUNTS_KEY]) visible[ACCOUNTS_KEY] = accountsForSession(values[ACCOUNTS_KEY], setup);
        if (values[ROLE_OPERATIONS_KEY]) visible[ROLE_OPERATIONS_KEY] = values[ROLE_OPERATIONS_KEY];
        return send(res, 200, visible); // reset codes never leave the server
    }
    if (area === 'values' && method === 'PUT' && a) {
        if (!(setup || admin)) throw forbidden();
        const body = await readBody(req) || {};
        const value = body.value == null ? null : String(body.value);
        const resetCodeRemoved = a.startsWith(RESET_PREFIX) && value === null;
        if (a.startsWith(RESET_PREFIX) && !resetCodeRemoved) throw forbidden();
        await setValue(a, a === ACCOUNTS_KEY ? await keepPasswords(value, setup) : value);
        if (a === ACCOUNTS_KEY) {
            forgetAccountCount();
            forgetSessions();
        }
        mirrorChanged(valueTables(a));
        return send(res, 200, { ok: true });
    }

    /* ---------- Backups (administrators only) ---------- */
    if (area === 'backups') {
        if (!admin) throw forbidden();
        if (await handleBackupRequest(req, res, method, a, b, session.account.username)) return;
    }

    /* ---------- System Update (administrators only) ---------- */
    if (area === 'system-update') {
        // Every page asks this now and then: the footer's "Last System Update", and whether this person is still
        // logged in (an update logs everyone out)
        if (method === 'GET' && a === 'last') return send(res, 200, { finishedAt: await lastSystemUpdate(), kind: session.kind });
        // The administrator's page keeps following the rocket after the update has logged everyone out
        if (method === 'GET' && a === 'progress' && !admin) return send(res, 200,
            { run: updateRun && { id: updateRun.id, status: updateRun.status, percent: updateRun.percent, step: '', log: [] } });
        if (!admin) throw forbidden();
        if (method === 'GET' && !a) return send(res, 200, await updateInfo(new URL('http://x' + req.url).searchParams.has('check')));
        if (method === 'GET' && a === 'progress') return send(res, 200, { run: updateRun });
        if (method === 'POST' && !a) return send(res, 200,
            { run: await runSystemUpdate(session.account.username, validTimeZone((await readBody(req) || {}).timeZone)) });
    }

    send(res, 404, { error: 'Unknown request' });
}
