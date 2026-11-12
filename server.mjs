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
     settings.courses, schools, enrollment_types, study_sessions, campuses, academic_terms, departments,
     student_types, student_groups, document_types, reg_number_sequences, short_courses, award_types, staff_roles
                         one row per item of that Settings list, in the order shown (position)
     settings.school_setup, finance.fee_payment_details
                         the single row of that Settings form
     settings.role_operations    the rights given to each staff role
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
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initBackups, connectBackups, updateBackupTables, handleBackupRequest } from './backups.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.argv[2] || 5600);
// On a hosting service (PORT is set) the server must accept connections from outside; on this computer only from itself
const listenAddress = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
const MAX_BODY_BYTES = 60 * 1024 * 1024; // a record with a large document, sent as base64 (logged-in staff only)
const SMALL_BODY_BYTES = 64 * 1024; // logging in and password resets: only a few words
const APPLY_BODY_BYTES = 30 * 1024 * 1024; // the online form: four files of up to 5MB each, sent as base64

/* ---------- Static files: only the system's pages, scripts, styles and images ---------- */
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

async function serveStatic(req, res, file) {
    if (file === '/') file = '/login.html';
    const full = path.join(root, file);
    // Never anything outside this folder, inside node_modules, or of another kind (db-config.json, backups, server code)
    const inside = full.startsWith(root + path.sep) && !full.slice(root.length).toLowerCase().includes('node_modules');
    const type = types[path.extname(full).toLowerCase()];
    if (!inside || !type) return send(res, 404, 'Not found: ' + file, 'text/plain; charset=utf-8');
    try {
        const body = await readFile(full);
        // Always check for a newer file, so changes show with a normal refresh. The file's fingerprint (ETag) lets
        // the browser keep its copy: an unchanged file is answered with "not modified" instead of being sent again.
        const etag = '"' + createHash('sha1').update(body).digest('base64url') + '"';
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'ETag': etag });
        res.end(body);
    } catch {
        send(res, 404, 'Not found: ' + file, 'text/plain; charset=utf-8');
    }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

/* ---------- Database connection ---------- */
// Date columns come back as the text YYYY-MM-DD (as the pages use them), not as a JavaScript date
pg.types.setTypeParser(1082, value => value);

async function loadConfig() {
    // Online (e.g. on Azure App Service) the database address and password come from the DATABASE_URL setting,
    // e.g. postgresql://postgres.xxxx:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
    // Small slips when typing it in a hosting dashboard are forgiven: spaces or small letters in the name,
    // "DATABASE_URL=" or quotes pasted in front of the value
    const urlKey = Object.keys(process.env).find(k => k.trim().toUpperCase() === 'DATABASE_URL');
    const databaseUrl = urlKey && process.env[urlKey].trim().replace(/^DATABASE_URL\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
    if (databaseUrl) {
        let url;
        try { url = new URL(databaseUrl); } catch {
            throw new Error('DATABASE_URL is not a valid address. It must start with postgresql:// (check it in the hosting dashboard).');
        }
        // Encrypted (as Supabase needs) unless the address ends in ?sslmode=disable
        const ssl = url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: false };
        url.searchParams.delete('sslmode');
        return {
            connectionString: url.toString(), ssl,
            host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)) || 'postgres'
        };
    }
    // Online (Render, Azure...) there is no db-config.json: the hosting's DATABASE_URL setting is missing
    if (process.env.PORT && !existsSync(path.join(root, 'db-config.json'))) {
        // Names only (never values), to spot a mistyped setting
        const similar = Object.keys(process.env).filter(k => /DATA|URL|POSTGRES|SUPA|DB/i.test(k) && !/^RENDER_/.test(k));
        throw new Error('DATABASE_URL is not set. In the hosting dashboard (Render: the service > Environment) add ' +
            'DATABASE_URL with the Supabase address and password, then "Save, rebuild, and deploy".' +
            (urlKey ? ' (DATABASE_URL is there but empty.)' : '') +
            (similar.length ? ' Similar settings found: ' + similar.join(', ') + '.' : ' No similar setting was found.'));
    }
    let config;
    try {
        // (a "BOM" mark that Notepad may put at the start is ignored)
        config = JSON.parse((await readFile(path.join(root, 'db-config.json'), 'utf8')).replace(/^﻿/, ''));
    } catch (err) {
        throw new Error('db-config.json is missing or not valid JSON (' + err.message + ').');
    }
    if (!config.password) throw new Error('Put the PostgreSQL password in db-config.json ("password").');
    return { host: 'localhost', port: 5432, user: 'postgres', database: 'fewa_college', ...config };
}

