/* ---------- FEWA system: backups ----------
   Everything about backups on the server side, in one file:
     - database backups (the daily one and Back Up Now, kept in fewa_backups on the office computer), and restoring them
     - the password-protected zip download
     - uploading corrected students from a downloaded file
   The page for them is backup-page.js. server.mjs calls initBackups once with what these need from it. */
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import path from 'node:path';
import pg from 'pg';
import { ZipWriter, TextReader, Uint8ArrayReader, configure as configureZip } from '@zip.js/zip.js';

let getPool, T, sqlName, SCHEMA_OF, loadConfig, ensureDatabase, root, columnCache, forgetSessions, forgetAccountCount, mirrorChanged, SYNC_ORDER,
    passwordAcceptable, send, readBody, SMALL_BODY_BYTES;
let BACKUP_TABLES, BACKUP_DATA_TABLES;

export function initBackups(from) {
    ({ getPool, T, sqlName, SCHEMA_OF, loadConfig, ensureDatabase, root, columnCache, forgetSessions, forgetAccountCount, mirrorChanged, SYNC_ORDER,
        passwordAcceptable, send, readBody, SMALL_BODY_BYTES } = from);
    BACKUP_TABLES = Object.keys(SCHEMA_OF).filter(t => t !== 'sessions' && t !== 'password_reset_codes');
    BACKUP_DATA_TABLES = BACKUP_TABLES.filter(t => t !== 'stored_files');
}

/* ---------- Backups (Settings > System Data Backups) ----------
   Backups are kept in their own PostgreSQL database on the office computer ("backups" in db-config.json,
   database fewa_backups, table backups.snapshots), never in Supabase, the browser or OneDrive.
   "Back Up Now" copies every table of the main database into one row; the server on the office computer also
   makes one by itself every day. Restoring puts a backup's rows back into the main database (Supabase), after
   first backing up the data as it is. The online server cannot reach this computer, so backups are made and
   restored at http://localhost:5600 on the office computer. */
// What a table was called in older backups
const BACKUP_OLD_NAMES = { staff: 'staff_accounts' };
const BACKUPS_KEPT = 60;
// Uploaded files are kept in their own table of the backups database (one copy of each, however many backups have
// it), so backups keep working however many documents the college has. Backups before Nov 2026 have them in "data".
let backupProblem = ''; // why the last daily backup failed, shown in Settings > System Data Backups
const AUTO_BACKUP_HOURS = 24;
let backupPool = null;
let backupError = 'The daily database backups are made and restored on the office computer: open http://localhost:5600/ there.';

