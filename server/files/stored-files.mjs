/* ---------- Photos and documents inside records ---------- */
import { randomBytes } from 'node:crypto';
import { T } from '../core/database.mjs';

/* ---------- Files inside records ---------- */
const newFileId = () => Date.now().toString(36) + randomBytes(8).toString('hex');
// Stores every new file in the record and puts a reference to it in its place
export async function storeNewFiles(client, value) {
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
export function fileIdsIn(value, ids = new Set()) {
    if (Array.isArray(value)) value.forEach(v => fileIdsIn(v, ids));
    else if (value && typeof value === 'object') {
        if (value.__file) ids.add(value.__file);
        else Object.values(value).forEach(v => fileIdsIn(v, ids));
    }
    return ids;
}
// Files the old version of a record had and the new one no longer uses are deleted
export async function deleteUnusedFiles(client, before, after) {
    const keep = fileIdsIn(after);
    const unused = [...fileIdsIn(before)].filter(id => !keep.has(id));
    if (unused.length) await client.query(`DELETE FROM ${T('stored_files')} WHERE id = ANY($1)`, [unused]);
}