// Creates the database the first time (connecting to the built-in "postgres" database to do it).
// Hosted databases (e.g. Supabase) use the "postgres" database itself, which is always there.
async function ensureDatabase(config) {
    if (config.database === 'postgres') return;
    const admin = new pg.Client({ ...config, database: 'postgres' });
    await admin.connect();
    try {
        const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.database]);
        if (!found.rowCount) {
            await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(config.database)} ENCODING 'UTF8'`);
            console.log(`Created the PostgreSQL database "${config.database}".`);
        }
    } finally {
        await admin.end();
    }
}

let pool = null;
let databaseError = null;
// On the office computer a restart means logging in again: logins from before it no longer count here. (They stay in
// the database, so people using the online system are not affected. Online, Render restarts whenever it has slept,
// so this is off there.)
let sessionsValidFrom = null;

async function inTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/* ---------- Tables with one column per field ----------
   Record field  <->  column:  admNo <-> adm_no,  firstName <-> first_name,  group <-> "group".
   The columns are read from the database itself (every 15 seconds at most), so columns added, removed or
   renamed in pgAdmin are followed. "extra" holds the fields that have no column; "position" is the server's own. */
const COLUMN_TABLES = ['students', 'documents', 'deferrals', 'applications', 'staff'];
const SERVER_COLUMNS = new Set(['extra', 'position']);
const COLUMNS_FRESH_MS = 15000;

const snakeToCamel = name => name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
const sqlName = name => pg.escapeIdentifier(name);

/* ---------- Schemas: the tables are grouped by area (folders under Schemas in pgAdmin) ----------
   Each schema's tables are defined in database/<n>-<schema>.sql. */
const SCHEMA_OF = {
    students: 'students', documents: 'students', deferrals: 'students', applications: 'students',
    settings: 'settings', schools: 'settings', courses: 'settings', enrollment_types: 'settings',
    study_sessions: 'settings', school_setup: 'settings', campuses: 'settings', academic_terms: 'settings',
    departments: 'settings', student_types: 'settings', student_groups: 'settings', document_types: 'settings', system_updates: 'settings',
    reg_number_sequences: 'settings', short_courses: 'settings', award_types: 'settings',
    fee_payment_details: 'finance',
    staff_roles: 'settings', role_operations: 'settings',
    staff: 'staff',
    sessions: 'logins', password_reset_codes: 'logins',
    stored_files: 'files'
};
const SCHEMAS = [...new Set(Object.values(SCHEMA_OF))];
// A table's full name, e.g. T('courses') -> "settings"."courses"
const T = table => `${sqlName(SCHEMA_OF[table])}.${sqlName(table)}`;

const columnCache = new Map();
async function tableColumns(db, table, fresh = false) {
    const cached = columnCache.get(table);
    if (!fresh && cached && Date.now() - cached.at < COLUMNS_FRESH_MS) return cached.columns;
    const { rows } = await db.query(`SELECT column_name AS name, data_type AS type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER'
        ORDER BY ordinal_position`, [SCHEMA_OF[table], table]);
    columnCache.set(table, { at: Date.now(), columns: rows });
    return rows;
}

// A record's value as the column's type wants it
function toColumnValue(value, type) {
    if (value === undefined || value === null) return null;
    if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
    if (type === 'text' || type === 'character varying' || type === 'character') {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return value;
        return value === '' ? null : ['true', 'yes', '1'].includes(String(value).toLowerCase());
    }
    if (value === '') return null; // an empty date or number is "none"
    return typeof value === 'object' ? JSON.stringify(value) : value;
}

// { column: value } for every column of the table (a field the record does not have becomes NULL)
function rowFromRecord(columns, record) {
    const byField = new Map(columns.filter(c => !SERVER_COLUMNS.has(c.name)).map(c => [snakeToCamel(c.name), c]));
    const values = {};
    const extra = {};
    for (const [field, value] of Object.entries(record)) {
        const column = byField.get(field);
        if (column) values[column.name] = toColumnValue(value, column.type);
        else if (value !== undefined) extra[field] = value;
    }
    for (const column of byField.values()) if (!(column.name in values)) values[column.name] = null;
    if (columns.some(c => c.name === 'extra')) values.extra = JSON.stringify(extra);
    return values;
}

// The record a row stands for (empty columns are left out, as missing fields)
function recordFromRow(row) {
    const record = { ...(row.extra && typeof row.extra === 'object' ? row.extra : {}) };
    for (const [name, value] of Object.entries(row)) {
        if (SERVER_COLUMNS.has(name) || value === null) continue;
        record[snakeToCamel(name)] = value instanceof Date ? value.toISOString() : value;
    }
    return record;
}

async function upsertRow(db, table, key, values) {
    const names = Object.keys(values);
    const updates = names.filter(n => n !== key).map(n => `${sqlName(n)} = EXCLUDED.${sqlName(n)}`);
    await db.query(`INSERT INTO ${T(table)} (${names.map(sqlName).join(', ')})
        VALUES (${names.map((_, i) => '$' + (i + 1)).join(', ')})
        ON CONFLICT (${sqlName(key)}) DO ${updates.length ? 'UPDATE SET ' + updates.join(', ') : 'NOTHING'}`,
        names.map(n => values[n]));
}

// Many rows in one trip to the database (a column a row does not have gets its default); a later row with the same
// key replaces an earlier one, as saving them one by one did
async function upsertRows(db, table, key, rowsList) {
    const byKey = new Map(rowsList.map(r => [String(r[key]), r]));
    const list = [...byKey.values()];
    if (!list.length) return;
    const names = [...new Set(list.flatMap(r => Object.keys(r)))];
    const params = [];
    const tuples = list.map(r => '(' + names.map(n => {
        if (!(n in r)) return 'DEFAULT';
        params.push(r[n]);
        return '$' + params.length;
    }).join(', ') + ')');
    const updates = names.filter(n => n !== key).map(n => `${sqlName(n)} = EXCLUDED.${sqlName(n)}`);
    await db.query(`INSERT INTO ${T(table)} (${names.map(sqlName).join(', ')}) VALUES ${tuples.join(', ')}
        ON CONFLICT (${sqlName(key)}) DO ${updates.length ? 'UPDATE SET ' + updates.join(', ') : 'NOTHING'}`, params);
}

/* ---------- Setting up the tables ---------- */
// Tables from the first version kept each record whole in a "data" column. Their records are taken out and the
// table removed, so fewa-tables.sql creates it again with one column per field; the records then go back in.
async function takeOldLayoutRows(client) {
    const old = {};
    for (const table of COLUMN_TABLES) {
        const columns = await tableColumns(client, table, true);
        if (!columns.some(c => c.name === 'data')) continue;
        const order = columns.some(c => c.name === 'position') ? ' ORDER BY position' : '';
        old[table] = (await client.query(`SELECT data FROM ${T(table)}${order}`)).rows.map(r => r.data);
        await client.query(`DROP TABLE ${T(table)}`);
        console.log(`Changing the "${table}" table to one column per field (${old[table].length} row(s) kept).`);
    }
    return old;
}

// Tables that an earlier version created in "public" are moved into their schema (with their rows)
async function moveTablesOutOfPublic(client) {
    for (const schema of SCHEMAS) await client.query(`CREATE SCHEMA IF NOT EXISTS ${sqlName(schema)}`);
    const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [Object.keys(SCHEMA_OF)]);
    for (const { tablename } of rows) {
        const exists = await client.query('SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
            [SCHEMA_OF[tablename], tablename]);
        if (exists.rowCount) continue; // already there; the copy in public is left alone
        await client.query(`ALTER TABLE public.${sqlName(tablename)} SET SCHEMA ${sqlName(SCHEMA_OF[tablename])}`);
        console.log(`Moved the "${tablename}" table into the "${SCHEMA_OF[tablename]}" schema.`);
    }
}

// The table definitions: every database/*.sql file, in name order (1-students.sql, 2-settings.sql, ...)
async function tableDefinitions() {
    const folder = path.join(root, 'database');
    const files = (await readdir(folder)).filter(f => f.toLowerCase().endsWith('.sql')).sort();
    return Promise.all(files.map(f => readFile(path.join(folder, f), 'utf8')));
}

// Changing the tables can collide with something else using them at that moment (the online server, or a page
// saving): PostgreSQL then cancels one side with "deadlock detected". Nothing was changed, so it simply tries again.
const TABLE_UPDATE_TRIES = 5;
async function setUpTables(client) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await setUpTablesOnce(client);
        } catch (err) {
            if (attempt >= TABLE_UPDATE_TRIES || !['40P01', '40001'].includes(err.code)) throw err;
            console.log(new Date().toLocaleString(), `Updating the tables collided with other work (${err.message}): trying again.`);
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
    }
}

async function setUpTablesOnce(client) {
    const definitions = await tableDefinitions();
    await client.query('BEGIN');
    try {
        await moveTablesOutOfPublic(client);
        const old = await takeOldLayoutRows(client);
        for (const sql of definitions) await client.query(sql);
        columnCache.clear();
        for (const [table, records] of Object.entries(old)) {
            for (const [position, record] of records.entries()) {
                const values = rowFromRecord(await tableColumns(client, table), record);
                if (table === 'staff') {
                    values.id = String(record.id || record.username);
                    values.position = position;
                }
                await upsertRow(client, table, 'id', values);
            }
        }
        await moveSettingsIntoTables(client);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    }
}

/* Staying connected: the pool opens connections as they are needed, so after the internet drops or Supabase
   closes an idle connection, the next request simply opens a new one. A connection lost while idle is only
   reported in this window; it never stops the server. */
async function startDatabase() {
    const config = await loadConfig(); // read again on every try, so a corrected password is picked up
    await ensureDatabase(config);
    const newPool = new pg.Pool({
        ...config,
        max: 10,
        connectionTimeoutMillis: 15000, // give up on a connection attempt after 15 seconds
        idleTimeoutMillis: 30000, // close unused connections before the pooler drops them
        keepAlive: true
    });
    newPool.on('error', err => console.log(new Date().toLocaleString(), 'A database connection was lost (a new one opens when needed):', err.message));
    try {
        const client = await newPool.connect();
        try {
            await setUpTables(client);
        } finally {
            client.release();
        }
    } catch (err) {
        await newPool.end().catch(() => { });
        throw err;
    }
    const firstConnection = !pool;
    if (firstConnection && !process.env.PORT) sessionsValidFrom = (await newPool.query('SELECT now() AS at')).rows[0].at;
    pool = newPool;
    databaseError = null;
    console.log(`Connected to PostgreSQL: database "${config.database}" on ${config.host}:${config.port}.`);
    if (firstConnection) {
        startMirror();
        connectBackups();
    }
}

// Keeps trying every 15 seconds until the database answers (e.g. no internet yet, or the Supabase project
// was paused and is waking up); pages show the reason meanwhile
const RETRY_SECONDS = 15;
async function connectDatabase() {
    try {
        await startDatabase();
    } catch (err) {
        databaseError = 'The FEWA server could not connect to the database: ' + err.message +
            ` It tries again every ${RETRY_SECONDS} seconds.`;
        console.log(new Date().toLocaleString(), '*** ' + databaseError);
        console.log('*** Check the internet connection, the password in db-config.json, and that the Supabase project is not paused.');
        setTimeout(connectDatabase, RETRY_SECONDS * 1000);
    }
}

// Anything unexpected is written in this window instead of closing the server
process.on('uncaughtException', err => console.log(new Date().toLocaleString(), 'Unexpected error (the server keeps running):', err));
process.on('unhandledRejection', err => console.log(new Date().toLocaleString(), 'Unexpected error (the server keeps running):', err));

/* ---------- Files inside records ---------- */
const newFileId = () => Date.now().toString(36) + randomBytes(8).toString('hex');

// Stores every new file in the record and puts a reference to it in its place
async function storeNewFiles(client, value) {
    if (Array.isArray(value)) return Promise.all(value.map(v => storeNewFiles(client, v)));
    if (!value || typeof value !== 'object') return value;
    if (value.__newFile) {
        const bytes = Buffer.from(value.data || '', 'base64');
        const id = newFileId();
        await client.query(`INSERT INTO ${T('stored_files')} (id, name, type, size, content) VALUES ($1, $2, $3, $4, $5)`,
            [id, value.name || null, value.type || '', bytes.length, bytes]);
        return { __file: id, type: value.type || '', name: value.name || null, size: bytes.length };
    }
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = await storeNewFiles(client, inner);
    return out;
}

function fileIdsIn(value, ids = new Set()) {
    if (Array.isArray(value)) value.forEach(v => fileIdsIn(v, ids));
    else if (value && typeof value === 'object') {
        if (value.__file) ids.add(value.__file);
        else Object.values(value).forEach(v => fileIdsIn(v, ids));
    }
    return ids;
}

// Files the old version of a record had and the new one no longer uses are deleted
async function deleteUnusedFiles(client, before, after) {
    const keep = fileIdsIn(after);
    const unused = [...fileIdsIn(before)].filter(id => !keep.has(id));
    if (unused.length) await client.query(`DELETE FROM ${T('stored_files')} WHERE id = ANY($1)`, [unused]);
}

/* ---------- Settings: each list and form in its own table ----------
   The pages keep Settings as records in a "settings" store: a list is { key: 'courses', items: [...] } and a
   form is { key: 'organization', collegeName, ... }. Here each list's items are rows of its own table (in the
   order of the list, "position"), each form is the single row of its table, and the "settings" table says
   which table holds each (stored_in). A setting with no table of its own stays whole in settings.data. */
const SETTING_LISTS = {
    courses: 'courses', studySessions: 'study_sessions', enrollmentTypes: 'enrollment_types', schools: 'schools',
    campuses: 'campuses', terms: 'academic_terms', departments: 'departments', studentTypes: 'student_types',
    groups: 'student_groups', documentTypes: 'document_types', roles: 'staff_roles', regSequences: 'reg_number_sequences',
    shortCourses: 'short_courses', awardTypes: 'award_types'
};
const SETTING_FORMS = { organization: 'school_setup', paymentDetails: 'fee_payment_details' };

// The setting record a row of the "settings" table stands for
async function readSetting(db, row) {
    const key = row.key;
    if (row.stored_in && SETTING_LISTS[key]) {
        const { rows } = await db.query(`SELECT * FROM ${T(SETTING_LISTS[key])} ORDER BY position, id`);
        return { ...(row.data || {}), key, items: rows.map(recordFromRow) };
    }
    if (row.stored_in && SETTING_FORMS[key]) {
        const { rows } = await db.query(`SELECT * FROM ${T(SETTING_FORMS[key])} LIMIT 1`);
        const { id, ...fields } = rows.length ? recordFromRow(rows[0]) : {};
        return { ...fields, key };
    }
    return row.data || { key };
}

async function writeSetting(db, record) {
    const key = String(record.key);
    const listTable = SETTING_LISTS[key];
    const formTable = SETTING_FORMS[key];
    if (listTable) {
        const { key: _, items, ...rest } = record;
        const columns = await tableColumns(db, listTable);
        await db.query(`DELETE FROM ${T(listTable)}`);
        // All the items in one go (one by one took a trip to the database each)
        await upsertRows(db, listTable, 'id', (Array.isArray(items) ? items : []).map((item, position) => ({
            ...rowFromRecord(columns, { ...item, id: String(item.id || `${key}-${position + 1}`) }), position })));
        // Anything the list record has besides its items (normally nothing) is kept in settings.data
        await db.query(`INSERT INTO ${T('settings')} (key, stored_in, data, updated_at) VALUES ($1, $2, $3, now())
            ON CONFLICT (key) DO UPDATE SET stored_in = EXCLUDED.stored_in, data = EXCLUDED.data, updated_at = now()`,
            [key, `${SCHEMA_OF[listTable]}.${listTable}`, Object.keys(rest).length ? rest : null]);
    } else if (formTable) {
        const { key: _, ...fields } = record;
        await db.query(`DELETE FROM ${T(formTable)}`);
        await upsertRow(db, formTable, 'id', rowFromRecord(await tableColumns(db, formTable), { ...fields, id: 1 }));
        await db.query(`INSERT INTO ${T('settings')} (key, stored_in, data, updated_at) VALUES ($1, $2, NULL, now())
            ON CONFLICT (key) DO UPDATE SET stored_in = EXCLUDED.stored_in, data = NULL, updated_at = now()`,
            [key, `${SCHEMA_OF[formTable]}.${formTable}`]);
    } else {
        await db.query(`INSERT INTO ${T('settings')} (key, stored_in, data, updated_at) VALUES ($1, NULL, $2, now())
            ON CONFLICT (key) DO UPDATE SET stored_in = NULL, data = EXCLUDED.data, updated_at = now()`, [key, record]);
    }
}

// Removes a setting (its rows too); returns the record it was, or undefined
async function deleteSetting(db, key) {
    const { rows } = await db.query(`SELECT * FROM ${T('settings')} WHERE key = $1`, [key]);
    if (!rows.length) return undefined;
    const record = await readSetting(db, rows[0]);
    const table = rows[0].stored_in && (SETTING_LISTS[key] || SETTING_FORMS[key]);
    if (table) await db.query(`DELETE FROM ${T(table)}`);
    await db.query(`DELETE FROM ${T('settings')} WHERE key = $1`, [key]);
    return record;
}

// Settings saved by the first version (whole in settings.data) are moved into their tables
async function moveSettingsIntoTables(client) {
    const { rows } = await client.query(`SELECT key, data FROM ${T('settings')} WHERE stored_in IS NULL AND data IS NOT NULL`);
    for (const row of rows) {
        if (!SETTING_LISTS[row.key] && !SETTING_FORMS[row.key]) continue;
        await writeSetting(client, { ...row.data, key: row.key });
        console.log(`Moved the "${row.key}" setting into the "${SETTING_LISTS[row.key] || SETTING_FORMS[row.key]}" table.`);
    }
}

/* ---------- Record stores: students, documents, deferrals (columns) and settings (tables above) ---------- */
const STORES = { students: 'id', documents: 'id', deferrals: 'id', applications: 'id', settings: 'key' };
const hasColumns = store => COLUMN_TABLES.includes(store);

async function selectRecords(db, store, id) {
    const key = sqlName(STORES[store]);
    const where = id === undefined ? '' : ` WHERE ${key} = $1`;
    const { rows } = await db.query(`SELECT * FROM ${T(store)}${where} ORDER BY ${key}`, id === undefined ? [] : [id]);
    if (store === 'settings') {
        // A settings table with rows but no row in settings.settings (e.g. courses typed straight into the table
        // in pgAdmin or Supabase) counts as saved too
        const tables = { ...SETTING_LISTS, ...SETTING_FORMS };
        const listed = new Set(rows.map(r => r.key));
        const unlisted = Object.keys(tables).filter(k => !listed.has(k) && (id === undefined || id === k));
        if (unlisted.length) {
            const found = await db.query(unlisted.map((k, i) =>
                `SELECT $${i + 1}::text AS key WHERE EXISTS (SELECT 1 FROM ${T(tables[k])})`).join(' UNION ALL '), unlisted);
            found.rows.forEach(r => rows.push({ key: r.key, stored_in: `${SCHEMA_OF[tables[r.key]]}.${tables[r.key]}`, data: null }));
            rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        }
        // All at once, not one after another (each is a trip to the database, which is online)
        return Promise.all(rows.map(row => readSetting(db, row)));
    }
    return rows.map(recordFromRow);
}

async function writeRecord(db, store, record) {
    if (store === 'settings') return writeSetting(db, record);
    await upsertRow(db, store, STORES[store], rowFromRecord(await tableColumns(db, store), record));
}

// Removes a record; returns the record it was, or undefined
async function removeRecord(db, store, id) {
    if (store === 'settings') return deleteSetting(db, id);
    const { rows } = await db.query(`DELETE FROM ${T(store)} WHERE ${sqlName(STORES[store])} = $1 RETURNING *`, [id]);
    return rows.length ? recordFromRow(rows[0]) : undefined;
}

const getAllRecords = store => selectRecords(pool, store);

async function getRecord(store, id) {
    const [record] = await selectRecords(pool, store, id);
    return record || null;
}

async function putRecord(store, id, record) {
    const key = STORES[store];
    if (!record || typeof record !== 'object' || String(record[key]) !== id) {
        throw Object.assign(new Error(`The record's ${key} must match the address.`), { status: 400 });
    }
    return inTransaction(async client => {
        const [before] = await selectRecords(client, store, id);
        const data = await storeNewFiles(client, record);
        await writeRecord(client, store, data);
        if (before) await deleteUnusedFiles(client, before, data);
        return data;
    });
}

