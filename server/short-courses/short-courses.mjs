/* ---------- Short courses (3 months) ----------
   A short course runs in a batch of its own: Settings > Organisation Setup > Batches, Batch Type
   "SHORT COURSE (3 MONTHS)" (e.g. Jan 2027 - Mar 2027 (Short course)). A course is a short course when it is set up
   with "Has Short Courses" YES (Settings > Program Setup > Courses, its short courses ticked), or lasts 6 months or less.

   - Online applicants for a short course get the next short course batch of the course's school (shortBatchFor).
   - When a short course batch has ended (its Date To has passed, Kenya time), its students are made inactive by
     the system: status Inactive, reason "Short course completed", the end date as the exit date, a line in the
     status history, and their Student Portal password cancelled, which also ends any login they still have.
     Checked when the server starts and then every hour (endFinishedShortCourses); doing it twice changes nothing. */
import { pool } from '../core/connection.mjs';
import { T } from '../core/database.mjs';
import { getRecord, putRecord } from '../stores/stores.mjs';
import { STORE_TABLES, mirrorChanged } from '../sync/mirror.mjs';

export const SHORT_BATCH = 'SHORT COURSE (3 MONTHS)';
const kenyaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const day = value => String(value || '').slice(0, 10);

// "Has Short Courses" YES in Settings > Program Setup > Courses (its short courses ticked there), or 6 months or less
// (YEAR / YEARS, MONTH / MONTHS... both accepted)
export function isShortCourse(course) {
    if (course && String(course.hasShortCourses || '').toUpperCase() === 'YES') return true;
    const n = Number(course && course.duration) || 0;
    const type = String((course && course.durationType) || '').toUpperCase().replace(/S$/, '');
    return n > 0 && ((type === 'MONTH' && n <= 6) || type === 'WEEK' || type === 'DAY');
}

const courseLabel = c => c.labelSuffix && c.name ? `${c.name} (${c.labelSuffix})` : c.name;

// The batch an online applicant for this course gets: for a short course, the next short course batch of the
// course's school (else the one running); '' when there is none (the usual batch is then used)
export async function shortBatchFor(courseName) {
    const courses = ((await getRecord('settings', 'courses')) || {}).items || [];
    const course = courses.find(c => courseLabel(c) === courseName);
    if (!course || !isShortCourse(course)) return '';
    const today = kenyaToday();
    const batches = (((await getRecord('settings', 'batches')) || {}).items || [])
        .filter(b => b.batchType === SHORT_BATCH && b.name && b.dateFrom && (!course.institute || !b.school || b.school === course.institute))
        .sort((a, b) => day(a.dateFrom).localeCompare(day(b.dateFrom)));
    const next = batches.find(b => day(b.dateFrom) > today);
    const running = batches.find(b => day(b.dateFrom) <= today && today <= day(b.dateTo));
    return (next || running || {}).name || '';
}

// Every student of a short course batch that has ended is made inactive; returns how many
export async function endFinishedShortCourses() {
    const today = kenyaToday();
    const ended = (((await getRecord('settings', 'batches')) || {}).items || [])
        .filter(b => b.batchType === SHORT_BATCH && b.name && day(b.dateTo) && day(b.dateTo) < today);
    if (!ended.length) return 0;
    const endOf = new Map(ended.map(b => [b.name, day(b.dateTo)]));
    const { rows } = await pool.query(`SELECT id FROM ${T('students')}
        WHERE active_student IS DISTINCT FROM 'no' AND "group" = ANY($1)`, [[...endOf.keys()]]);
    let done = 0;
    for (const { id } of rows) {
        const student = await getRecord('students', id);
        if (!student || student.activeStudent === 'no' || !endOf.has(student.group)) continue;
        const endDate = endOf.get(student.group);
        const reason = `Short course completed (batch ${student.group} ended on ${endDate})`;
        const history = [...(student.statusHistory || [])];
        if (!history.length) history.push({ at: student.statusRecordedAt || student.createdAt || '', status: 'Active', by: '',
            date: day(student.statusRecordedAt || student.createdAt), reason: 'Admitted' });
        history.push({ at: new Date().toISOString(), status: 'Inactive', by: 'System (short course ended)', date: endDate, reason });
        await putRecord('students', id, {
            ...student, activeStudent: 'no', exitDate: endDate, exitReason: reason, statusRecordedAt: new Date().toISOString(),
            statusHistory: history,
            // As when the office deactivates a student: the password is cancelled, so the Student Portal login ends
            loginHash: null, loginSalt: null, mustChangePassword: true, adminResetRequired: true
        });
        done++;
    }
    if (done) {
        mirrorChanged(STORE_TABLES.students);
        console.log(new Date().toLocaleString(), `Short courses: ${done} student(s) made inactive (their short course batch has ended).`);
    }
    return done;
}

// Started by server.mjs; each check waits until the database is connected (pool)
export function startShortCourseCheck(reportError = () => { }) {
    const run = () => pool && endFinishedShortCourses().catch(err => {
        console.log(new Date().toLocaleString(), 'Short courses: the end-of-course check failed:', err.message);
        reportError(err);
    });
    setTimeout(run, 30 * 1000).unref();
    setInterval(run, 60 * 60 * 1000).unref();
}
