/* ---------- One course "1 YEAR", not "1 YEARS" (user's wish, 2026-11-26) ----------
   A course sharing its name with another is known by its name with award and duration, e.g.
   "BeautyTherapy (Certificate, 1 YEAR)". Courses saved before 2026-11-26 said "1 YEARS" (or 1 MONTHS...). When the
   server starts, each such course is renamed once, everywhere its name is kept: the course itself
   (Settings > Courses) and every text value equal to the old name in every table of the system (students,
   applications, Semester Schedule, units, registers, exams, finance...). Doing it again finds nothing to change.
   Changes are made in the main database; the office copy follows through the sync. */
import { pool } from '../core/connection.mjs';
import { SCHEMA_OF } from '../core/database.mjs';
import { SYNC_ORDER, mirrorChanged } from '../sync/mirror.mjs';

const PLURAL_ONE = /\b1 (YEAR|MONTH|WEEK|DAY)S\b/;
const quote = name => '"' + String(name).replace(/"/g, '""') + '"';

export async function renameOneUnitCourses() {
    const { rows } = await pool.query(`SELECT id, name, duration, duration_type, extra FROM settings.courses`);
    const renames = [];
    for (const c of rows) {
        const suffix = (c.extra || {}).labelSuffix;
        const typeFix = Number(c.duration) === 1 && /S$/i.test(c.duration_type || '');
        if (!(suffix && PLURAL_ONE.test(suffix)) && !typeFix) continue;
        const newSuffix = suffix ? suffix.replace(PLURAL_ONE, '1 $1') : suffix;
        await pool.query(`UPDATE settings.courses SET duration_type = $2,
            extra = CASE WHEN $3::text IS NULL THEN extra ELSE jsonb_set(extra, '{labelSuffix}', to_jsonb($3::text)) END WHERE id = $1`,
            [c.id, typeFix ? String(c.duration_type).replace(/S$/i, '') : c.duration_type, newSuffix || null]);
        if (suffix !== newSuffix) renames.push([`${c.name} (${suffix})`, `${c.name} (${newSuffix})`]);
        else renames.push(null);
    }
    if (!renames.length) return 0;
    const named = renames.filter(Boolean);
    if (named.length) {
        // Every text column (and every top-level value of a jsonb column) holding an old name gets the new one
        const schemas = [...new Set(Object.values(SCHEMA_OF))];
        const { rows: columns } = await pool.query(`SELECT table_schema, table_name, column_name, data_type
            FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
            WHERE t.table_type = 'BASE TABLE' AND table_schema = ANY($1) AND data_type IN ('text', 'character varying', 'jsonb')
              AND NOT (table_schema = 'settings' AND table_name = 'courses' AND column_name = 'name')`, [schemas]);
        for (const [from, to] of named) {
            for (const col of columns) {
                const table = `${quote(col.table_schema)}.${quote(col.table_name)}`, column = quote(col.column_name);
                if (col.data_type === 'jsonb') {
                    await pool.query(`UPDATE ${table} SET ${column} = (SELECT jsonb_object_agg(k, CASE WHEN v = to_jsonb($1::text) THEN to_jsonb($2::text) ELSE v END)
                        FROM jsonb_each(${column}) AS e(k, v)) WHERE jsonb_typeof(${column}) = 'object' AND ${column}::text LIKE '%' || $1 || '%'`, [from, to]);
                } else {
                    await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
                }
            }
            console.log(new Date().toLocaleString(), `Course renamed everywhere: "${from}" is now "${to}".`);
        }
    }
    mirrorChanged(SYNC_ORDER);
    return renames.length;
}

// Started by server.mjs: once the database is connected (tried every 20 seconds until then)
export function startCourseNameCheck(reportError = () => { }) {
    const run = () => {
        if (!pool) return setTimeout(run, 20 * 1000).unref();
        renameOneUnitCourses().catch(err => {
            console.log(new Date().toLocaleString(), 'Course names: renaming "1 YEARS" to "1 YEAR" failed:', err.message);
            reportError(err);
        });
    };
    setTimeout(run, 20 * 1000).unref();
}