async function deleteRecord(store, id) {
    await inTransaction(async client => {
        const before = await removeRecord(client, store, id);
        if (before) await deleteUnusedFiles(client, before, null);
    });
}

// Restoring a backup: every record is written; without merge, everything else in the store is removed first
async function replaceRecords(store, records, merge) {
    const key = STORES[store];
    await inTransaction(async client => {
        if (!merge) {
            const removed = [];
            for (const before of await selectRecords(client, store)) {
                removed.push(await removeRecord(client, store, String(before[key])));
            }
            const ids = [...fileIdsIn(removed)];
            if (ids.length) await client.query(`DELETE FROM ${T('stored_files')} WHERE id = ANY($1)`, [ids]);
        }
        for (const record of records) {
            if (!record || record[key] == null) continue;
            const id = String(record[key]);
            const [before] = merge ? await selectRecords(client, store, id) : [];
            const data = await storeNewFiles(client, { ...record, [key]: id });
            await writeRecord(client, store, data);
            if (before) await deleteUnusedFiles(client, before, data);
        }
    });
}

/* ---------- Staff accounts, role rights and reset codes ----------
   The pages keep these as text values (as they once were in the browser's localStorage):
   "fewaAccounts" (the list of accounts), "fewaRoleOperations" (rights by role) and
   "fewaPendingReset:<email>" (one reset code). Here each is kept in its own table. */
const ACCOUNTS_KEY = 'fewaAccounts';
/* The staff's personal & employment details, in the same table (staff.staff) as their account. The accounts
   list ("fewaAccounts") goes to every logged-in staff member's browser, so these are never in it: they are
   read and saved only through /api/staff-details (administrators only), and saving the accounts list keeps
   them as they are in the database. */
const STAFF_DETAIL_FIELDS = ['idNumber', 'gender', 'dateOfBirth', 'department', 'dateEmployed', 'address',
    'nextOfKinName', 'nextOfKinRelationship', 'nextOfKinPhone'];
const STAFF_DETAIL_ONLY = [...STAFF_DETAIL_FIELDS, 'detailsUpdatedAt', 'detailsUpdatedBy'];
const withoutDetails = record => Object.fromEntries(Object.entries(record).filter(([field]) => !STAFF_DETAIL_ONLY.includes(field)));
const onlyDetails = record => Object.fromEntries(Object.entries(record).filter(([field]) => STAFF_DETAIL_ONLY.includes(field)));
const ROLE_OPERATIONS_KEY = 'fewaRoleOperations';
const RESET_PREFIX = 'fewaPendingReset:';

async function getValues() {
    const values = {};
    // The three are read at the same time (each is a trip to the database)
    const [accounts, roles, codes] = await Promise.all([
        pool.query(`SELECT * FROM ${T('staff')} ORDER BY position, id`),
        pool.query(`SELECT role, rights FROM ${T('role_operations')}`),
        pool.query(`SELECT email, data FROM ${T('password_reset_codes')}`)]);
    if (accounts.rowCount) values[ACCOUNTS_KEY] = JSON.stringify(accounts.rows.map(row => withoutDetails(recordFromRow(row))));
    if (roles.rowCount) values[ROLE_OPERATIONS_KEY] = JSON.stringify(Object.fromEntries(roles.rows.map(r => [r.role, r.rights])));
    codes.rows.forEach(r => values[RESET_PREFIX + r.email] = JSON.stringify(r.data));
    return values;
}

async function setValue(key, value) {
    const parsed = value == null ? null : JSON.parse(value);
    if (key === ACCOUNTS_KEY) {
        if (parsed !== null && !Array.isArray(parsed)) throw Object.assign(new Error('Accounts must be a list.'), { status: 400 });
        await inTransaction(async client => {
            const saved = new Map((await client.query(`SELECT * FROM ${T('staff')}`)).rows
                .map(row => [String(row.id), onlyDetails(recordFromRow(row))]));
            await client.query(`DELETE FROM ${T('staff')}`);
            const columns = await tableColumns(client, 'staff');
            for (const [position, account] of (parsed || []).entries()) {
                const id = String(account.id || account.username);
                const values = rowFromRecord(columns, { ...withoutDetails(account), ...(saved.get(id) || {}), id });
                values.position = position;
                await upsertRow(client, 'staff', 'id', values);
            }
        });
    } else if (key === ROLE_OPERATIONS_KEY) {
        await inTransaction(async client => {
            await client.query(`DELETE FROM ${T('role_operations')}`);
            for (const [role, rights] of Object.entries(parsed || {})) {
                await client.query(`INSERT INTO ${T('role_operations')} (role, rights) VALUES ($1, $2)`, [role, JSON.stringify(rights)]);
            }
        });
    } else if (key.startsWith(RESET_PREFIX)) {
        const email = key.slice(RESET_PREFIX.length);
        if (parsed === null) await pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [email]);
        else await pool.query(`INSERT INTO ${T('password_reset_codes')} (email, data) VALUES ($1, $2)
            ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`, [email, parsed]);
    } else {
        throw Object.assign(new Error('Unknown value: ' + key), { status: 400 });
    }
}

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
const SESSION_COOKIE = 'fewa_session';
const SESSION_HOURS = 12;
const RESET_GRANT_MINUTES = 10;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;

