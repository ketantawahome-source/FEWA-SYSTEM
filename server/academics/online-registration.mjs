/* ---------- Online unit registration by the student (Student Portal > Academics > Unit Registration) ----------
   (user's wish, 2026-11-26) A logged-in student registers their own units for the period that is open now:
     GET  /api/my-registration   the open period, the student's course and its units (Manage Units > Course units, and
                                 any unit on offer to them), with category, year / semester and whether already registered;
                                 the course's units are listed even while registration is closed
     POST /api/my-registration   { units: ['MSS', ...] }  registers those units (only units of the student's course; one not
                                 yet on offer in the period is put on offer for their course and batch / year)
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
    if (student.activeStudent === 'no') return { ...base, open: false, reason: 'Your student account is not active. Please contact the college office.', units: [] };
    if (!student.admissionCourse) return { ...base, open: false, reason: 'You are not on a course yet. Please contact the college office.', units: [] };
    // Closed: the reason, and the dates behind it (the deadline that elapsed, or when registration opens) for the portal's notice
    const closed = async (reason, dates = {}) => ({ ...base, open: false, reason, ...dates, term: '', termLabel: '', units: await courseUnits(student, '', '', []) });

    let term = '', termLabel = '', batch = student.group || '';
    if (short) {
        // The whole course is one period, open while the course runs
        if (student.courseEndDate && day(student.courseEndDate) < today) return closed('Your course has ended.', { courseEnded: day(student.courseEndDate) });
        term = 'SEMESTER 1';
        termLabel = `${lengthText(course)} (whole course)`;
        batch = yearOf(student);
    } else {
        const ofMine = (await getAllRecords('period_schedules')).filter(p => p.course === student.admissionCourse
            && (!p.batch || p.batch === student.group) && p.startDate && p.endDate);
        const schedules = ofMine.filter(p => day(p.startDate) <= today && today <= day(p.endDate));
        if (!schedules.length) {
            // The last semester that ended (its deadline elapsed) and the next one to start
            const ended = ofMine.filter(p => day(p.endDate) < today).sort((a, b) => day(b.endDate).localeCompare(day(a.endDate)))[0];
            const next = ofMine.filter(p => day(p.startDate) > today).sort((a, b) => day(a.startDate).localeCompare(day(b.startDate)))[0];
            return closed('Registration is closed: no semester of your course is running today (Semester Schedule). You can see your course units below; please contact the college office.',
                { deadlineElapsed: ended ? day(ended.endDate) : '', deadlinePeriod: ended ? ended.period : '', opensOn: next ? day(next.startDate) : '', opensPeriod: next ? next.period : '' });
        }
        // A batch's own period before one for every batch
        const now = schedules.find(p => p.batch === student.group) || schedules[0];
        term = now.period;
        termLabel = `${now.period} (${day(now.startDate).split('-').reverse().join('/')} to ${day(now.endDate).split('-').reverse().join('/')})`;
    }

    const offers = await getAllRecords('unit_offers');
    const offered = offers.filter(o => same(o.term, term) && (!o.course || o.course === student.admissionCourse)
        && (!o.batch || same(o.batch, batch)) && (!o.groupCategory || same(o.groupCategory, student.studySession)));
    const list = await courseUnits(student, term, batch, offered);
    // The day registration for this period closes (the semester's end, or the short course's end)
    const closesOn = short ? day(student.courseEndDate || '') : day((await getAllRecords('period_schedules')).find(p => p.course === student.admissionCourse
        && p.period === term && (!p.batch || p.batch === student.group) && day(p.startDate) <= today && today <= day(p.endDate))?.endDate || '');
    return { ...base, open: true, term, termLabel, batch, units: list, closesOn };
}

// The units of the student's course (Manage Units > Course units, for their batch / year or every one), plus any unit
// on offer to them in the period; each with its category, year / semester, lecturer and whether already registered
async function courseUnits(student, term, batch, offered) {
    const [units, mapped, registrations] = await Promise.all([getAllRecords('units'), getAllRecords('programme_units'), getAllRecords('unit_registrations')]);
    const mine = registrations.filter(r => r.studentId === student.id);
    const ofCourse = mapped.filter(p => p.course === student.admissionCourse && (!p.batch || !batch || same(p.batch, batch)));
    const codes = [...new Set([...ofCourse.map(p => String(p.unitCode || '').toUpperCase()), ...offered.map(o => String(o.unitCode || '').toUpperCase())].filter(Boolean))];
    const list = codes.map(code => {
        const unit = units.find(u => same(u.code, code)) || {};
        const map = ofCourse.find(p => same(p.unitCode, code)) || {};
        const offer = offered.find(o => same(o.unitCode, code)) || {};
        return { code: unit.code || code, title: unit.title || '', creditHours: unit.creditHours ?? '', category: clusterName(map.unitType),
            yearOfStudy: map.yearOfStudy || '', semester: map.semester || '', lecturerName: offer.lecturerName || '', onOffer: !!offer.unitCode,
            registered: term ? mine.some(r => same(r.term, term) && same(r.unitCode, code)) : mine.some(r => same(r.unitCode, code)) };
    });
    return list.sort((a, b) => (Number(a.yearOfStudy) || 0) - (Number(b.yearOfStudy) || 0) || (Number(a.semester) || 0) - (Number(b.semester) || 0)
        || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
}

// Registers the chosen units (each only once, and only units on offer to the student now)
export async function registerOnline(studentId, body) {
    const state = await registrationState(studentId);
    if (!state.open) throw problem(state.reason);
    const wanted = [...new Set((Array.isArray(body && body.units) ? body.units : []).map(c => String(c || '').trim().toUpperCase()).filter(Boolean))];
    if (!wanted.length) throw problem('Choose at least one unit.');
    if (wanted.length > 30) throw problem('Too many units at once.');
    const notOffered = wanted.filter(code => !state.units.some(u => same(u.code, code)));
    if (notOffered.length) throw problem(`Not a unit of your course: ${notOffered.join(', ')}.`);
    const student = await getRecord('students', studentId);
    const offers = await getAllRecords('unit_offers');
    const added = [];
    let offersAdded = false;
    for (const code of wanted) {
        const unit = state.units.find(u => same(u.code, code));
        if (unit.registered) continue;
        let offer = offers.find(o => same(o.term, state.term) && same(o.unitCode, code) && (!o.course || o.course === state.course)
            && (!o.batch || same(o.batch, state.batch)));
        if (!offer) {
            const offerId = Date.now().toString(36) + randomBytes(4).toString('hex');
            offer = { id: offerId, term: state.term, unitCode: unit.code, course: state.course, batch: state.batch, lecturer: '', lecturerName: '' };
            await putRecord('unit_offers', offerId, offer);
            offers.push(offer);
            offersAdded = true;
        }
        const id = Date.now().toString(36) + randomBytes(4).toString('hex');
        await putRecord('unit_registrations', id, { id, studentId: student.id, admNo: student.admNo, term: state.term, unitCode: unit.code,
            registeredAt: new Date().toISOString(), registeredBy: 'Student (online)', examReason: 'First attempt',
            lecturer: offer.lecturer || '', lecturerName: offer.lecturerName || '', registrationClass: state.course, batch: state.batch });
        added.push(unit.code);
    }
    if (added.length) mirrorChanged(offersAdded ? ['unit_offers', 'unit_registrations'] : ['unit_registrations']);
    return { result: 'ok', added, state: await registrationState(studentId) };
}