export async function connectBackups() {
    const config = await loadConfig().catch(() => ({}));
    if (!config.backups) return; // online: no backups database
    const backupConfig = { host: 'localhost', port: 5432, user: 'postgres', database: 'fewa_backups', ...config.backups };
    try {
        if (!backupConfig.password) throw new Error('put the password in db-config.json ("backups" > "password").');
        await ensureDatabase(backupConfig);
        const newPool = new pg.Pool({ ...backupConfig, max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
        newPool.on('error', err => console.log(new Date().toLocaleString(), 'Backups database connection lost:', err.message));
        await newPool.query(await readFile(path.join(root, 'database', 'backups', 'backups.sql'), 'utf8'));
        backupPool = newPool;
        backupError = null;
        console.log(`Backups are kept in the PostgreSQL database "${backupConfig.database}" on ${backupConfig.host}:${backupConfig.port}.`);
        autoBackup();
        setInterval(autoBackup, 60 * 60 * 1000);
    } catch (err) {
        backupError = 'The backups database (PostgreSQL on this computer) could not be reached: ' + err.message;
        console.log(new Date().toLocaleString(), '*** ' + backupError + ' Trying again in a minute.');
        setTimeout(connectBackups, 60000);
    }
}

// One backup a day, made by the office computer's server by itself
async function autoBackup() {
    if (!getPool() || !backupPool) return;
    try {
        const { rows } = await backupPool.query(`SELECT max(created_at) AS last FROM backups.snapshots`);
        if (rows[0].last && Date.now() - rows[0].last.getTime() < AUTO_BACKUP_HOURS * 3600000) return;
        await createBackup('automatic', 'Daily automatic backup');
        backupProblem = '';
        console.log(new Date().toLocaleString(), 'Daily automatic backup made.');
    } catch (err) {
        backupProblem = err.message;
        console.log(new Date().toLocaleString(), 'The daily automatic backup could not be made:', err.message);
    }
}

async function createBackup(createdBy, note) {
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
    const tables = BACKUP_DATA_TABLES.map(t => `'${t}', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM ${T(t)} x)`);
    const { rows } = await getPool().query(`SELECT jsonb_build_object(${tables.join(', ')})::text AS data`);

    // The files, listed after the records so every file they mention is there; only new ones are copied, one at a time
    const list = (await getPool().query(`SELECT id, size FROM ${T('stored_files')}`)).rows;
    const known = new Set((await backupPool.query('SELECT id FROM backups.files WHERE id = ANY($1)', [list.map(f => f.id)])).rows.map(r => r.id));
    const included = [];
    let fileBytes = 0;
    for (const entry of list) {
        if (!known.has(entry.id)) {
            const found = await getPool().query(`SELECT id, name, type, size, content, created_at FROM ${T('stored_files')} WHERE id = $1`, [entry.id]);
            if (!found.rows.length) continue; // deleted just now
            const f = found.rows[0];
            await backupPool.query(`INSERT INTO backups.files (id, name, type, size, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING`, [f.id, f.name, f.type, f.size, f.content, f.created_at]);
        }
        included.push(entry.id);
        fileBytes += Number(entry.size) || 0;
    }

    const client = await backupPool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO backups.snapshots (id, created_by, note, data) VALUES ($1, $2, $3, $4::jsonb)`,
            [id, createdBy || null, note || null, rows[0].data]);
        await client.query(`INSERT INTO backups.snapshot_files (snapshot_id, file_id) SELECT $1, unnest($2::text[])`, [id, included]);
        await client.query(`UPDATE backups.snapshots SET size_bytes = pg_column_size(data) + $2::bigint, summary = jsonb_build_object(
                'students', jsonb_array_length(data->'students'), 'documents', jsonb_array_length(data->'documents'),
                'staff', jsonb_array_length(coalesce(data->'staff', data->'staff_accounts', '[]'::jsonb)), 'files', $3::int)
            WHERE id = $1`, [id, fileBytes, included.length]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
    // Only the newest backups are kept
    await backupPool.query(`DELETE FROM backups.snapshots WHERE id NOT IN
        (SELECT id FROM backups.snapshots ORDER BY created_at DESC LIMIT ${BACKUPS_KEPT})`);
    await dropUnusedBackupFiles();
    return { id };
}

const dropUnusedBackupFiles = () => backupPool.query(`DELETE FROM backups.files f
    WHERE NOT EXISTS (SELECT 1 FROM backups.snapshot_files l WHERE l.file_id = f.id)`);

const listBackups = async () => (await backupPool.query(`SELECT id, created_at AS "createdAt", created_by AS "createdBy",
    note, summary, size_bytes AS "sizeBytes" FROM backups.snapshots ORDER BY created_at DESC`)).rows;

async function restoreBackupOnServer(id, by) {
    const found = await backupPool.query(`SELECT jsonb_array_length(coalesce(data->'staff', data->'staff_accounts', '[]'::jsonb)) AS staff,
        created_at FROM backups.snapshots WHERE id = $1`, [id]);
    if (!found.rows.length) return { result: 'none' };
    // A backup without any staff account would leave nobody able to log in
    if (!found.rows[0].staff) return { result: 'no-staff' };
    const safety = await createBackup(by, `Made automatically before restoring the backup of ${found.rows[0].created_at.toISOString()}`);
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        for (const table of BACKUP_TABLES) {
            // Backups made before Nov 2026 have the staff as "staff_accounts"
            const part = async name => (await backupPool.query('SELECT data ? $2 AS has, data->$2 AS part FROM backups.snapshots WHERE id = $1',
                [id, name])).rows[0];
            let saved = await part(table);
            if (!saved.has && BACKUP_OLD_NAMES[table]) saved = await part(BACKUP_OLD_NAMES[table]);
            if (!saved.has && table === 'stored_files') {
                await client.query(`DELETE FROM ${T('stored_files')}`);
                const links = await backupPool.query('SELECT file_id FROM backups.snapshot_files WHERE snapshot_id = $1', [id]);
                for (const { file_id } of links.rows) {
                    const { rows: [f] } = await backupPool.query('SELECT id, name, type, size, content, created_at FROM backups.files WHERE id = $1', [file_id]);
                    await client.query(`INSERT INTO ${T('stored_files')} (id, name, type, size, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                        [f.id, f.name, f.type, f.size, f.content, f.created_at]);
                }
                continue;
            }
            if (!saved.has) continue; // a table that did not exist yet when the backup was made is left as it is
            await client.query(`DELETE FROM ${T(table)}`);
            await client.query(`INSERT INTO ${T(table)} SELECT * FROM jsonb_populate_recordset(NULL::${T(table)}, $1::jsonb)`,
                [JSON.stringify(saved.part)]);
        }
        // ... and the staff's personal details (for a few days in Nov 2026) as "staff_details"
        const oldDetails = (await backupPool.query(`SELECT data->'staff_details' AS part FROM backups.snapshots
            WHERE id = $1 AND data ? 'staff_details' AND NOT data ? 'staff'`, [id])).rows[0];
        if (oldDetails && Array.isArray(oldDetails.part) && oldDetails.part.length) {
            await client.query(`UPDATE ${T('staff')} s SET id_number = d.id_number, gender = d.gender, date_of_birth = d.date_of_birth,
                    department = d.department, date_employed = d.date_employed, address = d.address, next_of_kin_name = d.next_of_kin_name,
                    next_of_kin_relationship = d.next_of_kin_relationship, next_of_kin_phone = d.next_of_kin_phone,
                    details_updated_at = d.updated_at, details_updated_by = d.updated_by
                FROM jsonb_to_recordset($1::jsonb) AS d(id text, id_number text, gender text, date_of_birth date, department text,
                    date_employed date, address text, next_of_kin_name text, next_of_kin_relationship text, next_of_kin_phone text,
                    updated_at timestamptz, updated_by text)
                WHERE d.id = s.id`, [JSON.stringify(oldDetails.part)]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
    columnCache.clear();
    forgetSessions();
    forgetAccountCount();
    mirrorChanged(SYNC_ORDER);
    return { result: 'ok', safetyId: safety.id };
}

async function deleteBackup(id) {
    const { rowCount } = await backupPool.query('DELETE FROM backups.snapshots WHERE id = $1', [id]);
    await dropUnusedBackupFiles();
    return { result: rowCount ? 'ok' : 'none' };
}

/* ---------- Downloaded backups (Settings > System Data Backups): a password-protected zip file ----------
   For the college's own copy, away from this computer. The administrator chooses what to include and the period; the
   zip is made as it is sent (nothing is kept on the server, in Supabase or in the browser). It is AES-256 encrypted,
   so it opens with 7-Zip or WinZip (Windows' own zip tool cannot open it) and only with the password, which is
   not stored anywhere. Each kind of record is a .csv file that opens in Excel; uploaded files are in the "files"
   folder, named by their id so that even the list of names inside the zip tells nobody anything.
   Password details are never included. */
configureZip({ useWebWorkers: false });
const EXPORT_NEVER = new Set(['salt', 'hash', 'login_salt', 'login_hash']);
const EXPORT_SETTINGS = ['schools', 'courses', 'enrollment_types', 'study_sessions', 'school_setup', 'campuses', 'academic_terms',
    'departments', 'student_types', 'student_groups', 'document_types', 'batches', 'staff_roles', 'role_operations', 'fee_payment_details'];
// part -> [table, file in the zip, the date the period looks at]
const EXPORT_PARTS = {
    students: [['students', 'students.csv', 'created_at']],
    applications: [['applications', 'applications.csv', 'submitted_at']],
    documents: [['documents', 'documents.csv', 'uploaded_at']],
    deferrals: [['deferrals', 'deferrals.csv', 'start_date']],
    staff: [['staff', 'staff.csv', null]],
    settings: EXPORT_SETTINGS.map(table => [table, `settings/${table}.csv`, null])
};
let downloadRunning = false;

function csvCell(value) {
    let text;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = value.__file ? value.__file : JSON.stringify(value);
    else text = String(value);
    // Text from the public form must not act as a formula when opened in Excel (phone numbers like +2547... are fine)
    if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d\s.-]*$/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function csvOf(rows, columns) {
    const names = columns.filter(c => !EXPORT_NEVER.has(c));
    return '\uFEFF' + [names.map(csvCell).join(','), ...rows.map(row => names.map(n => csvCell(row[n])).join(','))].join('\r\n') + '\r\n';
}

const zippedFileName = (id, name) => 'files/' + id + (/^\.[a-z0-9]{1,8}$/i.test(path.extname(String(name || ''))) ? path.extname(String(name)).toLowerCase() : '');

/* The system's own program files, for the zip. Only the kinds of file listed here are taken, so nothing else that
   is in the folder can slip in; the passwords (db-config.json) and this computer's notes are refused by name too. */
const CODE_KINDS = new Set(['.html', '.js', '.mjs', '.css', '.sql', '.bat', '.yml', '.yaml', '.md']);
const CODE_NAMES = new Set(['package.json', 'package-lock.json', 'db-config.example.json', '.gitignore', 'fewa-logo.jpg', 'logo.jpeg']);
const CODE_NEVER = new Set(['db-config.json', 'claude.md']);
const CODE_SKIP_FOLDERS = new Set(['node_modules', '.git', '.claude', '.vscode']);

export async function codeFiles(folder = root, prefix = '') {
    const found = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const name = entry.name, lower = name.toLowerCase();
        if (entry.isDirectory()) {
            if (!CODE_SKIP_FOLDERS.has(lower)) found.push(...await codeFiles(path.join(folder, name), prefix + name + '/'));
        } else if (entry.isFile() && !CODE_NEVER.has(lower) && !lower.startsWith('fewa-backup') && (CODE_NAMES.has(lower) || CODE_KINDS.has(path.extname(lower)))) {
            found.push(prefix + name);
        }
    }
    return found.sort();
}