const sha256 = text => createHash('sha256').update(text).digest('hex');
// Emailed reset codes (and passwords from before scrypt): short-lived, and given only a few tries
const codeHash = (code, salt) => sha256(`${salt}:${code}`);
const scryptAsync = promisify(scrypt);
const SCRYPT_PREFIX = 'scrypt1$';
const scryptHash = async (password, salt) => SCRYPT_PREFIX + (await scryptAsync(String(password), salt, 32, { N: 16384, r: 8, p: 1 })).toString('hex');
async function newPasswordDetails(password) {
    const salt = randomBytes(16).toString('hex');
    return { salt, hash: await scryptHash(password, salt) };
}
function sameText(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
}
const passwordIsOldKind = hash => !String(hash).startsWith(SCRYPT_PREFIX);
const passwordMatches = async (password, salt, hash) =>
    sameText(hash, passwordIsOldKind(hash) ? codeHash(password, salt) : await scryptHash(password, salt));
// The pages ask for more (capital letters and so on); this also stops an empty password sent by other means
const passwordAcceptable = password => typeof password === 'string' && password.length >= 8 && password.length <= 128;

// Someone's other logins end when their password changes (a stolen login must not outlive the new password)
async function endOtherSessions(kind, subject, keepTokenHash = '') {
    await pool.query(`DELETE FROM ${T('sessions')} WHERE kind = $1 AND subject = $2 AND token_hash <> $3`, [kind, String(subject), keepTokenHash]);
    forgetSessions();
}
const lower = text => String(text || '').trim().toLowerCase();

function parseCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const i = part.indexOf('=');
        return i < 0 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }));
}

const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// A request from this computer itself (not through the internet / a hosting proxy)
const isLocalRequest = req => !req.headers['x-forwarded-for'] &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function setSessionCookie(req, res, token, seconds) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}` +
        (isHttps(req) ? '; Secure' : ''));
}

async function createSession(req, res, kind, subject, minutes) {
    const token = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO ${T('sessions')} (token_hash, kind, subject, expires_at, created_at)
        VALUES ($1, $2, $3, now() + make_interval(mins => $4), now())`, [sha256(token), kind, String(subject), minutes]);
    setSessionCookie(req, res, token, minutes * 60);
    // Old sessions are cleared now and then
    if (Math.random() < 0.05) pool.query(`DELETE FROM ${T('sessions')} WHERE expires_at < now()`).catch(() => { });
}

// Sessions are looked up at most every 20 seconds per token (the database may be far away, e.g. Supabase)
const sessionCache = new Map();
const SESSION_CACHE_MS = 20000;
const forgetSessions = () => sessionCache.clear();

// { kind: 'staff', account, admin } | { kind: 'student', studentId } | { kind: 'reset', email } | { kind: null }
async function getSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return { kind: null };
    const tokenHash = sha256(token);
    const cached = sessionCache.get(tokenHash);
    if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.session;
    let session = { kind: null };
    const { rows } = await pool.query(`SELECT kind, subject FROM ${T('sessions')} WHERE token_hash = $1 AND expires_at > now()
        AND ($2::timestamptz IS NULL OR created_at >= $2)`, [tokenHash, sessionsValidFrom]);
    if (rows.length) {
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
    sessionCache.set(tokenHash, { at: Date.now(), session });
    return session;
}

async function endSession(req, res, session) {
    if (session.tokenHash) await pool.query(`DELETE FROM ${T('sessions')} WHERE token_hash = $1`, [session.tokenHash]);
    sessionCache.delete(session.tokenHash);
    setSessionCookie(req, res, '', 0);
}

