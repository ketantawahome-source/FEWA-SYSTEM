/* ---------- Online applications (apply.html) ---------- */
import { randomBytes } from 'node:crypto';
import { clientIp } from '../auth/sessions.mjs';
import { pool } from '../core/connection.mjs';
import { T } from '../core/database.mjs';
import { closedMessage, globalControls } from '../global-settings/global-settings.mjs';
import { sendSystemEmail } from '../messaging/email.mjs';
import { getRecord, putRecord } from '../stores/stores.mjs';
import { STORE_TABLES, mirrorChanged } from '../sync/mirror.mjs';

/* ---------- Online applications (apply.html): anyone may apply, without logging in ----------
   The form's Admission Details are the same as the student admission form's, with the choices from Settings:
   Campus, Admission Course, Study Session, Enrollment, and Student Type and Group (shown, not chosen: the first of
   each list, given to the student on Admit). An application is checked here (required fields, email, date of
   birth, file types and sizes), saved in students.applications as a Prospect, and appears in Student Hub > Online
   Applications, where staff verify, Admit (into a new student record) or Reject it. */
const APPLY_TEXT = ['campus', 'admissionCourse', 'studySession', 'enrollment', 'firstName', 'middleName', 'lastName',
    'languages', 'dob', 'gender', 'nationality', 'countryOfResidence', 'cityOfResidence', 'idBirthCert', 'heardAbout',
    'location', 'town', 'phone', 'email',
    ...['father', 'mother'].flatMap(p => ['FirstName', 'MiddleName', 'LastName', 'Phone', 'Phone2', 'Email', 'IdType',
        'NationalId', 'Nationality', 'Relationship'].map(f => p + f))];
const APPLY_REQUIRED = ['admissionCourse', 'firstName', 'lastName', 'languages',
    'dob', 'gender', 'nationality', 'countryOfResidence', 'cityOfResidence', 'heardAbout', 'location', 'town', 'phone',
    'email', 'fatherFirstName', 'fatherLastName', 'fatherPhone', 'fatherEmail', 'fatherIdType', 'fatherNationalId',
    'fatherNationality', 'fatherRelationship'];
