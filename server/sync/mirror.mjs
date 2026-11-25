/* ---------- Two-way sync with the office PostgreSQL ---------- */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { ACCOUNTS_KEY, ROLE_OPERATIONS_KEY } from '../auth/accounts.mjs';
import { pool, setUpTables } from '../core/connection.mjs';
import { ACADEMIC_STORES, ADMIN_STORES, SCHEMA_OF, SETTING_FORMS, SETTING_LISTS, T, columnCache, ensureDatabase, loadConfig, sqlName } from '../core/database.mjs';

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
export const mirrorState = { configured: false, connected: false, lastSync: null, error: '' };
export let mirrorPool = null;
export let mirrorQueue = Promise.resolve();
// System Update waits for its own table changes before the next sync (set from another module)
export function setMirrorQueue(promise) { mirrorQueue = promise; }
let mirrorTimer = null;
const tablesToSync = new Set();
// The tables a save to a store (or a value) changes
export const STORE_TABLES = {
    students: ['students', 'stored_files'], documents: ['documents', 'stored_files'], deferrals: ['deferrals'],
    applications: ['applications', 'stored_files'],
    ...Object.fromEntries(ACADEMIC_STORES.map(store => [store, [store]])),
    ...Object.fromEntries(ADMIN_STORES.map(store => [store, [store]])),
    settings: ['settings', ...Object.values(SETTING_LISTS), ...Object.values(SETTING_FORMS)]
};
export const valueTables = key => key === ACCOUNTS_KEY ? ['staff', 'stored_files', 'staff_qualifications']
    : key === ROLE_OPERATIONS_KEY ? ['role_operations'] : ['password_reset_codes'];
// Files first, so a record copied across already finds its photo or document on the other side
// (Login sessions stay in the main database only)
export const SYNC_ORDER = ['stored_files', ...Object.keys(SCHEMA_OF).filter(t => t !== 'stored_files' && t !== 'sessions')];
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
export function mirrorChanged(tables) {
    if (!mirrorState.configured) return;
    tables.forEach(t => tablesToSync.add(t));
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
        const batch = [...tablesToSync];
        tablesToSync.clear();
        mirrorQueue = mirrorQueue.then(() => syncWithMirror(batch)).catch(() => { });
    }, MIRROR_DELAY_MS);
}
export async function startMirror() {
    const config = await loadConfig().catch(() => ({}));
    mirrorState.configured = !!config.mirror;
    if (!mirrorState.configured) return;
    mirrorChanged(SYNC_ORDER);
    setInterval(() => mirrorChanged(SYNC_ORDER), MIRROR_FULL_SYNC_MS);
}