// No staff account yet: the system is being set up (counted at most every 10 seconds)
let accountCount = { at: 0, count: null };
async function setupNeeded() {
    if (Date.now() - accountCount.at > 10000 || accountCount.count === null) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${T('staff')}`);
        accountCount = { at: Date.now(), count: rows[0].n };
    }
    return accountCount.count === 0;
}
const forgetAccountCount = () => accountCount = { at: 0, count: null };

/* Too many wrong passwords for one username: locked for a while. Counted from one place, and also from everywhere
   together, because the address a request says it comes from can be faked. */
const loginFailures = new Map();
const LOGIN_MAX_FAILURES_EVERYWHERE = 50;
function loginLocked(req, username) {
    const over = (key, limit) => {
        const entry = loginFailures.get(key);
        return !!entry && entry.count >= limit && Date.now() - entry.first < LOGIN_LOCK_MINUTES * 60000;
    };
    return over(clientIp(req) + '|' + lower(username), LOGIN_MAX_FAILURES) || over('everywhere|' + lower(username), LOGIN_MAX_FAILURES_EVERYWHERE);
}
function loginFailed(req, username) {
    if (loginFailures.size > 20000) loginFailures.clear();
    for (const key of [clientIp(req) + '|' + lower(username), 'everywhere|' + lower(username)]) {
        const entry = loginFailures.get(key);
        if (!entry || Date.now() - entry.first > LOGIN_LOCK_MINUTES * 60000) loginFailures.set(key, { count: 1, first: Date.now() });
        else entry.count++;
    }
}

// Staff log in with their email; students with their AdmNo (capital and small letters must match)
async function login(req, res, { username, password } = {}) {
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
async function setOwnPassword(session, password) {
    const account = session.account;
    if (!passwordAcceptable(password)) return { result: 'weak' };
    if (account.hash && await passwordMatches(password, account.salt, account.hash)) return { result: 'same' };
    const { salt, hash } = await newPasswordDetails(password);
    await pool.query(`UPDATE ${T('staff')} SET salt = $1, hash = $2, admin_reset_required = false WHERE id = $3`, [salt, hash, account.id]);
    await endOtherSessions('staff', account.id, session.tokenHash);
    return { result: 'ok' };
}

// A temporary password nobody can guess, made here (no letters or numbers that look alike, e.g. O and 0)
function temporaryPassword() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...randomBytes(10)].map(byte => characters[byte % characters.length]).join('');
}

// A student's Student Portal password: staff (Reset Password, or admitting them) get a new temporary one made here,
// which they must change at their next login; the student themselves chooses their own
async function setStudentPasswordOnServer(session, { studentId, password, mustChange } = {}) {
    if (session.kind === 'student') {
        if (studentId !== session.studentId) throw Object.assign(new Error('Not allowed.'), { status: 403 });
        mustChange = false;
        if (!passwordAcceptable(password)) return { result: 'weak' };
    } else {
        password = temporaryPassword();
        mustChange = true;
    }
    const { rows } = await pool.query(`SELECT login_salt, login_hash FROM ${T('students')} WHERE id = $1`, [String(studentId)]);
    if (!rows.length) return { result: 'none' };
    if (session.kind === 'student' && rows[0].login_hash && await passwordMatches(password, rows[0].login_salt, rows[0].login_hash)) {
        return { result: 'same' };
    }
    const { salt, hash } = await newPasswordDetails(String(password));
    await pool.query(`UPDATE ${T('students')} SET login_salt = $1, login_hash = $2, must_change_password = $3,
        admin_reset_required = false, password_set_at = now(), updated_at = now() WHERE id = $4`,
        [salt, hash, !!mustChange, String(studentId)]);
    await endOtherSessions('student', studentId, session.kind === 'student' ? session.tokenHash : '');
    return session.kind === 'student' ? { result: 'ok' } : { result: 'ok', password };
}

/* ---------- Emails: every email of the system is written and sent here, by the server (through EmailJS) ----------
   A page can only ask for one of the emails below; it never chooses the words or (except for the administrator's
   password link, to a known staff member) who gets it, so nobody can use the system to send emails of their own.
   EmailJS must allow this: Account > Security > "Allow EmailJS API for non-browser applications", and with "Use
   Private Key" on, nobody without that key can send through the account. The private key is kept in the database
   table private_settings.server_keys (read first), the EMAILJS_PRIVATE_KEY setting on Render (Environment), and
   as "emailjsPrivateKey" in this computer's db-config.json; it is never put in the code. */
const PUBLIC_SITE = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://fewa-system.onrender.com').replace(/\/+$/, '');
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

async function sendSystemEmail(to, message) {
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
function resetRequestAllowed(req, username) {
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
async function requestPasswordReset(req, { username } = {}) {
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
async function sendStaffPasswordLink({ email, newStaff } = {}) {
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
async function sendStudentLoginEmail({ studentId, kind, password } = {}) {
    const { rows } = await pool.query(`SELECT * FROM ${T('students')} WHERE id = $1`, [String(studentId)]);
    if (!rows.length) return { result: 'none' };
    const student = recordFromRow(rows[0]);
    if (!looksLikeEmail(student.email)) return { result: 'no-email' };
    if (typeof password !== 'string' || !student.loginHash || !student.mustChangePassword || !await passwordMatches(password, student.loginSalt, student.loginHash)) {
        return { result: 'not-reset' };
    }
    const name = [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ');
    const college = ((await getRecord('settings', 'organization').catch(() => null)) || {}).collegeName || 'FEWA Beauty & Fashion College';
    const link = PUBLIC_SITE + '/login.html';
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
async function sendNewAdminEmail(account) {
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' });
    return sendSystemEmail(account.username, `Your FEWA system administrator account was created and you logged in successfully on ${when}.`);
}

async function verifyResetCodeOnServer(req, res, { email, code } = {}) {
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
async function completeResetOnServer(req, res, session, { password } = {}) {
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
function accountsForSession(text, full) {
    if (full || !text) return text;
    return JSON.stringify(JSON.parse(text).map(({ salt, hash, ...account }) => ({ ...account, hash: hash ? true : null })));
}

// Saving the accounts list: the password details are always the database's, so a page that was open for a while
// can't bring an old password back. Only deactivating an account (hash null, adminResetRequired) cancels one, and
// only first-time setup may bring its own.
async function keepPasswords(text, setup) {
    if (text == null || setup) return text;
    const accounts = JSON.parse(text);
    const { rows } = await pool.query(`SELECT id, salt, hash, admin_reset_required FROM ${T('staff')}`);
    const saved = new Map(rows.map(r => [r.id, r]));
    return JSON.stringify(accounts.map(a => {
        if (!a) return a;
        if (a.hash === null && a.adminResetRequired === true && a.status === 'Inactive') return { ...a, salt: null };
        const row = saved.get(String(a.id));
        return { ...a, salt: row ? row.salt : null, hash: row ? row.hash : null, adminResetRequired: row ? row.admin_reset_required : a.adminResetRequired ?? null };
    }));
}

// Student records going out: never the password details (loginHash: true when a password is set)
function hidePasswords(store, record) {
    if (store !== 'students' || !record || typeof record !== 'object') return record;
    if (Array.isArray(record)) return record.map(r => hidePasswords(store, r));
    const { loginHash, loginSalt, ...rest } = record;
    return loginHash ? { ...rest, loginHash: true } : rest;
}

// A student record coming in: the login details stay the database's (a page open for a while can't bring an old
// password back). Only making a student inactive (loginHash null, adminResetRequired) cancels their password.
async function keepStudentLogin(record) {
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
async function staffCan(session, ...rights) {
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
    'students.password': 'students.edit'
};

/* The rights that allow reading a kind of record (any one of them is enough). They include the work that needs the
   records behind the scenes: adding a student checks for duplicates, deleting one removes their documents, and
   renaming a course in Settings renames it on the students who have it. Settings can be read by all staff. */
const STUDENT_WRITERS = ['students.edit', 'students.applications', 'students.status', 'students.deferrals', 'students.contacts',
    'students.password', 'students.photos'];
const STUDENT_READERS = ['students.view', 'students.add', 'students.edit', 'students.delete', 'documents.view', 'documents.add',
    'finance.view', 'finance.add', 'reports.view', 'reports.excel', 'queries.view', 'settings.edit', 'settings.delete', ...STUDENT_WRITERS];
const RIGHTS_TO_READ = {
    students: STUDENT_READERS,
    deferrals: STUDENT_READERS,
    documents: ['documents.view', 'documents.add', 'students.delete', 'reports.view', 'settings.edit', 'settings.delete'],
    applications: ['students.view', 'students.add', 'students.edit', 'students.applications']
};

// A stored file: someone who may read documents may open any; someone who may only read student records, not an
// uploaded document (a student's photo is fine)
async function staffMayOpenFile(session, fileId) {
    if (await staffCan(session, ...RIGHTS_TO_READ.documents)) return true;
    if (!await staffCan(session, ...STUDENT_READERS)) return false;
    return !fileIdsIn(await selectRecords(pool, 'documents')).has(fileId);
}

// The rights that allow saving or deleting one record (any one of them is enough)
async function rightsToWrite(store, id, method) {
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
async function studentFileIds(studentId) {
    const own = await selectRecords(pool, 'students', studentId);
    const docs = (await selectRecords(pool, 'documents')).filter(d => d.studentId === studentId);
    return fileIdsIn([...own, ...docs]);
}

const forbidden = () => Object.assign(new Error('You are not allowed to do this. Please log in again.'), { status: 403 });

/* ---------- Two-way sync with a second PostgreSQL (the "mirror", e.g. this computer's PostgreSQL 18) ----------
   Set by "mirror" in db-config.json. The main database (e.g. Supabase) is the one the system reads and saves.
   Both databases are kept the same, in both directions: rows added, changed or deleted in either one (in the
   system, in Supabase, or in pgAdmin on the local copy) are made the same in the other.
   - How it knows which side changed: after each sync, a fingerprint of every row is kept in the mirror, in the
     schema fewa_sync. A row that differs from its fingerprint on one side only was changed on that side.
   - Changed on both sides since the last sync: the main database's version is kept.
   - A mirror with no fingerprints yet (new, or recreated) is simply filled from the main database, so an empty
     mirror can never empty the main database.
   - When: 2 seconds after every save in the system, and every 30 seconds for changes made in the databases.
   - If the mirror cannot be reached, the system keeps working and the sync happens once it can. */
const MIRROR_DELAY_MS = 2000;
const MIRROR_FULL_SYNC_MS = 30 * 1000;
const MIRROR_RETRY_MS = 60 * 1000;
const mirrorState = { configured: false, connected: false, lastSync: null, error: '' };
let mirrorPool = null;
let mirrorQueue = Promise.resolve();
let mirrorTimer = null;
const tablesToSync = new Set();

// The tables a save to a store (or a value) changes
const STORE_TABLES = {
    students: ['students', 'stored_files'], documents: ['documents', 'stored_files'], deferrals: ['deferrals'],
    applications: ['applications', 'stored_files'],
    settings: ['settings', ...Object.values(SETTING_LISTS), ...Object.values(SETTING_FORMS)]
};
const valueTables = key => key === ACCOUNTS_KEY ? ['staff']
    : key === ROLE_OPERATIONS_KEY ? ['role_operations'] : ['password_reset_codes'];
// Files first, so a record copied across already finds its photo or document on the other side
// (Login sessions stay in the main database only)
const SYNC_ORDER = ['stored_files', ...Object.keys(SCHEMA_OF).filter(t => t !== 'stored_files' && t !== 'sessions')];
// Each table's key column
const KEY_OF = { settings: 'key', role_operations: 'role', password_reset_codes: 'email' };
const keyOf = table => KEY_OF[table] || 'id';

const SYNC_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS fewa_sync;
COMMENT ON SCHEMA fewa_sync IS 'FEWA system: what was in both databases at the last sync, to tell which side changed. Do not edit.';
CREATE TABLE IF NOT EXISTS fewa_sync.synced_tables (tbl text PRIMARY KEY, synced_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS fewa_sync.fingerprints (tbl text NOT NULL, pk text NOT NULL, hash text NOT NULL, PRIMARY KEY (tbl, pk));`;

async function connectMirror() {
    const config = await loadConfig();
    if (!config.mirror) return null;
    const mirrorConfig = { host: 'localhost', port: 5432, user: 'postgres', database: 'fewa_college', ...config.mirror };
    if (!mirrorConfig.password) throw new Error('Put the password of the mirror database in db-config.json ("mirror" > "password").');
    await ensureDatabase(mirrorConfig);
    const newPool = new pg.Pool({ ...mirrorConfig, max: 4, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000, keepAlive: true });
    newPool.on('error', err => console.log(new Date().toLocaleString(), 'Sync: a connection to the mirror was lost:', err.message));
    try {
        const client = await newPool.connect();
        try {
            await setUpTables(client);
            await client.query(SYNC_SCHEMA);
        } finally {
            client.release();
            columnCache.clear(); // what was read while setting up the mirror is the mirror's, not the main database's
        }
    } catch (err) {
        await newPool.end().catch(() => { });
        throw err;
    }
    console.log(`Sync: keeping database "${mirrorConfig.database}" on ${mirrorConfig.host}:${mirrorConfig.port} the same as the main database.`);
    return newPool;
}

// The columns of a table with their full types, e.g. { name: 'dob', type: 'date' }
async function columnTypes(db, table) {
    const { rows } = await db.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [T(table)]);
    return rows;
}

// A column added on one side (e.g. in pgAdmin) is added on the other too
async function matchColumns(table) {
    const main = await columnTypes(pool, table);
    const mirror = await columnTypes(mirrorPool, table);
    const add = async (db, columns, where) => {
        for (const column of columns) {
            await db.query(`ALTER TABLE ${T(table)} ADD COLUMN IF NOT EXISTS ${sqlName(column.name)} ${column.type}`);
            console.log(`Sync: added the column ${table}.${column.name} (${column.type}) to the ${where} database.`);
        }
    };
    const mainNames = new Set(main.map(c => c.name));
    const mirrorNames = new Set(mirror.map(c => c.name));
    await add(mirrorPool, main.filter(c => !mirrorNames.has(c.name)), 'mirror');
    await add(pool, mirror.filter(c => !mainNames.has(c.name)), 'main');
    if (mirror.some(c => !mainNames.has(c.name))) columnCache.delete(table);
}

const toSqlValue = value => value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)
    ? JSON.stringify(value) : value;

// A row's fingerprint: its values, leaving out empty ones (so a new empty column changes nothing)
function fingerprint(row) {
    const values = Object.keys(row).sort().filter(k => row[k] !== null).map(k => {
        const v = row[k];
        return [k, v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v];
    });
    return createHash('sha1').update(JSON.stringify(values)).digest('hex');
}

// Every row of a table by its key (files without their bytes, which never change once stored)
async function rowsByKey(db, table) {
    const columns = table === 'stored_files' ? 'id, name, type, size, created_at' : '*';
    const { rows } = await db.query(`SELECT ${columns} FROM ${T(table)}`);
    return new Map(rows.map(row => [String(row[keyOf(table)]), row]));
}

