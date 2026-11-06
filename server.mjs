/* ---------- FEWA system server: the web pages and the PostgreSQL database ----------
   Started by start-server.bat. Serves the pages at http://localhost:5600/ (the login page opens at the address
   alone) and keeps ALL the system's data in PostgreSQL. Only this computer can open it.

   Database connection: db-config.json in this folder (host, port, user, password, database, and "ssl" for a
   hosted database such as Supabase). On every start the tables defined in the database folder (one .sql file
   per schema) are created if missing (and, on this computer's PostgreSQL, the database "fewa_college").

   Tables, grouped in schemas (see database/*.sql for every column)
     students.students, students.documents, students.deferrals, staff.staff_accounts
                         one column per field, so they can be read and edited in pgAdmin. A column like
                         first_name is the field firstName; fields without a column of their own are kept in
                         "extra". Columns added in pgAdmin become fields of the records (within 15 seconds).
     settings.settings   which table holds each Settings list or form (stored_in)
     settings.courses, schools, enrollment_types, study_sessions, campuses, academic_terms, departments,
     student_types, student_groups, document_types, and staff.staff_roles
                         one row per item of that Settings list, in the order shown (position)
     settings.school_setup, finance.fee_payment_details
                         the single row of that Settings form
     staff.role_operations       the rights given to each staff role
     staff.password_reset_codes  emailed reset codes (hashes only) until they are used or expire
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
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || process.argv[2] || 5600);
// On a hosting service (PORT is set) the server must accept connections from outside; on this computer only from itself
const listenAddress = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
const MAX_BODY_BYTES = 60 * 1024 * 1024; // a record with a large document, sent as base64

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
        // Always check for a newer file, so changes show with a normal refresh
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
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
        config = JSON.parse(await readFile(path.join(root, 'db-config.json'), 'utf8'));
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
const COLUMN_TABLES = ['students', 'documents', 'deferrals', 'staff_accounts'];
const SERVER_COLUMNS = new Set(['extra', 'position']);
const COLUMNS_FRESH_MS = 15000;

const snakeToCamel = name => name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
const sqlName = name => pg.escapeIdentifier(name);

/* ---------- Schemas: the tables are grouped by area (folders under Schemas in pgAdmin) ----------
   Each schema's tables are defined in database/<n>-<schema>.sql. */
