/* ---------- Academic Management > Exam Management (Academics.html?page=exams) ----------
   Seven tabs, each a list kept in its own table in the "academics" schema (see database/8-academics.sql):
     Exam types            academics.exam_types          the exams of a course's batch in a period (weight, out of)
     Exam groups           academics.exam_groups         kinds of assessment, e.g. Continuous Assessment
     Grading system        academics.grading_systems     mark ranges and their grades, per named grading
     Group exam types      academics.group_exam_types    the exams that make up an exam group, e.g. CAT 1
     Awards setup          academics.award_setups        classification of a final average per award
     Course exam groups    academics.course_exam_groups  a course's exam groups and their weight in the final mark
     Exam paper types      academics.exam_paper_types    Theory, Practical, Oral...
   Each tab is described below (its fields, list columns and checks); one set of functions draws and saves them all.
   Uses the page's data and helpers from Academics.html: courseItems, groups, terms, programmes, fill, $, ... */

const EXAM_STATUS = ['OPEN', 'CLOSED'];
const ACTIVE_STATUS = ['ACTIVE', 'INACTIVE'];
let examData = {}, examActive = 'types', examEditing = null, examFind = '';
const EXAM_TAB_KEY = 'fewaExamTab';

const examRows = store => examData[store] || [];
const examNames = store => [...new Set(examRows(store).map(r => r.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const examNum = v => v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString();
const examPairs = list => list.map(v => [v, v]);
const activeGroups = () => examRows('exam_groups').filter(g => g.status !== 'INACTIVE').map(g => g.name).filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
// Class of a course: YEAR 1, YEAR 2... (its duration in years, or the years in its Course units), shown with the course
function classChoices(courseName) {
    const c = courseItems.find(x => x.name === courseName);
    if (!c) return [];
    const n = Number(c.duration) || 0, type = String(c.durationType || '').toUpperCase();
    const fromUnits = Math.max(0, ...programmeUnits.filter(p => p.course === courseName).map(p => Number(p.yearOfStudy) || 0));
    const years = Math.max(1, fromUnits, type === 'YEARS' ? n : type === 'MONTHS' ? Math.ceil(n / 12) : 1);
    return Array.from({ length: years }, (_, i) => [`YEAR ${i + 1}`, `YEAR ${i + 1} - ${courseName}`]);
}
// Exam types to choose from: those on the Exam types tab and the exam paper types
const examTypeChoices = () => [...new Set([...examRows('exam_types').map(r => r.description), ...examNames('exam_paper_types')]
    .filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
// Units to suggest: the course's units (Course units), else every unit in the Units register
function unitChoices(courseName) {
    const codes = programmeUnits.filter(p => p.course === courseName).map(p => String(p.unitCode).toUpperCase());
    return (codes.length ? units.filter(u => codes.includes(String(u.code).toUpperCase())) : units).map(unitLabel);
}

// Points with one decimal, as on grading sheets (8.0)
const examPoints = v => v === null || v === undefined || v === '' ? '' : Number(v).toFixed(1);
// Two mark ranges overlap (a mark could fall in both)
const overlaps = (a1, a2, b1, b2) => Number(a1) <= Number(b2) && Number(b1) <= Number(a2);
const weightTotal = rows => rows.reduce((s, r) => s + Number(r.weight || 0), 0);

const EXAM_TABS = [
    {
        key: 'types', title: 'Exam types', store: 'exam_types',
        banner: 'The exam types of a course for a period and batch. Choose them, fill in the exam and click Save exam type; change one with the pencil.',
        save: 'Save exam type',
        fields: [
            { name: 'course', label: 'Apply to', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- include all --', filter: true, all: true },
            { name: 'batch', label: 'Batch name', type: 'select', options: () => examPairs(groups), placeholder: '-- select one --', filter: true, all: true },
            { name: 'examGroup', label: 'Exam group', type: 'select', options: () => examPairs(activeGroups()), placeholder: '-- select one --', required: true },
            { name: 'period', label: 'Period name', type: 'select', options: () => examPairs(terms), placeholder: null, filter: true, required: true },
            { name: 'description', label: 'Description', type: 'text', required: true, max: 100, list: () => [...new Set(examRows('group_exam_types').map(r => r.examType).filter(Boolean))] },
            { name: 'examStatus', label: 'Exam status', type: 'select', options: () => examPairs(EXAM_STATUS), placeholder: null },
            { name: 'weight', label: 'Exam weight (out of 100)', type: 'number', min: 0, max: 100, required: true },
            { name: 'outOf', label: 'Exam Out Of', type: 'number', min: 1, max: 1000, required: true }
        ],
        columns: [['Apply to', r => r.course || 'All courses'], ['Batch', r => r.batch || 'All batches'], ['Period', r => r.period],
            ['Exam group', r => r.examGroup], ['Description', r => r.description], ['Weight', r => examNum(r.weight), true],
            ['Out of', r => examNum(r.outOf), true], ['Status', r => r.examStatus || 'OPEN']],
        sort: (a, b) => String(a.course).localeCompare(String(b.course)) || String(a.batch).localeCompare(String(b.batch))
            || String(a.period).localeCompare(String(b.period), undefined, { numeric: true }) || String(a.examGroup).localeCompare(String(b.examGroup)),
        same: (a, b) => same(a.course, b.course) && same(a.batch, b.batch) && same(a.period, b.period) && same(a.examGroup, b.examGroup)
            && same(a.description, b.description),
        label: r => `${r.description} (${r.examGroup}, ${r.period})`,
        summary: rows => {
            const total = weightTotal(rows);
            return rows.length ? ` Weights add up to ${examNum(total)} of 100${total === 100 ? '.' : ' (should be 100 for one course, batch and period).'}` : '';
        }
    },
    {
        key: 'groups', title: 'Exam groups', store: 'exam_groups',
        banner: 'The exam groups (CATs, end of semester exams ...) with their weight and mark out of. Add one with the form; change one with the pencil.',
        save: 'Save exam group',
        fields: [
            { name: 'name', label: 'Group name', type: 'text', required: true, max: 100, placeholder: 'For example CAT 1' },
            { name: 'onTranscript', label: 'Include on transcript', type: 'check' },
            { name: 'weight', label: 'Group weight', type: 'number', min: 0, max: 100 },
            { name: 'outOf', label: 'Exam Out Of', type: 'number', min: 0, max: 1000 }
        ],
        columns: [['Group name', r => r.name], ['Group weight', r => examNum(r.weight)], ['Included', r => r.onTranscript === 'Y' ? 'Y' : 'N'],
            ['Exam out of', r => examNum(r.outOf)]],
        sort: (a, b) => String(a.name).localeCompare(String(b.name)),
        same: (a, b) => same(a.name, b.name),
        label: r => r.name,
        // A group in use is kept (its name is on exam types, group exam types and course exam groups)
        inUse: r => ['exam_types', 'group_exam_types', 'course_exam_groups'].some(s => examRows(s).some(x => same(x.examGroup, r.name))),
        renames: { field: 'name', stores: { exam_types: 'examGroup', group_exam_types: 'examGroup', course_exam_groups: 'examGroup' } }
    },
    {
        key: 'grading', title: 'Grading system', store: 'grading_systems',
        // Edited in the list itself: the pencil turns a row into boxes (tick saves, cross cancels); the last row adds a grade
        inline: true,
        banner: 'The grades of each course: marks range, points and GPA. Change a grade with the pencil.',
        save: 'Save grade',
        fields: [
            { name: 'course', label: 'Course', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- select one --', required: true, filter: true },
            { name: 'grade', label: 'Grade', type: 'text', required: true, max: 10, upper: true, placeholder: 'For example A' },
            // Below 0: special grades, e.g. X = -1, Y = -2, Z = -3, P = -4 (no mark sat, as on the college's grading sheets)
            { name: 'minMark', label: 'Marks from', type: 'number', min: -10, max: 100, required: true },
            { name: 'maxMark', label: 'Marks to', type: 'number', min: -10, max: 100, required: true },
            { name: 'points', label: 'Points', type: 'number', min: 0, max: 100 },
            { name: 'gpaFrom', label: 'GPA from', type: 'number', min: 0, max: 10 },
            { name: 'gpaTo', label: 'GPA to', type: 'number', min: 0, max: 10 },
            { name: 'qualification', label: 'Qualification', type: 'text', max: 100, placeholder: 'For example Distinction',
                list: () => ['Distinction', 'Credit', 'Pass', 'Fail'] }
        ],
        columns: [['Course', r => r.course], ['Grade', r => r.grade], ['Marks from', r => examNum(r.minMark)], ['Marks to', r => examNum(r.maxMark)],
            ['Points', r => examPoints(r.points)], ['GPA from', r => examNum(r.gpaFrom)], ['GPA to', r => examNum(r.gpaTo)],
            ['Qualification', r => r.qualification]],
        sort: (a, b) => String(a.course).localeCompare(String(b.course)) || Number(b.minMark) - Number(a.minMark),
        same: (a, b) => same(a.course, b.course) && same(a.grade, b.grade),
        label: r => `${r.grade} (${r.course})`,
        check: (r, others) => {
            if (Number(r.minMark) > Number(r.maxMark)) return 'Marks from is above Marks to.';
            if (r.gpaFrom !== '' && r.gpaTo !== '' && Number(r.gpaFrom) > Number(r.gpaTo)) return 'GPA from is above GPA to.';
            const clash = others.find(o => same(o.course, r.course) && overlaps(r.minMark, r.maxMark, o.minMark, o.maxMark));
            return clash ? `${examNum(r.minMark)}-${examNum(r.maxMark)} overlaps grade ${clash.grade} (${examNum(clash.minMark)}-${examNum(clash.maxMark)}) of ${r.course}.` : '';
        }
    },
    {
        key: 'groupTypes', title: 'Group exam types', store: 'group_exam_types',
        banner: 'Exam types for a group of students in a class: choose them and save, or upload many at once from Excel.',
        save: 'Save group exam type',
        fields: [
            { name: 'course', label: 'Course', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- select one --', required: true, filter: true },
            { name: 'className', label: 'Class', type: 'select', options: () => classChoices(examField('course').value), placeholder: '-- select one --', filter: true },
            { name: 'batch', label: 'Batch', type: 'select', options: () => examPairs(groups), placeholder: '-- select one --', filter: true },
            { name: 'period', label: 'Period', type: 'select', options: () => examPairs(terms), placeholder: null, filter: true },
            { name: 'examGroup', label: 'Group', type: 'select', options: () => examPairs(activeGroups()), placeholder: '-- select one --', required: true },
            { name: 'examType', label: 'Exam type', type: 'select', options: () => examPairs(examTypeChoices()), placeholder: '-- select one --', required: true },
            { name: 'weight', label: 'Exam weight', type: 'number', min: 0, max: 100 },
            { name: 'onMainExam', label: 'Include On Main Exam', type: 'check' },
            { name: 'unit', label: 'Unit name', type: 'text', max: 200, placeholder: 'Type the unit name', list: () => unitChoices(examField('course').value) }
        ],
        columns: [['Course', r => r.course], ['Class', r => r.className], ['Batch', r => r.batch], ['Period', r => r.period],
            ['Group', r => r.examGroup], ['Exam type', r => r.examType], ['Weight', r => examNum(r.weight)],
            ['Main exam', r => r.onMainExam === 'Y' ? 'Y' : 'N'], ['Unit', r => r.unit]],
        sort: (a, b) => String(a.course).localeCompare(String(b.course)) || String(a.className).localeCompare(String(b.className), undefined, { numeric: true })
            || String(a.period).localeCompare(String(b.period), undefined, { numeric: true }) || String(a.examGroup).localeCompare(String(b.examGroup))
            || String(a.examType).localeCompare(String(b.examType), undefined, { numeric: true }),
        same: (a, b) => ['course', 'className', 'batch', 'period', 'examGroup', 'examType', 'unit'].every(k => same(a[k], b[k])),
        label: r => `${r.examType} (${r.examGroup}${r.unit ? ', ' + r.unit : ''})`,
        // Excel: one row per exam type of a group
        upload: {
            title: 'Upload group exam types from Excel', file: 'group-exam-types-template.xlsx', sheet: 'Group exam types',
            note: 'One row per exam type of a group; fill it in and upload it here.', button: 'Upload group exam types',
            headers: ['Course', 'Class', 'Batch', 'Period', 'Group', 'Exam type', 'Exam weight', 'Include on main exam', 'Unit name'],
            // Red (*) in the template: a row without them is refused; drop-down lists from Settings and Exam groups
            required: ['Course', 'Period', 'Group', 'Exam type'],
            choices: () => ({ Course: courseItems.map(c => c.name), Batch: groups, Period: terms, Group: activeGroups(),
                'Include on main exam': ['Y', 'N'], Class: ['YEAR 1', 'YEAR 2', 'YEAR 3', 'YEAR 4', 'YEAR 5', 'YEAR 6'] }),
            open: ['Class'],
            help: [['Course', 'The course, exactly as in Settings > Program Setup > Courses'],
                ['Class', 'The year of study: 1, 2, 3 or YEAR 1 (may be left blank)'],
                ['Batch', 'The batch, as in Settings > Organisation Setup > Batches (may be left blank)'],
                ['Period', 'SEMESTER 1, Semester 2 or just 2'],
                ['Group', 'The exam group, as in Exam Management > Exam groups'],
                ['Exam type', 'For example CAT 1'],
                ['Exam weight', 'A number from 0 to 100 (may be left blank)'],
                ['Include on main exam', 'Y or N (blank = N)'],
                ['Unit name', 'The unit code or title, as in Manage Units > Units register (may be left blank)']],
            row: get => {
                const course = courseItems.find(c => same(c.name, get('course')));
                if (!course) return get('course') ? 'Course not in Settings > Courses' : 'No course';
                const yearText = String(get('class')).replace(/\D+/g, ' ').trim().split(' ')[0];
                const className = yearText ? `YEAR ${Number(yearText)}` : '';
                if (className && !classChoices(course.name).some(([v]) => v === className)) return `${course.name} has no ${className}`;
                const batch = get('batch') ? groups.find(g => same(g, get('batch'))) : '';
                if (batch === undefined) return 'Batch not in Settings > Batches';
                const period = periodOf(get('period'));
                if (!period) return get('period') ? 'Period not like SEMESTER 1' : 'No period';
                const examGroup = activeGroups().find(g => same(g, get('group')));
                if (!examGroup) return get('group') ? 'Group not in Exam groups' : 'No group';
                const examType = String(get('examtype')).trim();
                if (!examType) return 'No exam type';
                const w = String(get('examweight')).trim();
                if (w && (!Number.isFinite(Number(w)) || Number(w) < 0 || Number(w) > 100)) return 'Exam weight is not 0 to 100';
                const unitText = String(get('unit')).trim();
                const unit = unitText ? units.find(u => same(u.code, unitText) || same(u.title, unitText) || same(unitLabel(u), unitText)) : null;
                if (unitText && !unit) return 'Unit not in the Units register';
                return { course: course.name, className, batch, period, examGroup, examType: examType.replace(/\s+/g, ' '),
                    weight: w === '' ? '' : Number(w), onMainExam: /^(y|yes|true|1)$/i.test(String(get('includeonmainexam')).trim()) ? 'Y' : 'N',
                    unit: unit ? unitLabel(unit) : '' };
            }
        }
    },
    {
        key: 'awards', title: 'Awards setup', store: 'award_setups',
        banner: 'The recommendation printed for each range of marks in a course.',
        save: 'Save award setting',
        fields: [
            { name: 'course', label: 'Course', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- select one --', required: true, filter: true },
            { name: 'recommendation', label: 'Recommendations', type: 'text', required: true, max: 200, placeholder: 'For example FIRST CLASS UPPER DIVISION',
                upper: true },
            { name: 'marksFrom', label: 'Marks from', type: 'number', min: 0, max: 100, required: true },
            { name: 'marksTo', label: 'Marks to', type: 'number', min: 0, max: 100, required: true }
        ],
        columns: [['Course', r => r.course], ['Mark from', r => examNum(r.marksFrom)], ['Mark to', r => examNum(r.marksTo)], ['Recommendation', r => r.recommendation]],
        // Highest marks first; a range may be typed either way round (100 to 80, or 80 to 100)
        sort: (a, b) => String(a.course).localeCompare(String(b.course))
            || Math.max(Number(b.marksFrom), Number(b.marksTo)) - Math.max(Number(a.marksFrom), Number(a.marksTo)),
        same: (a, b) => same(a.course, b.course) && same(a.recommendation, b.recommendation),
        label: r => `${r.recommendation} (${r.course})`,
        check: (r, others) => {
            const range = x => [Math.min(Number(x.marksFrom), Number(x.marksTo)), Math.max(Number(x.marksFrom), Number(x.marksTo))];
            const [lo, hi] = range(r);
            const clash = others.find(o => same(o.course, r.course) && overlaps(lo, hi, ...range(o)));
            return clash ? `${examNum(r.marksFrom)}-${examNum(r.marksTo)} overlaps ${clash.recommendation} (${examNum(clash.marksFrom)}-${examNum(clash.marksTo)}) of ${r.course}.` : '';
        }
    },
    {
        key: 'courseGroups', title: 'Course exam groups', store: 'course_exam_groups',
        banner: 'The exam groups each course uses, with their weight and mark out of.',
        save: 'Save course exam group',
        fields: [
            { name: 'course', label: 'Course', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- select one --', required: true, filter: true },
            { name: 'examGroup', label: 'Exam group', type: 'select', options: () => examPairs(activeGroups()), placeholder: '-- select one --', required: true },
            { name: 'weight', label: 'Exam weight (out of 100)', type: 'number', min: 0, max: 100, required: true },
            { name: 'outOf', label: 'Exam out of', type: 'number', min: 0, max: 1000 },
            { name: 'onMainExam', label: 'Include On Main Exam', type: 'check' }
        ],
        columns: [['Course', r => r.course], ['Exam group', r => r.examGroup], ['Exam weight', r => examNum(r.weight)],
            ['Exam out of', r => examNum(r.outOf)], ['Main exam', r => r.onMainExam === 'Y' ? 'Y' : 'N']],
        sort: (a, b) => String(a.course).localeCompare(String(b.course)) || String(a.examGroup).localeCompare(String(b.examGroup)),
        same: (a, b) => same(a.course, b.course) && same(a.examGroup, b.examGroup),
        label: r => `${r.examGroup} (${r.course})`,
        summary: rows => {
            const courses = [...new Set(rows.map(r => r.course))];
            if (courses.length !== 1) return '';
            const total = weightTotal(rows);
            return ` Weights add up to ${examNum(total)} of 100${total === 100 ? '.' : ' (should be 100).'}`;
        }
    },
    {
        key: 'paperTypes', title: 'Exam paper types', store: 'exam_paper_types',
        banner: 'The exam papers (Paper 1, Paper 2 ...) and the order they are listed in.',
        save: 'Save paper type',
        fields: [
            { name: 'name', label: 'Name', type: 'text', required: true, max: 100, placeholder: 'For example Paper 1',
                list: () => ['Paper 1', 'Paper 2', 'Paper 3', 'Paper 4'] },
            { name: 'position', label: 'Position', type: 'number', min: 1, max: 100 },
            { name: 'code', label: 'Code', type: 'text', max: 20, upper: true, placeholder: 'For example PA1' }
        ],
        columns: [['Paper name', r => r.name], ['Position', r => examNum(r.position)], ['Code', r => r.code]],
        // In their position order; papers without a position come last
        sort: (a, b) => (a.position === '' || a.position == null ? 1e9 : Number(a.position)) - (b.position === '' || b.position == null ? 1e9 : Number(b.position))
            || String(a.name).localeCompare(String(b.name)),
        same: (a, b) => same(a.name, b.name),
        label: r => r.name,
        check: (r, others) => {
            if (r.position === '') return '';
            const clash = others.find(o => o.position !== '' && o.position != null && Number(o.position) === Number(r.position));
            return clash ? `Position ${examNum(r.position)} is already taken by ${clash.name}.` : '';
        }
    }
];

const examTab = () => EXAM_TABS.find(t => t.key === examActive) || EXAM_TABS[0];
const examField = name => $('ex_' + name);

// Called by loadData() on this screen
async function loadExams() {
    const lists = await Promise.all(EXAM_TABS.map(t => fewaDB.getAll(t.store).catch(() => { loadFailed = true; return []; })));
    EXAM_TABS.forEach((t, i) => { examData[t.store] = lists[i]; });
}

function showExamsPage() {
    document.title = 'Exam Management - FEWA Beauty & Fashion College';
    $('menuExams').classList.add('active');
    $('unitsTabs').style.display = 'none';
    for (const [k] of TABS) $('pane-' + k).hidden = true;
    $('pane-exams').hidden = false;
    document.querySelector('#topbar .search-box input').placeholder = 'Search the list below...';
    let saved = '';
    try { saved = localStorage.getItem(EXAM_TAB_KEY) || ''; } catch { }
    showExamTab(EXAM_TABS.some(t => t.key === saved) ? saved : 'types');
}

function showExamTab(key) {
    examActive = key;
    examEditing = null;
    try { localStorage.setItem(EXAM_TAB_KEY, key); } catch { }
    $('examTabs').innerHTML = EXAM_TABS.map(t => `<button type="button" role="tab" class="settings-tab${t.key === key ? ' active' : ''}"
        aria-selected="${t.key === key}" onclick="showExamTab('${t.key}')">${escapeHtml(t.title)}</button>`).join('');
    buildExamForm();
    render();
}

function buildExamForm() {
    const t = examTab();
    if (t.inline) return buildInlineTab(t);
    const input = f => {
        const id = 'ex_' + f.name;
        if (f.type === 'select') return `<select id="${id}"></select>`;
        const list = f.list ? ` list="${id}_list"` : '';
        const attrs = f.type === 'number' ? ` type="number" min="${f.min ?? 0}" max="${f.max ?? 100000}" step="any"` : ` type="text" maxlength="${f.max || 200}"`;
        return `<input id="${id}"${attrs}${list} autocomplete="off" placeholder="${escapeHtml(f.placeholder || '')}">` +
            (f.list ? `<datalist id="${id}_list"></datalist>` : '');
    };
    // A tick box takes a label and a box's place, its text beside it (saved as Y or N)
    const cells = t.fields.map(f => f.type === 'check'
        ? `<label class="exam-check"><input type="checkbox" id="ex_${f.name}"> ${escapeHtml(f.label)}</label>`
        : `<label for="ex_${f.name}">${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input(f)}`);
    if (cells.length % 2) cells.push('<span></span><span></span>');
    $('examBody').innerHTML = `<div class="settings-banner info-banner">${escapeHtml(t.banner)}</div>
        <div class="up-filters reg-fields lec-fields sched-fields exam-fields">${cells.join('')}
            <span></span>
            <div class="units-actions sched-buttons">
                <button type="button" class="btn-submit" id="examSave" data-edit onclick="saveExamRecord()">${escapeHtml(t.save)}</button>
                <button type="button" class="btn-secondary" onclick="clearExamForm()">Clear</button>
            </div>
        </div>
        ${t.upload ? `<div class="units-subhead">${escapeHtml(t.upload.title)}</div>
        <div class="up-box">
            <div class="up-template">
                <svg class="up-excel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 12.5l5 6M13.5 12.5l-5 6"/></svg>
                <div class="up-template-text"><b>Excel template</b><span>${escapeHtml(t.upload.note)}</span></div>
                <div class="up-template-buttons"><button type="button" class="btn-secondary" onclick="downloadExamTemplate()">Download template</button></div>
            </div>
            <label class="up-drop" id="examDrop" for="examFile">
                <svg class="up-cloud" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor"
                    d="M19.4 10.1A7 7 0 0 0 6.1 8.6 5.5 5.5 0 0 0 6.5 19.5h12.3a4.7 4.7 0 0 0 .6-9.4zM13 13v4h-2v-4H8l4-4 4 4z"/></svg>
                <span class="up-choose" id="examChosen">Choose the filled-in file</span>
                <input type="file" id="examFile" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
            </label>
            <div class="up-limits"><span>Supported formats: XLS, XLSX</span><span>Max size: 10 MB</span></div>
            <div class="up-submit"><button type="button" class="btn-submit" data-edit onclick="uploadExamRows()">${escapeHtml(t.upload.button)}</button></div>
        </div>
        <div id="examUploadResult" hidden>
            <div class="units-subhead">Lines in the file</div>
            <div class="units-count" id="examUploadSummary"></div>
            <div class="table-wrap"><table class="data-table">
                <thead><tr><th>Row</th>${t.upload.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}<th>Result</th></tr></thead>
                <tbody id="examUploadRows"></tbody></table></div>
        </div>` : ''}
        <div class="units-count" id="examCount"></div>
        <div class="table-wrap"><table class="data-table">
            <thead><tr><th class="unit-actions"></th>${t.columns.map(([h, , num]) => `<th${num ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>
            <tbody id="examRows"></tbody></table></div>`;
    fillExamChoices();
    for (const f of t.fields.filter(f => f.filter)) examField(f.name).addEventListener(f.type === 'select' ? 'change' : 'input', () => { fillExamChoices(); renderExamList(); });
    if (t.upload) wireExamUpload();
}

function fillExamChoices() {
    for (const f of examTab().fields) {
        if (f.type === 'select' && examField(f.name)) fill(examField(f.name), f.options(), f.placeholder === undefined ? '-- select one --' : f.placeholder);
        if (f.list && $('ex_' + f.name + '_list')) $('ex_' + f.name + '_list').innerHTML = f.list().map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    }
}

// Called by render() on this screen
function renderExams() {
    if (!$('examRows')) return buildExamForm(), renderExams();
    fillExamChoices();
    document.querySelectorAll('#pane-exams [data-edit]').forEach(b => b.disabled = !mayEdit());
    renderExamList();
}

function renderExamList() {
    const t = examTab();
    if (t.inline) return renderInlineRows(t);
    // The filter boxes (course, batch, period...) narrow the list; "all" rows show under any choice
    const filters = t.fields.filter(f => f.filter).map(f => [f, examField(f.name).value.trim()]).filter(([, v]) => v);
    const words = examFind.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = examRows(t.store)
        .filter(r => filters.every(([f, v]) => same(r[f.name], v) || (f.all && !r[f.name])))
        .filter(r => words.every(w => t.columns.map(([, get]) => get(r)).join(' ').toLowerCase().includes(w)))
        .sort(t.sort);
    // (an empty list shows only its note, from notify.js)
    $('examCount').textContent = !rows.length ? '' : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}` +
        (filters.length ? ` for ${filters.map(([, v]) => v).join(', ')}` : '') + '.' + (t.summary ? t.summary(rows) : '');
    $('examRows').innerHTML = rows.length ? rows.map(r => `<tr${r.id === examEditing ? ' class="editing"' : ''}>
            <td class="unit-actions">${mayEdit() ? iconButton('edit', 'Change ' + escapeHtml(t.label(r)), `editExamRecord('${r.id}')`) +
                iconButton('delete', 'Remove ' + escapeHtml(t.label(r)), `deleteExamRecord('${r.id}')`) : ''}</td>
            ${t.columns.map(([, get, num]) => `<td${num ? ' class="num"' : ''}>${escapeHtml(get(r) ?? '')}</td>`).join('')}</tr>`).join('')
        : `<tr class="empty-row"><td colspan="${t.columns.length + 1}">Nothing is listed here yet.</td></tr>`;
}

async function saveExamRecord() {
    if (!allowed('exams', 'edit')) return;
    const t = examTab();
    const record = {};
    for (const f of t.fields) {
        if (f.type === 'check') { record[f.name] = examField(f.name).checked ? 'Y' : 'N'; continue; }
        let v = examField(f.name).value.trim().replace(/\s+/g, ' ');
        if (f.upper) v = v.toUpperCase();
        if (f.type === 'number' && v !== '') {
            if (!Number.isFinite(Number(v)) || Number(v) < (f.min ?? 0) || Number(v) > (f.max ?? 100000)) {
                return alert(`${f.label}: enter a number from ${f.min ?? 0} to ${f.max ?? 100000}.`);
            }
            v = Number(v);
        }
        record[f.name] = v;
    }
    if (!await storeExamRecord(t, record)) return;
    $('examSave').textContent = t.save;
    // The filter boxes keep their choice, the rest is emptied for the next entry
    for (const f of t.fields.filter(f => !f.filter)) {
        if (f.type === 'check') examField(f.name).checked = false;
        else examField(f.name).value = f.type === 'select' && f.placeholder === null ? (examField(f.name).options[0] || {}).value || '' : '';
    }
    await loadData();
}

// Checks a record (required fields, the tab's own check, one already like it) and saves it; true when saved
async function storeExamRecord(t, record) {
    const missing = t.fields.filter(f => f.required && record[f.name] === '').map(f => f.label);
    if (missing.length) { alert('Please fill in: ' + missing.join(', ') + '.'); return false; }
    const others = examRows(t.store).filter(r => r.id !== examEditing);
    const problem = t.check ? t.check(record, others.filter(o => !t.same(o, record))) : '';
    if (problem) { alert(problem); return false; }
    const existing = others.find(o => t.same(o, record));
    if (existing && !confirm(`${t.label(existing)} is already in the list. Replace it?`)) return false;
    const old = examRows(t.store).find(r => r.id === examEditing);
    const base = existing || old || {};
    const saved = { ...base, ...record, id: base.id || newId(), updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' };
    try {
        await fewaDB.put(t.store, saved);
        if (existing && old && existing.id !== old.id) await fewaDB.remove(t.store, old.id);
        // A renamed exam group is renamed where it is used
        if (t.renames && old && old[t.renames.field] && !same(old[t.renames.field], saved[t.renames.field])) {
            for (const [store, field] of Object.entries(t.renames.stores)) {
                for (const r of examRows(store).filter(x => same(x[field], old[t.renames.field]))) {
                    await fewaDB.put(store, { ...r, [field]: saved[t.renames.field] });
                }
            }
        }
        showToast(`${t.label(saved)} saved.`);
        examEditing = null;
        return true;
    } catch (err) { alert('It could not be saved: ' + err.message); await loadData(); return false; }
}

function editExamRecord(id) {
    const t = examTab();
    const r = examRows(t.store).find(x => x.id === id);
    if (!r) return;
    examEditing = id;
    for (const f of t.fields) {
        const box = examField(f.name), value = r[f.name] === undefined || r[f.name] === null ? '' : String(r[f.name]);
        if (f.type === 'check') { box.checked = value === 'Y'; continue; }
        if (f.type === 'select' && value && ![...box.options].some(o => o.value === value)) box.add(new Option(value, value));
        box.value = f.type === 'number' && value !== '' ? String(Number(value)) : value;
    }
    $('examSave').textContent = 'Save change';
    renderExamList();
    examField(t.fields[0].name).focus();
}

function clearExamForm() {
    const t = examTab();
    examEditing = null;
    $('examSave').textContent = t.save;
    for (const f of t.fields) {
        if (f.type === 'check') examField(f.name).checked = false;
        else examField(f.name).value = f.type === 'select' && f.placeholder === null ? (examField(f.name).options[0] || {}).value || '' : '';
    }
    renderExamList();
}

async function deleteExamRecord(id) {
    if (!allowed('exams', 'edit')) return;
    const t = examTab();
    const r = examRows(t.store).find(x => x.id === id);
    if (!r) return;
    if (t.inUse && t.inUse(r)) return alert(`${t.label(r)} is in use on another tab, so it is kept. Change or remove those entries first.`);
    if (!confirm(`Remove ${t.label(r)}?`)) return;
    try {
        await fewaDB.remove(t.store, id);
        if (examEditing === id) clearExamForm();
        showToast(`${t.label(r)} removed.`);
        await loadData();
    } catch (err) { alert('It could not be removed: ' + err.message); await loadData(); }
}

/* ---------- Excel upload (tabs with "upload", e.g. Group exam types) ----------
   Download template: an empty sheet with the headings and a "How to fill it in" sheet. Upload: each row is checked
   (the tab's upload.row gives the record, or why the row cannot be used) and the good rows are saved; a row like one
   already in the list replaces it. The table below the box gives the result of every row. */
function wireExamUpload() {
    const drop = $('examDrop'), file = $('examFile');
    file.addEventListener('change', chosenExamFile);
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', event => {
        event.preventDefault();
        drop.classList.remove('dragging');
        if (event.dataTransfer.files.length) { file.files = event.dataTransfer.files; chosenExamFile(); }
    });
}

function chosenExamFile() {
    const f = $('examFile').files[0];
    $('examChosen').textContent = f ? f.name : 'Choose the filled-in file';
    $('examDrop').classList.toggle('has-file', !!f);
}

function downloadExamTemplate() {
    const up = examTab().upload;
    const help = Object.fromEntries(up.help);
    const choices = up.choices ? up.choices() : {};
    FewaExcel.template(up.file, up.headers.map(h => ({ title: h, field: h, required: (up.required || []).includes(h), help: help[h],
        choices: choices[h], open: (up.open || []).includes(h) })), up.sheet).catch(err => alert(err.message));
}

async function uploadExamRows() {
    if (!allowed('exams', 'edit')) return;
    const t = examTab(), up = t.upload;
    const f = $('examFile').files[0];
    if (!f) return alert('Choose the filled-in Excel file first.');
    if (f.size > 10 * 1024 * 1024) return alert('The file is larger than 10 MB.');
    let XLSX;
    try { XLSX = await loadXlsx(); } catch (err) { return alert(err.message); }
    let rows;
    try {
        const book = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', raw: false })
            .map(r => r.map(c => String(c).trim()));
    } catch { return alert('The file could not be read. Save it as .xlsx from Excel and try again.'); }
    // The headings decide the columns (any order); "Unit name" may also be "Unit code"
    const key = h => h.toLowerCase().replace(/[^a-z]/g, '').replace(/^unit(name|code|title)$/, 'unit');
    const header = (rows[0] || []).map(key);
    if (!header.includes('course')) return alert('The first row must hold the headings. Download the template to see them.');
    const lines = rows.slice(1).map((r, i) => ({ r, n: i + 2 })).filter(({ r }) => r.some(Boolean)).map(({ r, n }) => {
        const get = name => { const at = header.indexOf(name); return at >= 0 ? r[at] || '' : ''; };
        const result = up.row(get);
        return { n, r, cells: up.headers.map(h => get(key(h))), record: typeof result === 'string' ? null : result, note: typeof result === 'string' ? result : '' };
    });
    if (!lines.length) return alert('The file has no rows under the headings.');
    // Rows like an earlier row of the file are left out; rows like one in the list replace it
    const seen = [];
    for (const l of lines.filter(l => l.record)) {
        if (seen.some(o => t.same(o, l.record))) { l.record = null; l.note = 'The same as a row above'; continue; }
        seen.push(l.record);
        const existing = examRows(t.store).find(o => t.same(o, l.record));
        l.existing = existing;
        l.note = existing ? 'Replaces the one in the list' : 'OK';
    }
    const good = lines.filter(l => l.record);
    const badLines = lines.filter(l => !l.record && l.note !== 'The same as a row above');
    const showLines = () => {
        $('examUploadResult').hidden = false;
        $('examUploadSummary').textContent = `${lines.length} row${lines.length === 1 ? '' : 's'}: ${good.length} can be saved, ${lines.length - good.length} cannot.`;
        $('examUploadRows').innerHTML = lines.map(l => `<tr><td>${l.n}</td>${l.cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}
            <td class="${l.done ? 'units-result-ok' : l.record ? 'units-result-warn' : 'units-result-bad'}">${escapeHtml(l.done ? 'Saved' : l.note)}</td></tr>`).join('');
    };
    showLines();
    // After every upload: the file's rows again with a Feedback column (excel-tools.js)
    const feedback = () => window.FewaExcel && FewaExcel.feedback(f.name, rows[0] || [], lines.map(l => l.r), lines.map(l => l.done
        ? { ok: true, text: l.existing ? 'Saved (replaced the one in the list)' : 'Saved' }
        : { ok: false, text: 'NOT saved: ' + (l.record ? 'the upload was cancelled or stopped' : l.note) }));
    if (badLines.length) {
        if (window.FewaExcel) FewaExcel.feedback(f.name, rows[0] || [], lines.map(l => l.r), lines.map(l => ({ ok: false,
            text: 'NOT saved: ' + (l.record ? 'this row is fine, but the file has rows to correct (nothing was saved)' : l.note) })));
        return alert(`Nothing was saved: ${badLines.length} row${badLines.length === 1 ? ' has' : 's have'} a problem (shown in red in the table). ` +
            'Correct them in Excel and upload the file again. A copy of your file with a Feedback column has been downloaded.');
    }
    if (!good.length) { feedback(); return alert('No row can be saved. The table shows why for each row.'); }
    if (!confirm(`Save ${good.length} row${good.length === 1 ? '' : 's'}?`)) return feedback();
    try {
        for (const l of good) {
            await fewaDB.put(t.store, { ...(l.existing || {}), ...l.record, id: (l.existing || {}).id || newId(),
                updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' });
            l.done = true;
        }
        showToast(`${good.length} row${good.length === 1 ? '' : 's'} saved.`);
    } catch (err) { alert('Not every row could be saved: ' + err.message); }
    feedback();
    showLines();
    $('examFile').value = '';
    chosenExamFile();
    await loadData();
}

/* ---------- Tabs edited in their rows (inline: Grading system) ----------
   Laid out like the college's grading sheet: the course box, then the list. The pencil turns a row into boxes, the
   tick saves it and the cross cancels; the empty row at the end adds a grade to the chosen course. */
function buildInlineTab(t) {
    const filter = t.fields.find(f => f.filter), cols = t.fields.filter(f => !f.filter);
    $('examBody').innerHTML = `<div class="settings-banner info-banner">${escapeHtml(t.banner)}</div>
        <div class="up-filters reg-fields lec-fields sched-fields exam-fields">
            <label for="ex_${filter.name}">${escapeHtml(filter.label)}</label><select id="ex_${filter.name}"></select><span></span><span></span>
        </div>
        ${cols.filter(f => f.list).map(f => `<datalist id="ex_${f.name}_list"></datalist>`).join('')}
        <div class="units-count" id="examCount"></div>
        <div class="table-wrap"><table class="data-table exam-inline">
            <thead><tr><th class="unit-actions"></th><th>${escapeHtml(filter.label)}</th>${cols.map(f => `<th>${escapeHtml(f.label)}</th>`).join('')}</tr></thead>
            <tbody id="examRows"></tbody></table></div>`;
    fillExamChoices();
    examField(filter.name).addEventListener('change', () => { examEditing = null; renderExamList(); });
}

function renderInlineRows(t) {
    const filter = t.fields.find(f => f.filter), cols = t.fields.filter(f => !f.filter);
    const chosen = examField(filter.name).value;
    const words = examFind.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = examRows(t.store).filter(r => !chosen || same(r[filter.name], chosen))
        .filter(r => words.every(w => [r[filter.name], ...cols.map(f => r[f.name])].join(' ').toLowerCase().includes(w)))
        .sort(t.sort);
    $('examCount').textContent = chosen ? `${rows.length} grade${rows.length === 1 ? '' : 's'} for ${chosen}.`
        : `${rows.length} grade${rows.length === 1 ? '' : 's'} of every course. Choose the course to add or change its grades.`;
    const box = (f, value) => `<input data-f="${f.name}" class="exam-cell" autocomplete="off" ${f.type === 'number'
        ? `type="number" step="any" min="${f.min ?? 0}" max="${f.max ?? 100000}"` : `type="text" maxlength="${f.max || 200}"`}${f.list
        ? ` list="ex_${f.name}_list"` : ''} value="${escapeHtml(value === undefined || value === null ? '' : f.type === 'number' && value !== '' ? Number(value) : value)}">`;
    const shown = (f, r) => f.name === 'points' ? examPoints(r.points) : f.type === 'number' ? examNum(r[f.name]) : (r[f.name] || '');
    const tick = id => `<button type="button" class="exam-icon exam-ok" title="Save" aria-label="Save" onclick="saveInlineRow('${id}')">&#10004;</button>`;
    const cross = `<button type="button" class="exam-icon exam-no" title="Cancel" aria-label="Cancel" onclick="cancelInlineRow()">&#10006;</button>`;
    $('examRows').innerHTML = rows.map(r => r.id === examEditing
        ? `<tr class="editing" data-id="${r.id}"><td class="unit-actions">${tick(r.id)}${cross}</td><td>${escapeHtml(r[filter.name] || '')}</td>
            ${cols.map(f => `<td>${box(f, r[f.name])}</td>`).join('')}</tr>`
        : `<tr><td class="unit-actions">${mayEdit() ? iconButton('edit', 'Change ' + escapeHtml(t.label(r)), `editInlineRow('${r.id}')`) +
            iconButton('delete', 'Remove ' + escapeHtml(t.label(r)), `deleteExamRecord('${r.id}')`) : ''}</td>
            <td>${escapeHtml(r[filter.name] || '')}</td>${cols.map(f => `<td>${escapeHtml(shown(f, r))}</td>`).join('')}</tr>`).join('')
        // The row that adds a grade to the chosen course
        + (chosen && mayEdit() ? `<tr class="exam-add" data-id="new"><td class="unit-actions">${tick('')}</td><td>${escapeHtml(chosen)}</td>
            ${cols.map(f => `<td>${box(f, '')}</td>`).join('')}</tr>` : '')
        || `<tr class="empty-row"><td colspan="${cols.length + 2}">Choose the course to see its grades.</td></tr>`;
}

function editInlineRow(id) {
    examEditing = id;
    renderExamList();
    const first = document.querySelector('#examRows tr.editing input');
    if (first) first.focus();
}

function cancelInlineRow() {
    examEditing = null;
    renderExamList();
}

// Saves a row (id) or the add row (''): the same checks as the form
async function saveInlineRow(id) {
    if (!allowed('exams', 'edit')) return;
    const t = examTab(), filter = t.fields.find(f => f.filter);
    const tr = document.querySelector(`#examRows tr[data-id="${id || 'new'}"]`);
    if (!tr) return;
    const old = id ? examRows(t.store).find(r => r.id === id) : null;
    const record = { [filter.name]: old ? old[filter.name] : examField(filter.name).value };
    for (const f of t.fields.filter(f => !f.filter)) {
        let v = tr.querySelector(`[data-f="${f.name}"]`).value.trim().replace(/\s+/g, ' ');
        if (f.upper) v = v.toUpperCase();
        if (f.type === 'number' && v !== '') {
            if (!Number.isFinite(Number(v)) || Number(v) < (f.min ?? 0) || Number(v) > (f.max ?? 100000)) {
                return alert(`${f.label}: enter a number from ${f.min ?? 0} to ${f.max ?? 100000}.`);
            }
            v = Number(v);
        }
        record[f.name] = v;
    }
    examEditing = id || null;
    if (await storeExamRecord(t, record)) await loadData();
}