// The second parent / guardian is optional; once any of their details is given, these are needed too
const APPLY_SECOND_REQUIRED = ['motherFirstName', 'motherLastName', 'motherPhone', 'motherRelationship'];
const APPLY_FILES = {
    photo: { label: 'Passport photo', types: ['image/jpeg', 'image/png'], required: true },
    birthCertificate: { label: 'Birth certificate', types: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    fatherIdCopy: { label: 'ID copy (first contact)', types: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    motherIdCopy: { label: 'ID copy (second contact)', types: ['image/jpeg', 'image/png', 'application/pdf'], required: false }
};
const APPLY_MAX_FILE_BYTES = 5 * 1024 * 1024;
const APPLY_PER_HOUR = 5;
const APPLY_PER_HOUR_EVERYWHERE = 100; // the address a request says it comes from can be faked, so this counts them all
const APPLY_AT_ONCE = 5;
const applyCounts = new Map(); // IP (and 'everywhere') -> { count, first }
let applicationsBeingSent = 0;
// Counted while an application is being received (the API module calls these)
export const applicationStarted = () => { applicationsBeingSent++; };
export const applicationEnded = () => { applicationsBeingSent--; };
// Asked before reading what was sent, so a flood of large requests is turned away cheaply
export function checkApplyLimits(req) {
    const tooMany = message => Object.assign(new Error(message), { status: 429 });
    const over = (key, limit) => {
        const seen = applyCounts.get(key);
        return !!seen && Date.now() - seen.first < 3600000 && seen.count >= limit;
    };
    if (over(clientIp(req), APPLY_PER_HOUR)) throw tooMany('Too many applications were sent from this connection. Please try again in an hour.');
    if (over('everywhere', APPLY_PER_HOUR_EVERYWHERE)) throw tooMany('Too many applications are being sent right now. Please try again in an hour.');
    if (applicationsBeingSent >= APPLY_AT_ONCE) throw tooMany('The system is busy. Please try again in a minute.');
}
function countApplication(req) {
    if (applyCounts.size > 20000) applyCounts.clear();
    for (const key of [clientIp(req), 'everywhere']) {
        const seen = applyCounts.get(key);
        applyCounts.set(key, seen && Date.now() - seen.first < 3600000 ? { ...seen, count: seen.count + 1 } : { count: 1, first: Date.now() });
    }
}
// The choices, as the admission form has them (a list never saved in Settings has the same defaults as there)
export async function applicationOptions() {
    // A course sharing its name with another is known by its name with award and duration, as on the pages
    const names = async (key, defaults = [], usable = () => true) => {
        const record = await getRecord('settings', key);
        return (record ? record.items || [] : defaults.map(name => ({ name }))).filter(usable)
            .map(i => i.labelSuffix && i.name ? `${i.name} (${i.labelSuffix})` : i.name).filter(Boolean);
    };
    const organization = (await getRecord('settings', 'organization')) || {};
    const controls = await globalControls();
    return {
        collegeName: organization.collegeName || '',
        // Global Settings: applications closed (or the whole system closed)
        closed: !controls.systemOpen || !controls.applications,
        closedMessage: !controls.systemOpen ? closedMessage(controls) : '',
        campuses: await names('campuses'),
        courses: await names('courses', [], c => c.enabled !== 'NO'),
        studySessions: await names('studySessions', ['Full Time', 'Part Time']),
        enrollments: await names('enrollmentTypes', [], e => e.status !== 'Inactive'),
        studentType: (await names('studentTypes', ['STUDENT']))[0] || '',
        // The batch new students get (Settings > Organisation Setup > Batches): the next to start, else the one running
        group: await batchForApplicants()
    };
}
async function batchForApplicants() {
    const record = await getRecord('settings', 'batches');
    const today = new Date().toISOString().slice(0, 10);
    const items = ((record && record.items) || []).filter(b => b.name && b.dateFrom)
        .sort((a, b) => String(a.dateFrom).localeCompare(String(b.dateFrom)));
    const next = items.find(b => b.dateFrom > today);
    const running = items.find(b => b.dateFrom <= today && today <= (b.dateTo || b.dateFrom));
    return (next || running || items[items.length - 1] || {}).name || '';
}
export async function receiveApplication(req, body) {
    const problem = message => Object.assign(new Error(message), { status: 400 });
    body = body && typeof body === 'object' ? body : {};
    if (body.website) return { result: 'ok', reference: 'APP-' + randomBytes(3).toString('hex').toUpperCase() }; // a robot

    const record = {};
    for (const field of APPLY_TEXT) {
        const value = String(body[field] ?? '').trim();
        if (value.length > 300) throw problem('One of the answers is too long.');
        if (value) record[field] = value;
    }
    const options = await applicationOptions();
    if (options.closed) throw Object.assign(new Error('Online applications are closed at the moment.'), { status: 403 });
    const missing = APPLY_REQUIRED.filter(f => !record[f]);
    // Campus and Enrollment are asked for once the college has set them up in Settings
    if (options.campuses.length && !record.campus) missing.push('campus');
    if (options.enrollments.length && !record.enrollment) missing.push('enrollment');
    const secondGiven = Object.keys(record).some(f => f.startsWith('mother')) || !!body.motherIdCopy;
    if (secondGiven) missing.push(...APPLY_SECOND_REQUIRED.filter(f => !record[f]));
    if (missing.length) throw problem('Please fill in every field marked *.');

    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const f of ['email', 'fatherEmail', 'motherEmail']) {
        if (record[f] && !email.test(record[f])) throw problem('One of the email addresses is not valid.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.dob) || isNaN(new Date(record.dob)) || record.dob > new Date().toISOString().slice(0, 10)) {
        throw problem('The date of birth is not valid.');
    }
    if (!['FEMALE', 'MALE'].includes(record.gender)) throw problem('Please choose the gender.');

    const fromList = (field, list, name) => {
        if (record[field] && !list.includes(record[field])) throw problem(`Please choose the ${name} from the list.`);
    };
    fromList('campus', options.campuses, 'campus');
    fromList('admissionCourse', options.courses, 'course');
    fromList('studySession', options.studySessions, 'study session');
    fromList('enrollment', options.enrollments, 'enrollment');
    // Not the applicant's choice: the college's first Student Type and Group, given to the student on Admit
    if (options.studentType) record.studentType = options.studentType;
    if (options.group) record.admissionGroup = options.group;

    for (const [field, rule] of Object.entries(APPLY_FILES)) {
        const file = body[field];
        if (!file || !file.data) {
            if (rule.required) throw problem(`Please attach the ${rule.label.toLowerCase()}.`);
            continue;
        }
        if (!rule.types.includes(file.type)) throw problem(`${rule.label}: only ${rule.types.includes('application/pdf') ? 'PDF, ' : ''}JPG or PNG files are accepted.`);
        if (String(file.data).length * 3 / 4 > APPLY_MAX_FILE_BYTES) throw problem(`${rule.label}: the file is larger than 5MB.`);
        record[field] = { __newFile: true, type: file.type, name: String(file.name || field).slice(0, 120), data: String(file.data) };
    }

    // Each applicant is a prospect, with the next prospect number (PRP-00001, PRP-00002, ...) and in the PROSPECT group
    const id = 'app-' + Date.now().toString(36) + randomBytes(4).toString('hex');
    let reference;
    for (let attempt = 0; ; attempt++) {
        const { rows } = await pool.query(`SELECT coalesce(max(substring(reference FROM '^PRP-([0-9]+)$')::int), 0) AS last
            FROM ${T('applications')}`);
        reference = 'PRP-' + String(rows[0].last + 1).padStart(5, '0');
        try {
            await putRecord('applications', id, { ...record, id, reference, status: 'Prospect', group: 'PROSPECT',
                submittedAt: new Date().toISOString() });
            break;
        } catch (err) {
            // Two applications sent at the same moment got the same number: the second takes the next one
            if (err.code !== '23505' || attempt >= 4) throw err;
        }
    }
    mirrorChanged(STORE_TABLES.applications);
    countApplication(req);

    // The applicant gets their prospect number by email too (the application is kept whether or not it goes)
    const college = options.collegeName || 'FEWA Beauty & Fashion College';
    const emailed = await sendSystemEmail(record.email,
        `Dear ${record.firstName} ${record.lastName}, thank you for applying to ${college}` +
        `${record.admissionCourse ? ` for ${record.admissionCourse}` : ''}${record.enrollment ? ` (${record.enrollment} intake)` : ''}. ` +
        `Your application has been received and your prospect number is ${reference}. Please keep this number. ` +
        'The admissions office will check your details and documents and contact you on the phone number or email you gave. ' +
        'Once you are admitted you will receive your admission number and your Student Portal login.');
    return { result: 'ok', reference, emailed };
}
