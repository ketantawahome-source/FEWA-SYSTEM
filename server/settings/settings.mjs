/* ---------- Settings lists and forms, each in its own table ---------- */
import { SCHEMA_OF, SETTING_FORMS, SETTING_LISTS, T, recordFromRow, rowFromRecord, tableColumns, upsertRow, upsertRows } from '../core/database.mjs';

// The setting record a row of the "settings" table stands for
export async function readSetting(db, row) {
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
export async function writeSetting(db, record) {
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
export async function deleteSetting(db, key) {
    const { rows } = await db.query(`SELECT * FROM ${T('settings')} WHERE key = $1`, [key]);
    if (!rows.length) return undefined;
    const record = await readSetting(db, rows[0]);
    const table = rows[0].stored_in && (SETTING_LISTS[key] || SETTING_FORMS[key]);
    if (table) await db.query(`DELETE FROM ${T(table)}`);
    await db.query(`DELETE FROM ${T('settings')} WHERE key = $1`, [key]);
    return record;
}
// Settings saved by the first version (whole in settings.data) are moved into their tables
export async function moveSettingsIntoTables(client) {
    const { rows } = await client.query(`SELECT key, data FROM ${T('settings')} WHERE stored_in IS NULL AND data IS NOT NULL`);
    for (const row of rows) {
        if (!SETTING_LISTS[row.key] && !SETTING_FORMS[row.key]) continue;
        await writeSetting(client, { ...row.data, key: row.key });
        console.log(`Moved the "${row.key}" setting into the "${SETTING_LISTS[row.key] || SETTING_FORMS[row.key]}" table.`);
    }
}
