/* ---------- Record stores: reading and writing the system's records ---------- */
import { inTransaction, pool } from '../core/connection.mjs';
import { ACADEMIC_STORES, ADMIN_STORES, COLUMN_TABLES, SCHEMA_OF, SETTING_FORMS, SETTING_LISTS, T, recordFromRow, rowFromRecord, sqlName, tableColumns, upsertRow } from '../core/database.mjs';
import { deleteUnusedFiles, fileIdsIn, storeNewFiles } from '../files/stored-files.mjs';
import { deleteSetting, readSetting, writeSetting } from '../settings/settings.mjs';

/* ---------- Record stores: students, documents, deferrals (columns) and settings (tables above) ---------- */
export const STORES = { students: 'id', documents: 'id', deferrals: 'id', applications: 'id', settings: 'key',
    ...Object.fromEntries(ACADEMIC_STORES.map(store => [store, 'id'])), ...Object.fromEntries(ADMIN_STORES.map(store => [store, 'id'])) };
const hasColumns = store => COLUMN_TABLES.includes(store);
export async function selectRecords(db, store, id) {
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
export const getAllRecords = store => selectRecords(pool, store);
export async function getRecord(store, id) {
    const [record] = await selectRecords(pool, store, id);
    return record || null;
}
export async function putRecord(store, id, record) {
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
export async function deleteRecord(store, id) {
    await inTransaction(async client => {
        const before = await removeRecord(client, store, id);
        if (before) await deleteUnusedFiles(client, before, null);
    });
}
// Restoring a backup: every record is written; without merge, everything else in the store is removed first
export async function replaceRecords(store, records, merge) {
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