const SCHEMA_OF = {
    students: 'students', documents: 'students', deferrals: 'students',
    settings: 'settings', schools: 'settings', courses: 'settings', enrollment_types: 'settings',
    study_sessions: 'settings', school_setup: 'settings', campuses: 'settings', academic_terms: 'settings',
    departments: 'settings', student_types: 'settings', student_groups: 'settings', document_types: 'settings',
    fee_payment_details: 'finance',
    staff_accounts: 'staff', staff_roles: 'staff', role_operations: 'staff', password_reset_codes: 'staff', sessions: 'staff',
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

async function setUpTables(client) {
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
                if (table === 'staff_accounts') {
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
    pool = newPool;
    databaseError = null;
    console.log(`Connected to PostgreSQL: database "${config.database}" on ${config.host}:${config.port}.`);
    if (firstConnection) startMirror();
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
    groups: 'student_groups', documentTypes: 'document_types', roles: 'staff_roles'
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
        for (const [position, item] of (Array.isArray(items) ? items : []).entries()) {
            const values = rowFromRecord(columns, { ...item, id: String(item.id || `${key}-${position + 1}`) });
            values.position = position;
            await upsertRow(db, listTable, 'id', values);
        }
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
const STORES = { students: 'id', documents: 'id', deferrals: 'id', settings: 'key' };
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
        const records = [];
        for (const row of rows) records.push(await readSetting(db, row));
        return records;
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
const ROLE_OPERATIONS_KEY = 'fewaRoleOperations';
const RESET_PREFIX = 'fewaPendingReset:';

async function getValues() {
    const values = {};
    const accounts = await pool.query(`SELECT * FROM ${T('staff_accounts')} ORDER BY position, id`);
    if (accounts.rowCount) values[ACCOUNTS_KEY] = JSON.stringify(accounts.rows.map(recordFromRow));
    const roles = await pool.query(`SELECT role, rights FROM ${T('role_operations')}`);
    if (roles.rowCount) values[ROLE_OPERATIONS_KEY] = JSON.stringify(Object.fromEntries(roles.rows.map(r => [r.role, r.rights])));
    const codes = await pool.query(`SELECT email, data FROM ${T('password_reset_codes')}`);
    codes.rows.forEach(r => values[RESET_PREFIX + r.email] = JSON.stringify(r.data));
    return values;
}

async function setValue(key, value) {
    const parsed = value == null ? null : JSON.parse(value);
    if (key === ACCOUNTS_KEY) {
        if (parsed !== null && !Array.isArray(parsed)) throw Object.assign(new Error('Accounts must be a list.'), { status: 400 });
        await inTransaction(async client => {
            await client.query(`DELETE FROM ${T('staff_accounts')}`);
            const columns = await tableColumns(client, 'staff_accounts');
            for (const [position, account] of (parsed || []).entries()) {
                const values = rowFromRecord(columns, { ...account, id: String(account.id || account.username) });
                values.position = position;
                await upsertRow(client, 'staff_accounts', 'id', values);
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
     other staff        all student data and settings; not staff accounts, role rights or reset codes
     students           only their own record, documents and deferrals (read), and their own password
     not logged in      only the School Setup (college name and logo, for the login page)
   First-time setup (no staff account yet: creating the first administrator, or restoring a backup) is only
   allowed from this computer itself, never over the internet.
   Passwords are stored as SHA-256 of "salt:password", the same as auth.js has always made them. */
const SESSION_COOKIE = 'fewa_session';
const SESSION_HOURS = 12;
const RESET_GRANT_MINUTES = 10;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;

const sha256 = text => createHash('sha256').update(text).digest('hex');
const passwordHash = (password, salt) => sha256(`${salt}:${password}`);
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
    const { rows } = await pool.query(`SELECT kind, subject FROM ${T('sessions')} WHERE token_hash = $1 AND expires_at > now()`, [tokenHash]);
    if (rows.length) {
        const { kind, subject } = rows[0];
        if (kind === 'staff') {
            const found = await pool.query(`SELECT * FROM ${T('staff_accounts')} WHERE id = $1`, [subject]);
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
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${T('staff_accounts')}`);
        accountCount = { at: Date.now(), count: rows[0].n };
    }
    return accountCount.count === 0;
}
const forgetAccountCount = () => accountCount = { at: 0, count: null };

/* Too many wrong passwords for one username from one place: locked for a while */
const loginFailures = new Map();
function loginLocked(req, username) {
    const entry = loginFailures.get(clientIp(req) + '|' + lower(username));
    return !!entry && entry.count >= LOGIN_MAX_FAILURES && Date.now() - entry.first < LOGIN_LOCK_MINUTES * 60000;
}
function loginFailed(req, username) {
    const key = clientIp(req) + '|' + lower(username);
    const entry = loginFailures.get(key);
    if (!entry || Date.now() - entry.first > LOGIN_LOCK_MINUTES * 60000) loginFailures.set(key, { count: 1, first: Date.now() });
    else entry.count++;
}

// Staff log in with their email; students with their AdmNo (capital and small letters must match)
async function login(req, res, { username, password } = {}) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) return { result: 'wrong' };
    if (loginLocked(req, username)) return { result: 'locked' };

    const staff = await pool.query(`SELECT * FROM ${T('staff_accounts')} WHERE lower(username) = $1`, [lower(username)]);
    if (staff.rows.length) {
        const account = recordFromRow(staff.rows[0]);
        let result = 'ok';
        if (account.status === 'Inactive') result = 'inactive';
        else if (!account.hash) result = account.adminResetRequired ? 'reset-required' : 'no-password';
        else if (passwordHash(password, account.salt) !== account.hash) result = 'wrong';
        if (result !== 'ok') {
            if (result === 'wrong') loginFailed(req, username);
            return { result };
        }
        loginFailures.delete(clientIp(req) + '|' + lower(username));
        await createSession(req, res, 'staff', account.id, SESSION_HOURS * 60);
        return { result, kind: 'staff', username: account.username };
    }

    const exact = await pool.query(`SELECT * FROM ${T('students')} WHERE adm_no = $1`, [username]);
    if (!exact.rows.length) {
        const anyCase = await pool.query(`SELECT 1 FROM ${T('students')} WHERE lower(adm_no) = $1`, [lower(username)]);
        loginFailed(req, username);
        return { result: anyCase.rows.length ? 'wrong-case' : 'wrong' };
    }
    const student = recordFromRow(exact.rows[0]);
    let result = 'ok';
    if (student.activeStudent === 'no') result = 'inactive';
    else if (!student.loginHash) result = student.adminResetRequired ? 'reset-required' : 'no-password';
    else if (passwordHash(password, student.loginSalt) !== student.loginHash) result = 'wrong-password';
    if (result !== 'ok') {
        if (result === 'wrong-password') loginFailed(req, username);
        return { result };
    }
    loginFailures.delete(clientIp(req) + '|' + lower(username));
    await createSession(req, res, 'student', student.id, SESSION_HOURS * 60);
    return { result, kind: 'student', studentId: student.id, admNo: student.admNo };
}

// A staff member's own new password ('same': it is the current one)
async function setOwnPassword(session, password) {
    const account = session.account;
    if (account.hash && passwordHash(password, account.salt) === account.hash) return { result: 'same' };
    const salt = randomBytes(16).toString('hex');
    await pool.query(`UPDATE ${T('staff_accounts')} SET salt = $1, hash = $2, admin_reset_required = false WHERE id = $3`,
        [salt, passwordHash(password, salt), account.id]);
    forgetSessions();
    return { result: 'ok' };
}

// A student's Student Portal password: set by staff (Reset Password), or by the student themselves
async function setStudentPasswordOnServer(session, { studentId, password, mustChange } = {}) {
    if (session.kind === 'student') {
        if (studentId !== session.studentId) throw Object.assign(new Error('Not allowed.'), { status: 403 });
        mustChange = false;
    }
    const { rows } = await pool.query(`SELECT login_salt, login_hash FROM ${T('students')} WHERE id = $1`, [String(studentId)]);
    if (!rows.length) return { result: 'none' };
    if (session.kind === 'student' && rows[0].login_hash && passwordHash(password, rows[0].login_salt) === rows[0].login_hash) {
        return { result: 'same' };
    }
    const salt = randomBytes(16).toString('hex');
    await pool.query(`UPDATE ${T('students')} SET login_salt = $1, login_hash = $2, must_change_password = $3,
        admin_reset_required = false, password_set_at = now(), updated_at = now() WHERE id = $4`,
        [salt, passwordHash(String(password), salt), !!mustChange, String(studentId)]);
    return { result: 'ok' };
}

/* Password reset codes: made by an administrator (Staff Management, or a new staff member's welcome email);
   checking a code lets that person choose a new password within 10 minutes */
async function createResetCode({ email, minutes } = {}) {
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const salt = String(Date.now());
    const data = { salt, hash: passwordHash(code, salt), expires: Date.now() + Number(minutes || 15) * 60000, attempts: 0 };
    await pool.query(`INSERT INTO ${T('password_reset_codes')} (email, data) VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`, [lower(email), data]);
    return { code };
}

async function verifyResetCodeOnServer(req, res, { email, code } = {}) {
    const account = await pool.query(`SELECT status FROM ${T('staff_accounts')} WHERE lower(username) = $1`, [lower(email)]);
    if (!account.rows.length || account.rows[0].status === 'Inactive') return { result: 'none' };
    const { rows } = await pool.query(`SELECT data FROM ${T('password_reset_codes')} WHERE email = $1`, [lower(email)]);
    if (!rows.length) return { result: 'none' };
    const saved = rows[0].data;
    const remove = () => pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [lower(email)]);
    if (Date.now() > saved.expires) {
        await remove();
        return { result: 'expired' };
    }
    if (saved.hash === passwordHash(String(code || '').trim(), saved.salt)) {
        await remove();
        await createSession(req, res, 'reset', lower(email), RESET_GRANT_MINUTES);
        return { result: 'ok' };
    }
    saved.attempts = (saved.attempts || 0) + 1;
    if (saved.attempts >= CODE_MAX_ATTEMPTS) {
        await remove();
        return { result: 'none' };
    }
    await pool.query(`UPDATE ${T('password_reset_codes')} SET data = $1 WHERE email = $2`, [saved, lower(email)]);
    return { result: 'wrong' };
}

async function completeResetOnServer(req, res, session, { password } = {}) {
    if (session.kind !== 'reset') return { result: 'expired' };
    const salt = randomBytes(16).toString('hex');
    const updated = await pool.query(`UPDATE ${T('staff_accounts')} SET salt = $1, hash = $2, admin_reset_required = false
        WHERE lower(username) = $3`, [salt, passwordHash(String(password), salt), session.email]);
    await endSession(req, res, session);
    forgetSessions();
    return { result: updated.rowCount ? 'ok' : 'expired' };
}

// What the pages may see of the staff accounts: administrators (and setup) everything; other staff the
// accounts without password details (hash: true when a password is set)
function accountsForSession(text, full) {
    if (full || !text) return text;
    return JSON.stringify(JSON.parse(text).map(({ salt, hash, ...account }) => ({ ...account, hash: hash ? true : null })));
}

// Saving the accounts list: an account sent back with hash: true keeps its password as it is
async function keepPasswords(text) {
    if (text == null) return text;
    const accounts = JSON.parse(text);
    if (!accounts.some(a => a && a.hash === true)) return text;
    const { rows } = await pool.query(`SELECT id, salt, hash FROM ${T('staff_accounts')}`);
    const saved = new Map(rows.map(r => [r.id, r]));
    return JSON.stringify(accounts.map(a => a && a.hash === true
        ? { ...a, salt: (saved.get(a.id) || {}).salt || null, hash: (saved.get(a.id) || {}).hash || null } : a));
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
    settings: ['settings', ...Object.values(SETTING_LISTS), ...Object.values(SETTING_FORMS)]
};
const valueTables = key => key === ACCOUNTS_KEY ? ['staff_accounts']
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

/* ---------- The API ---------- */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
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
    if (area === 'session' && a === 'login' && method === 'POST') return send(res, 200, await login(req, res, await readBody(req)));
    if (area === 'session' && a === 'logout' && method === 'POST') {
        await endSession(req, res, session);
        return send(res, 200, { ok: true });
    }
    if (area === 'password' && method === 'POST' && !a) {
        if (!staff) throw forbidden();
        const result = await setOwnPassword(session, String((await readBody(req) || {}).password || ''));
        mirrorChanged(['staff_accounts']);
        return send(res, 200, result);
    }
    if (area === 'student-password' && method === 'POST') {
        if (!staff && session.kind !== 'student') throw forbidden();
        const result = await setStudentPasswordOnServer(session, await readBody(req) || {});
        mirrorChanged(['students']);
        return send(res, 200, result);
    }
    if (area === 'reset-code' && method === 'POST') {
        if (!admin) throw forbidden(); // the code is made here and emailed by the administrator's page
        const result = await createResetCode(await readBody(req) || {});
        mirrorChanged(['password_reset_codes']);
        return send(res, 200, result);
    }
    if (area === 'password-reset' && a === 'verify' && method === 'POST') {
        const body = await readBody(req) || {};
        if (loginLocked(req, 'reset:' + body.email)) return send(res, 200, { result: 'none' });
        const result = await verifyResetCodeOnServer(req, res, body);
        if (result.result !== 'ok') loginFailed(req, 'reset:' + body.email);
        mirrorChanged(['password_reset_codes']);
        return send(res, 200, result);
    }
    if (area === 'password-reset' && !a && method === 'POST') {
        const result = await completeResetOnServer(req, res, session, await readBody(req) || {});
        mirrorChanged(['staff_accounts']);
        return send(res, 200, result);
    }

    /* ---------- Records ---------- */
    if (area === 'stores' && STORES[a]) {
        if (method === 'GET') {
            if (fullAccess) return send(res, 200, b ? await getRecord(a, b) : await getAllRecords(a));
            if (session.kind === 'student') {
                const mine = record => a === 'students' ? record.id === session.studentId
                    : a === 'settings' ? true : record.studentId === session.studentId;
                if (b) {
                    const record = await getRecord(a, b);
                    return send(res, 200, record && mine(record) ? record : null);
                }
                return send(res, 200, a === 'students'
                    ? await selectRecords(pool, 'students', session.studentId)
                    : (await getAllRecords(a)).filter(mine));
            }
            // Not logged in: the college name and logo for the login page only
            if (a === 'settings' && b === 'organization') return send(res, 200, await getRecord(a, b));
            if (a === 'settings' && !b) return send(res, 200, (await getAllRecords(a)).filter(s => s.key === 'organization'));
            throw forbidden();
        }
        if (!fullAccess) throw forbidden();
        if (method === 'PUT' && b) {
            const saved = await putRecord(a, b, await readBody(req));
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, saved);
        }
        if (method === 'DELETE' && b) {
            await deleteRecord(a, b);
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, { ok: true });
        }
        if (method === 'POST' && b === 'replace') {
            const body = await readBody(req) || {};
            await replaceRecords(a, Array.isArray(body.records) ? body.records : [], !!body.merge);
            mirrorChanged(STORE_TABLES[a]);
            return send(res, 200, { ok: true });
        }
    }

    if (area === 'files' && a && method === 'GET') {
        if (!fullAccess && !(session.kind === 'student' && (await studentFileIds(session.studentId)).has(a))) throw forbidden();
        const { rows } = await pool.query(`SELECT type, content FROM ${T('stored_files')} WHERE id = $1`, [a]);
        if (!rows.length) return send(res, 404, { error: 'File not found' });
        // A stored file never changes (a new upload gets a new id), so the browser may keep it
        res.writeHead(200, { 'Content-Type': rows[0].type || 'application/octet-stream',
            'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(rows[0].content);
    }

    /* ---------- Staff accounts and role rights ---------- */
    if (area === 'values' && method === 'GET' && !a) {
        if (!fullAccess) return send(res, 200, {});
        const values = await getValues();
        const visible = {};
        if (values[ACCOUNTS_KEY]) visible[ACCOUNTS_KEY] = accountsForSession(values[ACCOUNTS_KEY], setup || admin);
        if (values[ROLE_OPERATIONS_KEY]) visible[ROLE_OPERATIONS_KEY] = values[ROLE_OPERATIONS_KEY];
        return send(res, 200, visible); // reset codes never leave the server
    }
    if (area === 'values' && method === 'PUT' && a) {
        const body = await readBody(req) || {};
        const value = body.value == null ? null : String(body.value);
        const resetCodeRemoved = a.startsWith(RESET_PREFIX) && value === null;
        if (!(setup || admin) || (a.startsWith(RESET_PREFIX) && !resetCodeRemoved)) throw forbidden();
        await setValue(a, a === ACCOUNTS_KEY ? await keepPasswords(value) : value);
        if (a === ACCOUNTS_KEY) {
            forgetAccountCount();
            forgetSessions();
        }
        mirrorChanged(valueTables(a));
        return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Unknown request' });
}

/* ---------- Start ---------- */
http.createServer(async (req, res) => {
    // A strange address (e.g. "//" or a broken %-code) gets "Bad request" instead of stopping the server
    let file;
    try {
        file = decodeURIComponent(new URL('http://localhost' + req.url).pathname);
    } catch {
        return send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
    }
    try {
        if (file.startsWith('/api/')) return await handleApi(req, res, file.slice(5).split('/').filter(Boolean));
        await serveStatic(req, res, file);
    } catch (err) {
        if (!err.status) console.error(new Date().toLocaleString(), req.method, file, err);
        // e.g. a column added in pgAdmin is not picked up yet, or a value does not fit its column's type
        if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'The database could not do this: ' + err.message });
        else res.end();
    }
}).on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is already in use - the FEWA system is probably already running.`);
        console.log(`Open http://localhost:${port}/ in the browser.`);
    } else {
        console.log('The server could not start: ' + err.message);
    }
    process.exit(1);
}).listen(port, listenAddress, () => {
    console.log(`FEWA system is running at http://localhost:${port}/` + (process.env.PORT ? ' (online)' : ''));
    console.log('Keep this window open while using the system. Close it to stop the server.');
    connectDatabase();
});