// Makes the target's rows with these keys the same as the source's (deleting those the source does not have)
async function applyRows(source, target, table, keys) {
    if (!keys.length) return;
    const key = keyOf(table);
    const { rows } = await source.query(`SELECT * FROM ${T(table)} WHERE ${sqlName(key)}::text = ANY($1)`, [keys]);
    const client = await target.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${T(table)} WHERE ${sqlName(key)}::text = ANY($1)`, [keys]);
        for (const row of rows) {
            const names = Object.keys(row);
            await client.query(`INSERT INTO ${T(table)} (${names.map(sqlName).join(', ')})
                VALUES (${names.map((_, i) => '$' + (i + 1)).join(', ')})`, names.map(n => toSqlValue(row[n])));
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

async function syncTable(table) {
    await matchColumns(table);
    const main = await rowsByKey(pool, table);
    const mirror = await rowsByKey(mirrorPool, table);
    const known = (await mirrorPool.query('SELECT 1 FROM fewa_sync.synced_tables WHERE tbl = $1', [table])).rowCount > 0;
    const saved = new Map((await mirrorPool.query('SELECT pk, hash FROM fewa_sync.fingerprints WHERE tbl = $1', [table]))
        .rows.map(r => [r.pk, r.hash]));

    const toMirror = [];
    const toMain = [];
    const result = new Map(); // key -> fingerprint after this sync
    for (const key of new Set([...main.keys(), ...mirror.keys()])) {
        const m = main.has(key) ? fingerprint(main.get(key)) : null;
        const r = mirror.has(key) ? fingerprint(mirror.get(key)) : null;
        const s = known ? (saved.get(key) ?? null) : undefined;
        if (m === r) {
            if (m) result.set(key, m);
        } else if (known && m === s) {
            toMain.push(key); // changed (or added, or deleted) only in the mirror
            if (r) result.set(key, r);
        } else {
            toMirror.push(key); // changed only in the main database, changed on both (main wins), or first sync
            if (m) result.set(key, m);
        }
    }
    await applyRows(pool, mirrorPool, table, toMirror);
    await applyRows(mirrorPool, pool, table, toMain);
    if (toMain.length) {
        console.log(new Date().toLocaleString(), `Sync: ${toMain.length} change(s) made in the mirror saved to the main database (${table}).`);
    }

    // Remember this state for the next sync
    const client = await mirrorPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM fewa_sync.fingerprints WHERE tbl = $1', [table]);
        const entries = [...result.entries()];
        for (let i = 0; i < entries.length; i += 500) {
            const batch = entries.slice(i, i + 500);
            await client.query(`INSERT INTO fewa_sync.fingerprints (tbl, pk, hash)
                SELECT $1, * FROM unnest($2::text[], $3::text[])`, [table, batch.map(e => e[0]), batch.map(e => e[1])]);
        }
        await client.query(`INSERT INTO fewa_sync.synced_tables (tbl, synced_at) VALUES ($1, now())
            ON CONFLICT (tbl) DO UPDATE SET synced_at = now()`, [table]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

async function syncWithMirror(tables) {
    if (!pool) return tables.forEach(t => tablesToSync.add(t)); // the main database is not connected yet
    try {
        if (!mirrorPool) {
            mirrorPool = await connectMirror();
            if (!mirrorPool) return;
            tables = SYNC_ORDER; // (re)connected: everything
        }
        for (const table of SYNC_ORDER.filter(t => tables.includes(t))) await syncTable(table);
        if (!mirrorState.connected) console.log(new Date().toLocaleString(), 'Sync: both databases are the same.');
        mirrorState.connected = true;
        mirrorState.lastSync = new Date().toISOString();
        mirrorState.error = '';
    } catch (err) {
        tables.forEach(t => tablesToSync.add(t));
        const firstFailure = !mirrorState.error;
        mirrorState.connected = false;
        mirrorState.error = err.message;
        if (firstFailure) console.log(new Date().toLocaleString(), 'Sync: could not sync with the mirror (retrying every minute):', err.message);
        // Connection trouble, or a table / fewa_sync removed from the mirror: connect again, which sets it all up
        // again (a mirror without fingerprints is then filled from the main database)
        if (mirrorPool && /connect|ECONN|timeout|terminat|password|does not exist/i.test(err.message)) {
            await mirrorPool.end().catch(() => { });
            mirrorPool = null;
        }
        clearTimeout(mirrorTimer);
        mirrorTimer = setTimeout(() => mirrorChanged([]), MIRROR_RETRY_MS);
    }
}

// Called after every save, and every 30 seconds; syncs run one at a time
function mirrorChanged(tables) {
    if (!mirrorState.configured) return;
    tables.forEach(t => tablesToSync.add(t));
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
        const batch = [...tablesToSync];
        tablesToSync.clear();
        mirrorQueue = mirrorQueue.then(() => syncWithMirror(batch)).catch(() => { });
    }, MIRROR_DELAY_MS);
}

async function startMirror() {
    const config = await loadConfig().catch(() => ({}));
    mirrorState.configured = !!config.mirror;
    if (!mirrorState.configured) return;
    mirrorChanged(SYNC_ORDER);
    setInterval(() => mirrorChanged(SYNC_ORDER), MIRROR_FULL_SYNC_MS);
}

/* ---------- Online applications (apply.html): anyone may apply, without logging in ----------
   The form's Admission Details are the same as the student admission form's, with the choices from Settings:
   Campus, Admission Course, Study Session, Enrollment, and Student Type and Group (shown, not chosen: the first of
   each list, given to the student on Admit). An application is checked here (required fields, email, date of
   birth, file types and sizes), saved in students.applications as a Prospect, and appears in Student Hub > Online
   Applications, where staff verify, Admit (into a new student record) or Reject it. */
const APPLY_TEXT = ['campus', 'admissionCourse', 'studySession', 'enrollment', 'firstName', 'middleName', 'lastName',
    'languages', 'dob', 'gender', 'nationality', 'countryOfResidence', 'cityOfResidence', 'idBirthCert', 'heardAbout',
    'location', 'town', 'phone', 'email',
    ...['father', 'mother'].flatMap(p => ['FirstName', 'MiddleName', 'LastName', 'Phone', 'Phone2', 'Email', 'IdType',
        'NationalId', 'Nationality', 'Relationship'].map(f => p + f))];
const APPLY_REQUIRED = ['admissionCourse', 'firstName', 'lastName', 'languages',
    'dob', 'gender', 'nationality', 'countryOfResidence', 'cityOfResidence', 'heardAbout', 'location', 'town', 'phone',
    'email', 'fatherFirstName', 'fatherLastName', 'fatherPhone', 'fatherEmail', 'fatherIdType', 'fatherNationalId',
    'fatherNationality', 'fatherRelationship'];
// The second parent / guardian is optional; once any of their details is given, these are needed too
const APPLY_SECOND_REQUIRED = ['motherFirstName', 'motherLastName', 'motherPhone', 'motherRelationship'];
const APPLY_FILES = {
    photo: { label: 'Passport photo', types: ['image/jpeg', 'image/png'], required: true },
    birthCertificate: { label: 'Birth certificate', types: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    fatherIdCopy: { label: 'ID copy (first contact)', types: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    motherIdCopy: { label: 'ID copy (second contact)', types: ['image/jpeg', 'image/png', 'application/pdf'], required: false }
};
const APPLY_MAX_FILE_BYTES = 5 * 1024 * 1024;
const APPLY_PER_HOUR = 5;
const APPLY_PER_HOUR_EVERYWHERE = 100; // the address a request says it comes from can be faked, so this counts them all
const APPLY_AT_ONCE = 5;
const applyCounts = new Map(); // IP (and 'everywhere') -> { count, first }
let applicationsBeingSent = 0;

// Asked before reading what was sent, so a flood of large requests is turned away cheaply
function checkApplyLimits(req) {
    const tooMany = message => Object.assign(new Error(message), { status: 429 });
    const over = (key, limit) => {
        const seen = applyCounts.get(key);
        return !!seen && Date.now() - seen.first < 3600000 && seen.count >= limit;
    };
    if (over(clientIp(req), APPLY_PER_HOUR)) throw tooMany('Too many applications were sent from this connection. Please try again in an hour.');
    if (over('everywhere', APPLY_PER_HOUR_EVERYWHERE)) throw tooMany('Too many applications are being sent right now. Please try again in an hour.');
    if (applicationsBeingSent >= APPLY_AT_ONCE) throw tooMany('The system is busy. Please try again in a minute.');
}

function countApplication(req) {
    if (applyCounts.size > 20000) applyCounts.clear();
    for (const key of [clientIp(req), 'everywhere']) {
        const seen = applyCounts.get(key);
        applyCounts.set(key, seen && Date.now() - seen.first < 3600000 ? { ...seen, count: seen.count + 1 } : { count: 1, first: Date.now() });
    }
}

// The choices, as the admission form has them (a list never saved in Settings has the same defaults as there)
async function applicationOptions() {
    // A course sharing its name with another is known by its name with award and duration, as on the pages
    const names = async (key, defaults = [], usable = () => true) => {
        const record = await getRecord('settings', key);
        return (record ? record.items || [] : defaults.map(name => ({ name }))).filter(usable)
            .map(i => i.labelSuffix && i.name ? `${i.name} (${i.labelSuffix})` : i.name).filter(Boolean);
    };
    const organization = (await getRecord('settings', 'organization')) || {};
    const controls = await globalControls();
    return {
        collegeName: organization.collegeName || '',
        // Global Settings: applications closed (or the whole system closed)
        closed: !controls.systemOpen || !controls.applications,
        closedMessage: !controls.systemOpen ? closedMessage(controls) : '',
        campuses: await names('campuses'),
        courses: await names('courses', [], c => c.enabled !== 'NO'),
        studySessions: await names('studySessions', ['Full Time', 'Part Time']),
        enrollments: await names('enrollmentTypes', [], e => e.status !== 'Inactive'),
        studentType: (await names('studentTypes', ['STUDENT']))[0] || '',
        group: (await names('groups', ['DEFAULT GROUP']))[0] || ''
    };
}

async function receiveApplication(req, body) {
    const problem = message => Object.assign(new Error(message), { status: 400 });
    body = body && typeof body === 'object' ? body : {};
    if (body.website) return { result: 'ok', reference: 'APP-' + randomBytes(3).toString('hex').toUpperCase() }; // a robot

    const record = {};
    for (const field of APPLY_TEXT) {
        const value = String(body[field] ?? '').trim();
        if (value.length > 300) throw problem('One of the answers is too long.');
        if (value) record[field] = value;
    }
    const options = await applicationOptions();
    if (options.closed) throw Object.assign(new Error('Online applications are closed at the moment.'), { status: 403 });
    const missing = APPLY_REQUIRED.filter(f => !record[f]);
    // Campus and Enrollment are asked for once the college has set them up in Settings
    if (options.campuses.length && !record.campus) missing.push('campus');
    if (options.enrollments.length && !record.enrollment) missing.push('enrollment');
    const secondGiven = Object.keys(record).some(f => f.startsWith('mother')) || !!body.motherIdCopy;
    if (secondGiven) missing.push(...APPLY_SECOND_REQUIRED.filter(f => !record[f]));
    if (missing.length) throw problem('Please fill in every field marked *.');

    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const f of ['email', 'fatherEmail', 'motherEmail']) {
        if (record[f] && !email.test(record[f])) throw problem('One of the email addresses is not valid.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.dob) || isNaN(new Date(record.dob)) || record.dob > new Date().toISOString().slice(0, 10)) {
        throw problem('The date of birth is not valid.');
    }
    if (!['FEMALE', 'MALE'].includes(record.gender)) throw problem('Please choose the gender.');

    const fromList = (field, list, name) => {
        if (record[field] && !list.includes(record[field])) throw problem(`Please choose the ${name} from the list.`);
    };
    fromList('campus', options.campuses, 'campus');
    fromList('admissionCourse', options.courses, 'course');
    fromList('studySession', options.studySessions, 'study session');
    fromList('enrollment', options.enrollments, 'enrollment');
    // Not the applicant's choice: the college's first Student Type and Group, given to the student on Admit
    if (options.studentType) record.studentType = options.studentType;
    if (options.group) record.admissionGroup = options.group;

    for (const [field, rule] of Object.entries(APPLY_FILES)) {
        const file = body[field];
        if (!file || !file.data) {
            if (rule.required) throw problem(`Please attach the ${rule.label.toLowerCase()}.`);
            continue;
        }
        if (!rule.types.includes(file.type)) throw problem(`${rule.label}: only ${rule.types.includes('application/pdf') ? 'PDF, ' : ''}JPG or PNG files are accepted.`);
        if (String(file.data).length * 3 / 4 > APPLY_MAX_FILE_BYTES) throw problem(`${rule.label}: the file is larger than 5MB.`);
        record[field] = { __newFile: true, type: file.type, name: String(file.name || field).slice(0, 120), data: String(file.data) };
    }

    // Each applicant is a prospect, with the next prospect number (PRP-00001, PRP-00002, ...) and in the PROSPECT group
    const id = 'app-' + Date.now().toString(36) + randomBytes(4).toString('hex');
    let reference;
    for (let attempt = 0; ; attempt++) {
        const { rows } = await pool.query(`SELECT coalesce(max(substring(reference FROM '^PRP-([0-9]+)$')::int), 0) AS last
            FROM ${T('applications')}`);
        reference = 'PRP-' + String(rows[0].last + 1).padStart(5, '0');
        try {
            await putRecord('applications', id, { ...record, id, reference, status: 'Prospect', group: 'PROSPECT',
                submittedAt: new Date().toISOString() });
            break;
        } catch (err) {
            // Two applications sent at the same moment got the same number: the second takes the next one
            if (err.code !== '23505' || attempt >= 4) throw err;
        }
    }
    mirrorChanged(STORE_TABLES.applications);
    countApplication(req);

    // The applicant gets their prospect number by email too (the application is kept whether or not it goes)
    const college = options.collegeName || 'FEWA Beauty & Fashion College';
    const emailed = await sendSystemEmail(record.email,
        `Dear ${record.firstName} ${record.lastName}, thank you for applying to ${college}` +
        `${record.admissionCourse ? ` for ${record.admissionCourse}` : ''}${record.enrollment ? ` (${record.enrollment} intake)` : ''}. ` +
        `Your application has been received and your prospect number is ${reference}. Please keep this number. ` +
        'The admissions office will check your details and documents and contact you on the phone number or email you gave. ' +
        'Once you are admitted you will receive your admission number and your Student Portal login.');
    return { result: 'ok', reference, emailed };
}

/* The backups (database backups, the password-protected download, uploading corrected students) are in backups.mjs */
initBackups({ getPool: () => pool, T, sqlName, SCHEMA_OF, loadConfig, ensureDatabase, root, columnCache, forgetSessions, forgetAccountCount,
    mirrorChanged, SYNC_ORDER, passwordAcceptable, send, readBody, SMALL_BODY_BYTES });

/* ---------- System Update (Settings > System Update): "running the rocket" ----------
   After changes are pushed to GitHub, an administrator presses Update. On the office computer the server then:
   checks GitHub for new changes (git fetch), downloads them (git merge --ff-only), installs new packages when
   package.json changed, updates the tables of every database (the database/*.sql files, on Supabase, the local
   PostgreSQL copy and the backups database) and restarts itself with the new code (exit code 3: start-server.bat
   starts it again). Online (Render) the new code is installed by Render itself from GitHub, so the rocket only
   checks the version and updates the database tables. Every step is shown on the page, written in this window
   ("[System update] ...") and kept in settings.system_updates. */
const UPDATE_REPO = 'ketantawahome-source/FEWA-SYSTEM';
const RESTART_EXIT_CODE = 3;
const onlineHost = !!process.env.RENDER;
const updatePlace = onlineHost ? 'online (Render)' : 'office computer';
let updateRun = null; // the run in progress (or the last one since the server started)

function runCommand(command, args, timeout = 120000) {
    return new Promise((resolve, reject) => {
        // npm is a .cmd file on Windows, which needs a shell
        const shell = process.platform === 'win32' && command === 'npm';
        execFile(command, args, { cwd: root, timeout, windowsHide: true, shell }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { output: String(stderr || stdout || '').trim() }));
            resolve(String(stdout).trim());
        });
    });
}

async function currentVersion() {
    if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
    return runCommand('git', ['rev-parse', 'HEAD'], 15000).catch(() => null);
}

/* The changes on GitHub (newest first), each { sha, date, author, title, notes }.
   GitHub's API allows only 60 questions an hour from one internet address without signing in, and online
   (Render) that address is shared with many other websites, so GitHub often answers 403. Then the public
   change feed (the newest 20 changes) is read instead; if that fails too, the last list read is kept. */
let githubCache = { at: 0, commits: null };

const decodeEntities = text => String(text).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (whole, code) => {
    const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
});

async function githubApiCommits() {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits?per_page=100`, {
        headers: {
            'User-Agent': 'FEWA-College-System', Accept: 'application/vnd.github+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {})
        }
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()).map(c => splitMessage(c.sha, c.commit.author.date, c.commit.author.name, c.commit.message));
}