async function sendBackupZip(res, body, by) {
    const problem = message => Object.assign(new Error(message), { status: 400 });
    const password = body.password;
    if (!passwordAcceptable(password)) throw problem('The password must have at least 8 characters.');
    const parts = (Array.isArray(body.include) ? body.include : []).filter(p => p === 'files' || p === 'code' || EXPORT_PARTS[p]);
    if (!parts.length) throw problem('Choose at least one thing to include.');
    const day = text => /^\d{4}-\d{2}-\d{2}$/.test(String(text || '')) && !isNaN(new Date(text));
    const ranged = !!(body.from || body.to);
    if (ranged && (!day(body.from) || !day(body.to))) throw problem('Choose both dates of the period.');
    if (ranged && body.from > body.to) throw problem('The first date of the period is after the last one.');
    if (downloadRunning) throw Object.assign(new Error('Another backup is being prepared. Please try again in a minute.'), { status: 429 });
    downloadRunning = true;
    try {
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="FEWA-backup-${stamp}.zip"`, 'Cache-Control': 'no-store' });
        const zip = new ZipWriter(Writable.toWeb(res), { password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false });
        const period = column => column && ranged ? { where: ` WHERE ${sqlName(column)} >= $1::date AND ${sqlName(column)} < ($2::date + 1)`, values: [body.from, body.to] } : { where: '', values: [] };
        const added = [];
        for (const part of parts.filter(p => p !== 'files' && p !== 'code')) {
            for (const [table, file, dateColumn] of EXPORT_PARTS[part]) {
                const { where, values } = period(dateColumn);
                const result = await getPool().query(`SELECT * FROM ${T(table)}${where}`, values);
                await zip.add(file, new TextReader(csvOf(result.rows, result.fields.map(f => f.name))));
                added.push(`${file}: ${result.rows.length} row(s)`);
            }
        }
        if (parts.includes('files')) {
            const { where, values } = period('created_at');
            const list = (await getPool().query(`SELECT id, name, type, size, created_at FROM ${T('stored_files')}${where} ORDER BY id`, values)).rows;
            const index = [];
            for (const entry of list) {
                const found = await getPool().query(`SELECT content FROM ${T('stored_files')} WHERE id = $1`, [entry.id]); // one at a time, however many there are
                if (!found.rows.length) continue;
                const inZip = zippedFileName(entry.id, entry.name);
                await zip.add(inZip, new Uint8ArrayReader(new Uint8Array(found.rows[0].content)));
                index.push({ file_in_zip: inZip, original_name: entry.name, type: entry.type, size: entry.size, uploaded: entry.created_at });
            }
            await zip.add('files-list.csv', new TextReader(csvOf(index, ['file_in_zip', 'original_name', 'type', 'size', 'uploaded'])));
            added.push(`files: ${index.length} file(s)`);
        }
        if (parts.includes('code')) {
            const names = await codeFiles();
            for (const name of names) await zip.add('code/' + name, new Uint8ArrayReader(new Uint8Array(await readFile(path.join(root, name)))));
            added.push(`code: ${names.length} program file(s)`);
        }
        await zip.add('READ-ME.txt', new TextReader(`FEWA system backup, made ${new Date().toISOString()} by ${by}.\r\n` +
            `Period: ${ranged ? `${body.from} to ${body.to}` : 'all records'}.\r\n\r\n${added.join('\r\n')}\r\n`));
        await zip.close();
        if (!res.writableEnded) res.end();
        console.log(new Date().toLocaleString(), `A password-protected backup was downloaded by ${by}.`);
    } catch (err) {
        console.log(new Date().toLocaleString(), 'The backup download failed:', err.message);
        // Part of the file has gone out already: stop, so the page reports a failure instead of saving a damaged zip
        res.destroy();
    } finally {
        downloadRunning = false;
    }
}

/* ---------- Uploading corrected students (office computer only) ----------
   An administrator takes students.csv from a downloaded backup, corrects it in Excel and uploads it. Nothing is saved
   until they have seen exactly what will change. Saving first makes a database backup, only adds or updates students
   (a student missing from the file stays as they are), and only touches the columns listed here: the admission number,
   logins, status and photo can't be changed this way. Row problems stop the whole file, so it is all or nothing. */
const UPLOAD_BODY_BYTES = 5 * 1024 * 1024;
const UPLOAD_MAX_ROWS = 5000;
const UPLOAD_COLUMNS = new Set(['first_name', 'middle_name', 'last_name', 'gender', 'dob', 'email', 'id_birth_cert', 'phone', 'postal_address',
    'nationality', 'passport_no', 'specialization', 'father_first_name', 'father_last_name', 'father_phone', 'father_email', 'father_occupation',
    'mother_first_name', 'mother_last_name', 'mother_phone', 'mother_email', 'mother_occupation', 'guardian_first_name', 'guardian_last_name',
    'guardian_phone', 'guardian_email', 'guardian_occupation', 'emergency_name', 'emergency_relationship', 'emergency_phone', 'emergency_alt_phone',
    'emergency_email', 'emergency_address', 'campus', 'admission_course', 'study_session', 'enrollment', 'student_type', 'group']);

function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const separator = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ','; // Excel in some countries uses ;
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch !== '"') cell += ch;
            else if (text[i + 1] === '"') { cell += '"'; i++; }
            else quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === separator) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

const validDay = text => { const d = new Date(text + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === text; };

// What a cell means for a column: { value } (null = empty), or { error }. current: what the student has now.
function readCell(column, raw, current, courses) {
    let text = String(raw).trim();
    if (/^'[=+\-@]/.test(text)) text = text.slice(1); // the mark the download puts in front of formula-like text
    if (text.length > 500) return { error: 'is too long' };
    if (text === '') return { value: null };
    if (/^-?\d(\.\d+)?e\+?\d+$/i.test(text)) return { error: `was changed by Excel into "${text}". Format the column as Text and type it again` };
    if (column.includes('phone')) {
        const digits = text.replace(/[\s-]/g, '');
        const kenyan = digits.match(/^(?:\+?254|0)?([17]\d{8})$/);
        if (kenyan) return { value: '+254' + kenyan[1] };
        if (/^\+\d{9,15}$/.test(digits)) return { value: digits };
        if (current && String(current).replace(/^\+/, '') === digits) return { value: current }; // Excel dropped the +
        return { error: `"${text}" is not a valid phone number` };
    }
    if (column.includes('email')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? { value: text } : { error: `"${text}" is not a valid email address` };
    if (column === 'gender') return ['FEMALE', 'MALE'].includes(text.toUpperCase()) ? { value: text.toUpperCase() } : { error: 'must be FEMALE or MALE' };
    if (column === 'admission_course' && !courses.includes(text)) return { error: `"${text}" is not a course in Settings` };
    if (column === 'dob') {
        const day = value => !validDay(value) ? { error: `"${text}" is not a real date` }
            : value > new Date().toISOString().slice(0, 10) ? { error: 'is in the future' } : { value };
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return day(text);
        const parts = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
        if (!parts) return { error: `"${text}" is not a date: write it as YYYY-MM-DD` };
        const pad = n => n.padStart(2, '0');
        const dayFirst = `${parts[3]}-${pad(parts[2])}-${pad(parts[1])}`, monthFirst = `${parts[3]}-${pad(parts[1])}-${pad(parts[2])}`;
        if (current === dayFirst || current === monthFirst) return { value: current }; // Excel only showed the same date differently
        if (dayFirst === monthFirst || Number(parts[2]) > 12) return day(dayFirst === monthFirst ? dayFirst : monthFirst);
        if (Number(parts[1]) > 12) return day(dayFirst);
        return { error: `"${text}" could be two different dates: write it as YYYY-MM-DD` };
    }
    return { value: text };
}

async function uploadPlan(csv) {
    const bad = message => Object.assign(new Error(message), { status: 400 });
    if (typeof csv !== 'string' || !csv.trim()) throw bad('The file is empty.');
    if (csv.includes('\uFFFD')) throw bad('Some letters in this file could not be read. In Excel use Save As and choose "CSV UTF-8".');
    const rows = parseCsv(csv).filter(r => r.some(c => String(c).trim() !== ''));
    if (rows.length < 2) throw bad('This file has no student rows.');
    if (rows.length - 1 > UPLOAD_MAX_ROWS) throw bad(`A file can have at most ${UPLOAD_MAX_ROWS} students.`);
    const header = rows[0].map(h => String(h).trim().toLowerCase());
    if (!header.includes('id') || !header.includes('adm_no')) throw bad('This is not the students.csv file from a FEWA backup (it needs the id and adm_no columns).');
    const at = name => header.indexOf(name);
    const columns = header.filter(h => UPLOAD_COLUMNS.has(h));
    const { rows: students } = await getPool().query(`SELECT * FROM ${T('students')}`);
    const courses = (await getPool().query(`SELECT name FROM ${T('courses')}`)).rows.map(r => r.name);
    const byId = new Map(students.map(row => [row.id, row]));
    const admNos = new Map(students.filter(row => row.adm_no).map(row => [row.adm_no.trim().toLowerCase(), row.id]));
    const fullName = row => [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
    const errors = [], changes = [], adds = [], seen = new Set();
    let unchanged = 0;
    rows.slice(1).forEach((cells, index) => {
        const line = index + 2; // the row number Excel shows
        const cell = name => (at(name) >= 0 && cells[at(name)] !== undefined ? cells[at(name)] : '');
        const id = String(cell('id')).trim();
        const admNo = String(cell('adm_no')).trim();
        const fail = message => errors.push(`Row ${line}${admNo ? ` (${admNo})` : ''}: ${message}`);
        if (id) {
            const current = byId.get(id);
            if (!current) return fail('there is no student with this id. Leave id empty to add a new student.');
            if (seen.has(id)) return fail('this student is in the file twice.');
            seen.add(id);
            if (admNo !== String(current.adm_no ?? '').trim()) return fail('the admission number cannot be changed here.');
            const fields = [];
            for (const column of columns) {
                const now = current[column] ?? null;
                const read = readCell(column, cell(column), now, courses);
                if (read.error) fail(`${column.replace(/_/g, ' ')} ${read.error}.`);
                else if ((read.value ?? '') !== (now ?? '')) fields.push({ column, from: now ?? '', to: read.value ?? '' });
            }
            if (!fields.length) unchanged++;
            else changes.push({ id, admNo, name: fullName(current), fields });
            return;
        }
        if (!admNo) return fail('a new student needs an admission number.');
        const key = admNo.toLowerCase();
        if (admNos.has(key)) return fail('this admission number is already used.');
        admNos.set(key, 'new');
        const values = {};
        for (const column of columns) {
            const read = readCell(column, cell(column), null, courses);
            if (read.error) fail(`${column.replace(/_/g, ' ')} ${read.error}.`);
            else if (read.value !== null) values[column] = read.value;
        }
        if (!values.first_name || !values.last_name) return fail('a new student needs a first name and a surname.');
        adds.push({ admNo, name: fullName(values), values });
    });
    const planId = createHash('sha256').update(JSON.stringify({ changes, adds })).digest('hex');
    const ignored = rows[0].map(h => String(h).trim()).filter(h => h && !UPLOAD_COLUMNS.has(h.toLowerCase()) && !['id', 'adm_no'].includes(h.toLowerCase()));
    return { planId, total: rows.length - 1, unchanged, changes, adds, errors: errors.slice(0, 200), errorCount: errors.length, ignored };
}

async function applyUpload(csv, planId, by) {
    const plan = await uploadPlan(csv);
    if (plan.errorCount) throw Object.assign(new Error('The file still has problems, so nothing was saved.'), { status: 400 });
    if (plan.planId !== planId) throw Object.assign(new Error('Student records changed since this file was checked, so nothing was saved. Please check the file again.'), { status: 409 });
    if (!plan.changes.length && !plan.adds.length) return { result: 'nothing' };
    const safety = await createBackup(by, 'Made automatically before uploading corrected students');
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        for (const { id, fields } of plan.changes) {
            const sets = fields.map((f, i) => `${sqlName(f.column)} = $${i + 2}`);
            await client.query(`UPDATE ${T('students')} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...fields.map(f => f.to === '' ? null : f.to)]);
        }
        for (const { admNo, values } of plan.adds) {
            const names = Object.keys(values);
            const id = 'up-' + Date.now().toString(36) + randomBytes(4).toString('hex');
            await client.query(`INSERT INTO ${T('students')} (id, adm_no, active_student, created_at, updated_at, ${names.map(sqlName).join(', ')})
                VALUES ($1, $2, 'yes', now(), now(), ${names.map((_, i) => '$' + (i + 3)).join(', ')})`, [id, admNo, ...names.map(n => values[n])]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
    mirrorChanged(['students']);
    console.log(new Date().toLocaleString(), `Students uploaded by ${by}: ${plan.changes.length} updated, ${plan.adds.length} added.`);
    return { result: 'ok', updated: plan.changes.length, added: plan.adds.length, safetyId: safety.id };
}

/* ---------- The requests from Settings > System Data Backups (administrators only: checked in server.mjs) ---------- */
export async function handleBackupRequest(req, res, method, a, b, by) {
    if (method === 'POST' && a === 'download') {
        await sendBackupZip(res, await readBody(req, SMALL_BODY_BYTES) || {}, by);
        return true;
    }
    if (method === 'GET' && !a) {
        send(res, 200, backupPool ? { available: true, backups: await listBackups(), problem: backupProblem } : { available: false, reason: backupError, backups: [] });
        return true;
    }
    if (!backupPool) { send(res, 503, { error: backupError }); return true; }
    if (method === 'POST' && a === 'upload' && (b === 'check' || b === 'apply')) {
        const body = await readBody(req, UPLOAD_BODY_BYTES) || {};
        send(res, 200, b === 'check' ? await uploadPlan(body.csv) : await applyUpload(body.csv, body.planId, by));
        return true;
    }
    if (method === 'POST' && !a) { send(res, 200, await createBackup(by, String((await readBody(req) || {}).note || '').slice(0, 200))); return true; }
    if (method === 'POST' && a && b === 'restore') { send(res, 200, await restoreBackupOnServer(a, by)); return true; }
    if (method === 'DELETE' && a) { send(res, 200, await deleteBackup(a)); return true; }
    return false;
}

export async function updateBackupTables() {
    if (!backupPool) return false;
    await backupPool.query(await readFile(path.join(root, 'database', 'backups', 'backups.sql'), 'utf8'));
    return true;
}
