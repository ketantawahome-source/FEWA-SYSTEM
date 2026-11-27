/* ---------- Tables, schemas and turning rows into records (no connection here: see connection.mjs) ---------- */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { root } from './config.mjs';

/* ---------- Database connection ---------- */
// Date columns come back as the text YYYY-MM-DD (as the pages use them), not as a JavaScript date
pg.types.setTypeParser(1082, value => value);
export async function loadConfig() {
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
export async function ensureDatabase(config) {
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
/* ---------- Tables with one column per field ----------
   Record field  <->  column:  admNo <-> adm_no,  firstName <-> first_name,  group <-> "group".
   The columns are read from the database itself (every 15 seconds at most), so columns added, removed or
   renamed in pgAdmin are followed. "extra" holds the fields that have no column; "position" is the server's own. */
// Academic Management > Manage Units (database/8-academics.sql): record stores like deferrals
export const ACADEMIC_STORES = ['units', 'programme_units', 'unit_offers', 'unit_registrations', 'unit_lecturers', 'unit_hours', 'period_schedules',
    'exam_groups', 'exam_types', 'grading_systems', 'group_exam_types', 'award_setups', 'course_exam_groups', 'exam_paper_types',
    'attendance_registers'];
export const ACADEMIC_RIGHTS = ['academics.view', 'academics.edit', 'academics.register', 'schedule.view', 'schedule.edit', 'exams.view', 'exams.edit',
    'attendance.view', 'attendance.mark'];
// Academic tables written with Edit Semester Schedule / Edit Exam Management (the rest: Edit Units)
export const SCHEDULE_STORES = ['period_schedules'];
export const EXAM_STORES = ['exam_groups', 'exam_types', 'grading_systems', 'group_exam_types', 'award_setups', 'course_exam_groups', 'exam_paper_types'];
// Record stores only administrators read or change (Staff Management > Staff Accreditation)
export const ADMIN_STORES = ['staff_qualifications'];
export const COLUMN_TABLES = ['students', 'documents', 'deferrals', 'applications', 'staff', ...ACADEMIC_STORES, ...ADMIN_STORES];
const SERVER_COLUMNS = new Set(['extra', 'position']);
const COLUMNS_FRESH_MS = 15000;
export const snakeToCamel = name => name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
export const sqlName = name => pg.escapeIdentifier(name);
/* ---------- Schemas: the tables are grouped by area (folders under Schemas in pgAdmin) ----------
   Each schema's tables are defined in database/<n>-<schema>.sql. */
export const SCHEMA_OF = {
    students: 'students', documents: 'students', deferrals: 'students', applications: 'students',
    settings: 'settings', schools: 'settings', courses: 'settings', enrollment_types: 'settings',
    study_sessions: 'settings', school_setup: 'settings', campuses: 'settings', batches: 'settings',
    departments: 'settings', qualification_types: 'settings', student_types: 'settings', document_types: 'settings', system_updates: 'settings',
    reg_number_sequences: 'settings', short_courses: 'settings', award_types: 'settings',
    fee_payment_details: 'finance', fee_structure: 'finance', charges: 'finance', payments: 'finance',
    staff_roles: 'settings', role_operations: 'settings',
    staff: 'staff', staff_qualifications: 'staff',
    sessions: 'logins', password_reset_codes: 'logins', sign_in_activity: 'logins',
    stored_files: 'files',
    units: 'academics', programme_units: 'academics', unit_offers: 'academics', unit_registrations: 'academics',
    unit_lecturers: 'academics', unit_hours: 'academics', period_schedules: 'academics',
    exam_groups: 'academics', exam_types: 'academics', grading_systems: 'academics', group_exam_types: 'academics',
    award_setups: 'academics', course_exam_groups: 'academics', exam_paper_types: 'academics', attendance_registers: 'academics'
};
const SCHEMAS = [...new Set(Object.values(SCHEMA_OF))];
// A table's full name, e.g. T('courses') -> "settings"."courses"
export const T = table => `${sqlName(SCHEMA_OF[table])}.${sqlName(table)}`;
export const columnCache = new Map();
export async function tableColumns(db, table, fresh = false) {
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
export function rowFromRecord(columns, record) {
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
export function recordFromRow(row) {
    const record = { ...(row.extra && typeof row.extra === 'object' ? row.extra : {}) };
    for (const [name, value] of Object.entries(row)) {
        if (SERVER_COLUMNS.has(name) || value === null) continue;
        record[snakeToCamel(name)] = value instanceof Date ? value.toISOString() : value;
    }
    return record;
}
export async function upsertRow(db, table, key, values) {
    const names = Object.keys(values);
    const updates = names.filter(n => n !== key).map(n => `${sqlName(n)} = EXCLUDED.${sqlName(n)}`);
    await db.query(`INSERT INTO ${T(table)} (${names.map(sqlName).join(', ')})
        VALUES (${names.map((_, i) => '$' + (i + 1)).join(', ')})
        ON CONFLICT (${sqlName(key)}) DO ${updates.length ? 'UPDATE SET ' + updates.join(', ') : 'NOTHING'}`,
        names.map(n => values[n]));
}
// Many rows in one trip to the database (a column a row does not have gets its default); a later row with the same
// key replaces an earlier one, as saving them one by one did
export async function upsertRows(db, table, key, rowsList) {
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
export async function takeOldLayoutRows(client) {
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
export async function moveTablesOutOfPublic(client) {
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
export async function tableDefinitions() {
    const folder = path.join(root, 'database');
    const files = (await readdir(folder)).filter(f => f.toLowerCase().endsWith('.sql')).sort();
    return Promise.all(files.map(f => readFile(path.join(folder, f), 'utf8')));
}
/* ---------- Settings: each list and form in its own table ----------
   The pages keep Settings as records in a "settings" store: a list is { key: 'courses', items: [...] } and a
   form is { key: 'organization', collegeName, ... }. Here each list's items are rows of its own table (in the
   order of the list, "position"), each form is the single row of its table, and the "settings" table says
   which table holds each (stored_in). A setting with no table of its own stays whole in settings.data. */
export const SETTING_LISTS = {
    courses: 'courses', studySessions: 'study_sessions', enrollmentTypes: 'enrollment_types', schools: 'schools',
    campuses: 'campuses', batches: 'batches', departments: 'departments', studentTypes: 'student_types',
    documentTypes: 'document_types', roles: 'staff_roles', regSequences: 'reg_number_sequences',
    shortCourses: 'short_courses', awardTypes: 'award_types', qualificationTypes: 'qualification_types'
};
export const SETTING_FORMS = { organization: 'school_setup', paymentDetails: 'fee_payment_details' };
