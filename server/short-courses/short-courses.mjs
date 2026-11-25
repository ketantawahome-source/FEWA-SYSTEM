/* ---------- Short courses (3 months) ----------
   A short course runs in a batch of its own: Settings > Organisation Setup > Batches, Batch Type
   "SHORT COURSE (3 MONTHS)" (e.g. Jan 2027 - Mar 2027 (Short course)). A course is a short course when it is set up
   with "Has Short Courses" YES (Settings > Program Setup > Courses, its short courses ticked), or lasts 6 months or less.

   - Online applicants for a short course get the next short course batch of the course's school (shortBatchFor).
   - A short course student joins any day of the year: the course runs from their own Course Start Date (student
     form; else the day they were added) for the course's length (e.g. 3 MONTHS). Once that has ended (Kenya time)
     they are made inactive by the system (a short course batch student with no start date of their own ends with
     the batch): status Inactive, reason "Short course completed", the end date as the exit date, a line in the
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

// The short course with this name (as students and applicants have it), or null
export async function shortCourseNamed(name) {
    const courses = ((await getRecord('settings', 'courses')) || {}).items || [];
    const course = courses.find(c => courseLabel(c) === name);
    return course && isShortCourse(course) ? course : null;
}
export const kenyaDay = kenyaToday;

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

// The last day of a course that starts on `start` (YYYY-MM-DD): start + its length (e.g. 3 MONTHS), less a day
export function courseEnd(start, course) {
    if (!start) return '';
    const [y, m, d] = start.split('-').map(Number);
    const n = Number(course && course.duration) || 3;
    const t = String((course && course.durationType) || 'MONTHS').toUpperCase().replace(/S$/, '');
    const end = t === 'YEAR' ? new Date(Date.UTC(y + n, m - 1, d - 1)) : t === 'WEEK' ? new Date(Date.UTC(y, m - 1, d + n * 7 - 1))
        : t === 'DAY' ? new Date(Date.UTC(y, m - 1, d + n - 1)) : new Date(Date.UTC(y, m - 1 + n, d - 1));
    return end.toISOString().slice(0, 10);
}

/* Every active short course student whose course has ended is made inactive; returns how many.
   A student joins any day: their own Course Start Date (student form), else the day they were added, plus the
   course's length. A student of a short course batch (Settings > Batches) with no start date of their own ends
   with the batch. */
export async function endFinishedShortCourses() {
    const today = kenyaToday();
    const courses = (((await getRecord('settings', 'courses')) || {}).items || []).filter(isShortCourse);
    const shortByLabel = new Map(courses.map(c => [courseLabel(c), c]));
    const batchEnd = new Map((((await getRecord('settings', 'batches')) || {}).items || [])
        .filter(b => b.batchType === SHORT_BATCH && b.name && day(b.dateTo)).map(b => [b.name, day(b.dateTo)]));
    if (!shortByLabel.size && !batchEnd.size) return 0;
    const { rows } = await pool.query(`SELECT id, admission_course, "group", created_at, extra->>'courseStartDate' AS start
        FROM ${T('students')} WHERE active_student IS DISTINCT FROM 'no'`);
    const endOf = row => {
        const course = shortByLabel.get(row.admission_course);
        const start = day(row.start) || (row.created_at ? new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }) : '');
        if (course && day(row.start)) return { end: courseEnd(start, course), why: `${course.duration} ${course.durationType} from ${start}` };
        if (batchEnd.has(row.group)) return { end: batchEnd.get(row.group), why: `batch ${row.group}` };
        if (course && start) return { end: courseEnd(start, course), why: `${course.duration} ${course.durationType} from ${start}` };
        return null;
    };
    let done = 0;
    for (const row of rows) {
        const found = endOf(row);
        if (!found || !found.end || found.end >= today) continue;
        const student = await getRecord('students', row.id);
        if (!student || student.activeStudent === 'no') continue;
        const endDate = found.end;
        const reason = `Short course completed (${found.why}, ended on ${endDate})`;
        const history = [...(student.statusHistory || [])];
        if (!history.length) history.push({ at: student.statusRecordedAt || student.createdAt || '', status: 'Active', by: '',
            date: day(student.statusRecordedAt || student.createdAt), reason: 'Admitted' });
        history.push({ at: new Date().toISOString(), status: 'Inactive', by: 'System (short course ended)', date: endDate, reason });
        await putRecord('students', row.id, {
            ...student, activeStudent: 'no', exitDate: endDate, exitReason: reason, statusRecordedAt: new Date().toISOString(),
            courseEndDate: student.courseEndDate || endDate, statusHistory: history,
            // As when the office deactivates a student: the password is cancelled, so the Student Portal login ends
            loginHash: null, loginSalt: null, mustChangePassword: true, adminResetRequired: true
        });
        done++;
    }
    if (done) {
        mirrorChanged(STORE_TABLES.students);
        console.log(new Date().toLocaleString(), `Short courses: ${done} student(s) made inactive (their short course has ended).`);
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