async function githubFeedCommits() {
    const response = await fetch(`https://github.com/${UPDATE_REPO}/commits/main.atom`, { headers: { 'User-Agent': 'FEWA-College-System' } });
    if (!response.ok) throw new Error(`GitHub's change feed answered ${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
        const pick = tag => (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
        const sha = (pick('id').match(/Commit\/([0-9a-f]{40})/) || [])[1] || '';
        // The full message is HTML (<pre>...</pre>) inside the XML: decoded twice
        const message = decodeEntities(decodeEntities(pick('content')).replace(/<\/?pre[^>]*>/g, '')).trim();
        return splitMessage(sha, pick('updated').trim(), decodeEntities(pick('name').trim()), message || decodeEntities(pick('title').trim()));
    }).filter(c => c.sha);
}

async function githubCommits() {
    if (githubCache.commits && Date.now() - githubCache.at < 5 * 60000) return githubCache.commits;
    let commits;
    try {
        commits = await githubApiCommits();
    } catch (apiError) {
        try {
            commits = await githubFeedCommits();
        } catch {
            if (githubCache.commits) return githubCache.commits;
            throw apiError;
        }
    }
    githubCache = { at: Date.now(), commits };
    return commits;
}

function splitMessage(sha, date, author, message) {
    const lines = String(message).split(/\r?\n/).filter(l => !/^Co-Authored-By:/i.test(l.trim()));
    return { sha, date, author, title: lines[0] || '', notes: lines.slice(1).join('\n').trim() };
}

// The changes kept in this computer's copy (git), newest first
async function localCommits(range = 'HEAD', count = 150) {
    const out = await runCommand('git', ['log', range, '-n', String(count), '--format=%H%x1f%aI%x1f%an%x1f%B%x1e'], 30000);
    return out.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
        const [sha, date, author, message] = r.split('\x1f');
        return splitMessage(sha, date, author, message);
    });
}

// Release notes: every change, marked installed or not yet; check = also ask GitHub for new ones
async function updateInfo(check) {
    const version = await currentVersion();
    let notes = [];
    let problem = '';
    try {
        if (onlineHost || !existsSync(path.join(root, '.git'))) {
            const commits = await githubCommits();
            const at = commits.findIndex(c => c.sha === version);
            notes = commits.map((c, i) => ({ ...c, installed: at >= 0 && i >= at }));
        } else {
            if (check) await runCommand('git', ['fetch', '--quiet', 'origin', 'main'], 60000).catch(err => { problem = 'GitHub could not be reached: ' + (err.output || err.message); });
            const pending = await localCommits('HEAD..origin/main', 100).catch(() => []);
            notes = [...pending.map(c => ({ ...c, installed: false })), ...(await localCommits()).map(c => ({ ...c, installed: true }))];
        }
    } catch (err) {
        problem = 'The release notes could not be read: ' + err.message;
    }
    const { rows } = await pool.query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", started_by AS "startedBy",
        place, from_version AS "fromVersion", to_version AS "toVersion", changes, databases, status
        FROM ${T('system_updates')} ORDER BY started_at DESC LIMIT 10`);
    return { place: updatePlace, online: onlineHost, version, waiting: problem ? null : notes.filter(n => !n.installed).length, notes, problem, history: rows, run: updateRun };
}

