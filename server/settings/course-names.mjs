/* ---------- Course names: name (Award, length) ----------
   Every course is known by its name with its award and length, so the kinds of a course are told apart
   everywhere (user's wish, 2026-11-26), e.g.
       BeautyTherapy (Diploma, 2 YEARS)   BeautyTherapy (Certificate, 1 YEAR)   BeautyTherapy (Short Course, 3 MONTHS)
   A short course (Has Short Courses YES, or 6 months or less) says "Short Course" instead of its award, and one year
   is "1 YEAR" (not "1 YEARS"). The pages name a course this way when it is saved (StudentAdmissions.html,
   courseSuffix); courses saved before are renamed by the server when it starts, everywhere the old name is kept:
   the course itself (Settings > Courses) and every text value equal to the old name in every table of the system
   (students, applications, Semester Schedule, units, registers, exams, finance...). Doing it again finds nothing
   to change. Changes are made in the main database; the office copy follows through the sync. */
import { pool } from '../core/connection.mjs';
import { SCHEMA_OF } from '../core/database.mjs';
import { isShortCourse } from '../short-courses/short-courses.mjs';
import { SYNC_ORDER, mirrorChanged } from '../sync/mirror.mjs';

const quote = name => '"' + String(name).replace(/"/g, '""') + '"';

// "1 YEAR", "2 YEARS", "3 MONTHS"
function durationText(duration, type) {
    const n = Number(duration), base = String(type || '').toUpperCase().replace(/S$/, '');
    return [duration, base && (n === 1 ? base : base + 'S')].filter(v => v !== null && v !== undefined && v !== '').join(' ');
}
// The part in brackets: "Diploma, 2 YEARS", "Certificate, 1 YEAR", "Short Course, 3 MONTHS"
export function courseSuffix(course) {
    const award = isShortCourse(course) ? 'Short Course' : course.award;
    return [award, course.duration ? durationText(course.duration, course.durationType) : ''].filter(Boolean).join(', ');
}

export async function syncCourseNames() {
    const { rows } = await pool.query(`SELECT id, name, award, duration, duration_type, has_short_courses, extra FROM settings.courses`);
    const renames = [];
    for (const row of rows) {
        const course = { name: row.name, award: row.award, duration: row.duration, durationType: row.duration_type,
            hasShortCourses: row.has_short_courses };
        const oldSuffix = (row.extra || {}).labelSuffix || '';
        // One is singular: 1 YEAR (the duration type follows the number)
        const type = row.duration_type && Number(row.duration) === 1 ? String(row.duration_type).replace(/S$/i, '')
            : row.duration_type && Number(row.duration) > 1 && !/S$/i.test(row.duration_type) ? row.duration_type + 'S' : row.duration_type;
        const newSuffix = courseSuffix({ ...course, durationType: type });
        if (oldSuffix === newSuffix && type === row.duration_type) continue;
        await pool.query(`UPDATE settings.courses SET duration_type = $2,
            extra = CASE WHEN $3::text = '' THEN extra - 'labelSuffix' ELSE jsonb_set(extra, '{labelSuffix}', to_jsonb($3::text)) END WHERE id = $1`,
            [row.id, type, newSuffix]);
        const label = suffix => suffix ? `${row.name} (${suffix})` : row.name;
        if (oldSuffix !== newSuffix) renames.push([label(oldSuffix), label(newSuffix)]);
    }
    if (!renames.length) return 0;
    // Every text column (and every top-level value of a jsonb column) holding an old name gets the new one
    const schemas = [...new Set(Object.values(SCHEMA_OF))];
    const { rows: columns } = await pool.query(`SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE t.table_type = 'BASE TABLE' AND table_schema = ANY($1) AND data_type IN ('text', 'character varying', 'jsonb')
          AND NOT (table_schema = 'settings' AND table_name = 'courses' AND column_name = 'name')`, [schemas]);
    for (const [from, to] of renames) {
        for (const col of columns) {
            const table = `${quote(col.table_schema)}.${quote(col.table_name)}`, column = quote(col.column_name);
            if (col.data_type === 'jsonb') {
                await pool.query(`UPDATE ${table} SET ${column} = (SELECT jsonb_object_agg(k, CASE WHEN v = to_jsonb($1::text) THEN to_jsonb($2::text) ELSE v END)
                    FROM jsonb_each(${column}) AS e(k, v)) WHERE jsonb_typeof(${column}) = 'object'
                    AND EXISTS (SELECT 1 FROM jsonb_each(${column}) AS x(k, v) WHERE x.v = to_jsonb($1::text))`, [from, to]);
            } else {
                await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
            }
        }
        console.log(new Date().toLocaleString(), `Course renamed everywhere: "${from}" is now "${to}".`);
    }
    mirrorChanged(SYNC_ORDER);
    return renames.length;
}

// Started by server.mjs: once the database is connected (tried every 20 seconds until then)
export function startCourseNameCheck(reportError = () => { }) {
    const run = () => {
        if (!pool) return setTimeout(run, 20 * 1000).unref();
        syncCourseNames().catch(err => {
            console.log(new Date().toLocaleString(), 'Course names: renaming failed:', err.message);
            reportError(err);
        });
    };
    setTimeout(run, 20 * 1000).unref();
}
