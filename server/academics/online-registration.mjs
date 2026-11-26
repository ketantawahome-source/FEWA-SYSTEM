/* ---------- Online unit registration by the student (Student Portal > Academics > Unit Registration) ----------
   (user's wish, 2026-11-26) A logged-in student registers their own units for the period that is open now:
     GET  /api/my-registration   the open period, the student's course and the units on offer to them (with their
                                 category: Course units / Common units, year / semester, and whether already registered)
     POST /api/my-registration   { units: ['MSS', ...] }  registers those units (only units on offer to the student)
   The period open now comes from the Semester Schedule: the period of the student's course (and batch, or every batch)
   whose start and end dates include today (Kenya time). A short course has no semesters: the whole course, open from
   the student's Course Start Date until the course ends. The registrations are the same records staff make in Manage
   Units (academics.unit_registrations), marked registeredBy "Student (online)", so staff see them at once. */
import { getAllRecords, getRecord, putRecord } from '../stores/stores.mjs';
import { isShortCourse, kenyaDay } from '../short-courses/short-courses.mjs';
import { mirrorChanged } from '../sync/mirror.mjs';
import { randomBytes } from 'node:crypto';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const day = value => String(value || '').slice(0, 10);
const courseLabel = c => c.labelSuffix && c.name ? `${c.name} (${c.labelSuffix})` : c.name;
const clusterName = t => /common|elective/i.test(String(t || '')) ? 'Common units' : 'Course units';
const lengthText = c => {
    const n = Number(c && c.duration) || 3, t = String((c && c.durationType) || 'MONTHS').toUpperCase().replace(/S$/, '');
    return `${n} ${n === 1 ? t : t + 'S'}`;
};
// A short course student's Academic Year: the saved year, else the year of their Course Start Date, else of the day added
const yearOf = s => /^\d{4}$/.test(String(s.group || '').trim()) ? String(s.group).trim() : String(s.courseStartDate || s.createdAt || '').slice(0, 4);

// Everything the portal needs about the student's registration now
export async function registrationState(studentId) {
    const student = await getRecord('students', studentId);
    if (!student) throw problem('Your student record was not found. Please log in again.', 403);
    const courses = ((await getRecord('settings', 'courses')) || {}).items || [];
    const course = courses.find(c => courseLabel(c) === student.admissionCourse) || null;
    const short = isShortCourse(course || {});
    const today = kenyaDay();
    const base = { course: student.admissionCourse || '', short, studySession: student.studySession || '' };
    if (student.activeStudent === 'no') return { ...base, open: false, reason: 'Your student account is not active. Please contact the college office.' };
    if (!student.admissionCourse) return { ...base, open: false, reason: 'You are not on a course yet. Please contact the college office.' };

    let term = '', termLabel = '', batch = student.group || '';
    if (short) {
        // The whole course is one period, open while the course runs
        if (student.courseEndDate && day(student.courseEndDate) < today) return { ...base, open: false, reason: 'Your course has ended.' };
        term = 'SEMESTER 1';
        termLabel = `${lengthText(course)} (whole course)`;
        batch = yearOf(student);
    } else {
        const schedules = (await getAllRecords('period_schedules')).filter(p => p.course === student.admissionCourse
            && (!p.batch || p.batch === student.group) && p.startDate && p.endDate && day(p.startDate) <= today && today <= day(p.endDate));
        if (!schedules.length) {
            return { ...base, open: false, reason: 'Registration is closed: no semester of your course is running today (Semester Schedule). Please contact the college office.' };
        }
        // A batch's own period before one for every batch
        const now = schedules.find(p => p.batch === student.group) || schedules[0];
        term = now.period;
        termLabel = `${now.period} (${day(now.startDate).split('-').reverse().join('/')} to ${day(now.endDate).split('-').reverse().join('/')})`;
    }

    // The units on offer to the student in that period: their course (or every course), batch / year (or every one)
    // and study session (or every one)
    const [offers, units, mapped, registrations] = await Promise.all([getAllRecords('unit_offers'), getAllRecords('units'),
        getAllRecords('programme_units'), getAllRecords('unit_registrations')]);
    const mine = registrations.filter(r => r.studentId === student.id);
    const offered = offers.filter(o => same(o.term, term) && (!o.course || o.course === student.admissionCourse)
        && (!o.batch || same(o.batch, batch)) && (!o.groupCategory || same(o.groupCategory, student.studySession)));
    const seen = new Set();
    const list = [];
    for (const o of offered) {
        const code = String(o.unitCode || '').toUpperCase();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const unit = units.find(u => same(u.code, code)) || {};
        const map = mapped.find(p => p.course === student.admissionCourse && same(p.unitCode, code)) || {};
        list.push({ code: unit.code || o.unitCode, title: unit.title || '', creditHours: unit.creditHours ?? '',
            category: clusterName(map.unitType), yearOfStudy: map.yearOfStudy || '', semester: map.semester || '',
            lecturerName: o.lecturerName || '', registered: mine.some(r => same(r.term, term) && same(r.unitCode, code)) });
    }
    list.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    return { ...base, open: true, term, termLabel, batch, units: list,
        registered: mine.filter(r => same(r.term, term)).map(r => r.unitCode) };
}

// Registers the chosen units (each only once, and only units on offer to the student now)
export async function registerOnline(studentId, body) {
    const state = await registrationState(studentId);
    if (!state.open) throw problem(state.reason);
    const wanted = [...new Set((Array.isArray(body && body.units) ? body.units : []).map(c => String(c || '').trim().toUpperCase()).filter(Boolean))];
    if (!wanted.length) throw problem('Choose at least one unit.');
    if (wanted.length > 30) throw problem('Too many units at once.');
    const notOffered = wanted.filter(code => !state.units.some(u => same(u.code, code)));
    if (notOffered.length) throw problem(`Not on offer to you now: ${notOffered.join(', ')}.`);
    const student = await getRecord('students', studentId);
    const offers = await getAllRecords('unit_offers');
    const added = [];
    for (const code of wanted) {
        const unit = state.units.find(u => same(u.code, code));
        if (unit.registered) continue;
        const offer = offers.find(o => same(o.term, state.term) && same(o.unitCode, code) && (!o.course || o.course === state.course)
            && (!o.batch || same(o.batch, state.batch))) || {};
        const id = Date.now().toString(36) + randomBytes(4).toString('hex');
        await putRecord('unit_registrations', id, { id, studentId: student.id, admNo: student.admNo, term: state.term, unitCode: unit.code,
            registeredAt: new Date().toISOString(), registeredBy: 'Student (online)', examReason: 'First attempt',
            lecturer: offer.lecturer || '', lecturerName: offer.lecturerName || '', registrationClass: state.course, batch: state.batch });
        added.push(unit.code);
    }
    if (added.length) mirrorChanged(['unit_registrations']);
    return { result: 'ok', added, state: await registrationState(studentId) };
}