// When the last update that worked finished (shown at the bottom of every page)
async function lastSystemUpdate() {
    const { rows } = await pool.query(`SELECT finished_at AS "finishedAt" FROM ${T('system_updates')}
        WHERE status <> 'Failed' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
    return rows.length ? rows[0].finishedAt : null;
}

// After an update everyone logs in again, so every page opens with the new code
async function logOutEveryone() {
    // (whoever is in Global Settings stays there)
    await pool.query(`DELETE FROM ${T('sessions')} WHERE kind <> 'global'`);
    forgetSessions();
}

/* ---------- Global Settings (the hidden page /GLOBALSETTINGS) ----------
   The owner's switches for the whole system, behind a password of their own. The password (scrypt, as staff
   passwords) and the switches are rows of private_settings.server_keys, so no page, backup or office copy has them:
     global_settings_password  {"salt": ..., "hash": ...}
     global_controls           {"systemOpen", "closedMessage", "staffLogins", "studentLogins", "applications"}
   The first password can only be set by a logged-in Administrator. A forgotten password: delete the row
   'global_settings_password' in pgAdmin (Supabase), then an Administrator sets a new one. */
const GLOBAL_COOKIE = 'fewa_global';
const GLOBAL_MINUTES = 30;
const DEFAULT_CONTROLS = { systemOpen: true, closedMessage: '', staffLogins: true, studentLogins: true, applications: true };

async function readServerKey(name) {
    const { rows } = await pool.query(`SELECT value FROM private_settings.server_keys WHERE name = $1`, [name]);
    return rows.length ? rows[0].value : null;
}
async function writeServerKey(name, value) {
    await pool.query(`INSERT INTO private_settings.server_keys (name, value, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [name, value]);
}

// Read at most every 10 seconds (every request asks)
let controlsCache = { at: 0, value: null };
async function globalControls() {
    if (!controlsCache.value || Date.now() - controlsCache.at > 10000) {
        let saved = {};
        try { saved = JSON.parse(await readServerKey('global_controls') || '{}'); } catch { /* the defaults */ }
        controlsCache = { at: Date.now(), value: { ...DEFAULT_CONTROLS, ...saved } };
    }
    return controlsCache.value;
}
const closedMessage = controls => controls.closedMessage ||
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

async function handleGlobal(req, res, session, action, method) {
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
        for (const key of ['systemOpen', 'staffLogins', 'studentLogins', 'applications']) {
            if (typeof body[key] === 'boolean') next[key] = body[key];
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

// The log's times are in the time zone of the person who pressed Update (the online server runs on UTC)
function validTimeZone(zone) {
    try {
        return zone && new Intl.DateTimeFormat('en-GB', { timeZone: String(zone) }) && String(zone);
    } catch {
        return undefined;
    }
}

async function runSystemUpdate(by, timeZone) {
    if (updateRun && ['Running', 'Restarting'].includes(updateRun.status)) return updateRun;
    const id = 'upd-' + Date.now().toString(36) + randomBytes(3).toString('hex');
    const run = updateRun = { id, status: 'Running', percent: 0, step: '', log: [], by, startedAt: new Date().toISOString(), place: updatePlace };
    const say = (percent, text) => {
        run.percent = percent;
        run.step = text;
        run.log.push(`${new Date().toLocaleTimeString('en-GB', { timeZone })}  ${text}`);
        console.log(new Date().toLocaleString(), '[System update]', text);
    };
    const save = (fields = {}) => pool.query(`INSERT INTO ${T('system_updates')} (id, started_at, started_by, place, from_version, to_version,
            changes, databases, status, log, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET to_version = EXCLUDED.to_version, changes = EXCLUDED.changes, databases = EXCLUDED.databases,
            status = EXCLUDED.status, log = EXCLUDED.log, finished_at = EXCLUDED.finished_at`,
        [id, run.startedAt, by, updatePlace, run.from || null, fields.to || null, fields.changes ?? null, fields.databases ?? null,
            fields.status || 'Running', run.log.join('\n'), fields.finished ? new Date().toISOString() : null]).catch(() => { });

    (async () => {
        let changes = 0;
        let databases = 0;
        try {
            say(3, `Rocket on the launch pad: update started by ${by} on the ${updatePlace}.`);
            run.from = await currentVersion();
            await save();
            say(8, 'Checking GitHub for new changes...');
            if (!onlineHost) {
                await runCommand('git', ['fetch', '--quiet', 'origin', 'main'], 60000);
                changes = Number(await runCommand('git', ['rev-list', '--count', 'HEAD..origin/main'], 15000)) || 0;
                say(20, changes ? `${changes} new change(s) found on GitHub.` : 'No new changes on GitHub: the code here is up to date.');
                if (changes) {
                    const changedFiles = await runCommand('git', ['diff', '--name-only', 'HEAD', 'origin/main'], 15000);
                    say(30, 'Downloading the changes from GitHub...');
                    await runCommand('git', ['merge', '--ff-only', 'origin/main'], 60000);
                    say(45, `Changes downloaded (now at version ${(await currentVersion() || '').slice(0, 7)}).`);
                    if (/(^|\n)package(-lock)?\.json/.test(changedFiles)) {
                        say(50, 'Installing new packages...');
                        await runCommand('npm', ['install', '--no-fund', '--no-audit', '--omit=dev'], 300000);
                        say(58, 'Packages installed.');
                    }
                }
            } else {
                // Only to tell the person: Render installs new code by itself, so GitHub not answering is no failure
                const latest = await githubCommits().then(list => list[0]).catch(err => {
                    say(20, `GitHub could not be asked for new changes (${err.message}); carrying on with the database tables.`);
                    return null;
                });
                changes = latest && latest.sha !== run.from ? 1 : 0;
                if (latest) say(30, changes ? 'GitHub has newer code: Render installs it by itself within a few minutes (watch the Render dashboard).'
                    : 'The online system already runs the newest code on GitHub.');
            }

            say(62, 'Updating the database tables (database/*.sql)...');
            // In the sync's queue, so the sync waits and cannot collide with these table changes
            const tablesUpdated = mirrorQueue.then(async () => {
                const client = await pool.connect();
                try { await setUpTables(client); } finally { client.release(); }
                databases++;
                say(72, 'Main database (Supabase) updated.');
                if (mirrorPool) {
                    const mirrorClient = await mirrorPool.connect();
                    try { await setUpTables(mirrorClient); } finally { mirrorClient.release(); columnCache.clear(); }
                    databases++;
                    say(80, 'Local PostgreSQL copy (fewa_college) updated.');
                    mirrorChanged(SYNC_ORDER);
                }
            });
            mirrorQueue = tablesUpdated.catch(() => { });
            await tablesUpdated;
            if (await updateBackupTables()) {
                databases++;
                say(86, 'Backups database (fewa_backups) updated.');
            }

            const restart = !onlineHost && changes > 0;
            const to = await currentVersion();
            run.status = restart ? 'Restarting' : changes ? 'Done' : 'Up to date';
            say(restart ? 95 : 100, `${databases} database(s) updated - no script failures.` +
                (restart ? ' Restarting the system with the new code...' : ' Rocket landed: the update is complete.') +
                ' Everyone is logged out and logs in again.');
            await save({ to, changes, databases, status: changes ? 'Done' : 'Up to date', finished: true });
            await logOutEveryone().catch(err => console.log(new Date().toLocaleString(), '[System update] Could not log everyone out:', err.message));
            if (restart) {
                setTimeout(() => {
                    console.log(new Date().toLocaleString(), '[System update] Restarting now (start-server.bat starts the server again).');
                    process.exit(RESTART_EXIT_CODE);
                }, 1500);
            }
        } catch (err) {
            run.status = 'Failed';
            say(run.percent, 'FAILED: ' + (err.output || err.message) +
                (/not possible to fast-forward|diverg/i.test(err.output || '') ? ' (this computer has its own changes that are not on GitHub)' : ''));
            await save({ to: await currentVersion(), changes, databases, status: 'Failed', finished: true });
        }
    })();
    return run;
}

/* ---------- The API ---------- */
function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('The file is too large to save.'), { status: 413 }));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
            } catch {
                reject(Object.assign(new Error('The request was not valid JSON.'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

async function handleApi(req, res, parts) {
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

    if (area === 'health' && method === 'GET') return send(res, 200, { ok: true, mirror: mirrorState });
    if (area === 'global') return await handleGlobal(req, res, session, a, method);

    /* ---------- Logging in and out, passwords ---------- */
    if (area === 'session' && method === 'GET' && !a) {
        const blocked = await setupNeeded() && !isLocalRequest(req);
        return send(res, 200, {
            setupNeeded: setup, setupBlocked: blocked, kind: session.kind,
            accountId: staff ? session.account.id : null, username: staff ? session.account.username : null,
            admin: !!admin, studentId: session.kind === 'student' ? session.studentId : null,
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
        applicationsBeingSent++;
        try {
            return send(res, 200, await receiveApplication(req, await readBody(req, APPLY_BODY_BYTES)));
        } finally {
            applicationsBeingSent--;
        }
    }

    /* ---------- Records ---------- */
    if (area === 'stores' && STORES[a]) {
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
        if (method === 'PUT' && b) {
            const body = await readBody(req);
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
            for (const field of ['dateOfBirth', 'dateEmployed']) {
                if (details[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(details[field]) || isNaN(new Date(details[field])))) {
                    throw Object.assign(new Error('A date is not valid.'), { status: 400 });
                }
            }
            // Only the detail columns of this staff member's row change
            const columns = (await tableColumns(pool, 'staff')).map(c => c.name);
            const values = { ...Object.fromEntries(STAFF_DETAIL_FIELDS.map(f => [f, details[f] || null])),
                detailsUpdatedAt: new Date().toISOString(), detailsUpdatedBy: staff ? session.account.username : '' };
            const sets = Object.keys(values).map(f => f.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())).filter(c => columns.includes(c));
            await pool.query(`UPDATE ${T('staff')} SET ${sets.map((c, i) => `${sqlName(c)} = $${i + 2}`).join(', ')} WHERE id = $1`,
                [a, ...sets.map(c => values[snakeToCamel(c)])]);
            mirrorChanged(['staff']);
            return send(res, 200, { ok: true });
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

/* ---------- Start ---------- */
const handleRequest = async (req, res) => {
    // Protections every browser understands: no showing the system inside another website, no guessing file types,
    // and the address of a page (a reset link has a code in it) is never told to other websites
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'");
    res.setHeader('Referrer-Policy', 'same-origin');
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
        // The owner's hidden page: https://fewa-system.onrender.com/GLOBALSETTINGS (any capitals)
        if (file.replace(/\/+$/, '').toLowerCase() === '/globalsettings') file = '/GlobalSettings.html';
        await serveStatic(req, res, file);
    } catch (err) {
        if (!err.status) console.error(new Date().toLocaleString(), req.method, file, err);
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
