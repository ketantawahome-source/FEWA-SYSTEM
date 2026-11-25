/* ---------- private_settings.server_keys (Supabase only): passwords, keys and switches no page can see ---------- */
import { pool } from './connection.mjs';

export async function readServerKey(name) {
    const { rows } = await pool.query(`SELECT value FROM private_settings.server_keys WHERE name = $1`, [name]);
    return rows.length ? rows[0].value : null;
}
export async function writeServerKey(name, value) {
    await pool.query(`INSERT INTO private_settings.server_keys (name, value, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [name, value]);
}
