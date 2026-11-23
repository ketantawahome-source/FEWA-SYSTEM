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
const gradingNames = () => [...new Set(examRows('grading_systems').map(g => g.gradingName).filter(Boolean))].sort();
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
            { name: 'description', label: 'Description', type: 'text', required: true, max: 100, list: () => examNames('group_exam_types') },
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
        banner: 'The kinds of assessment, for example Continuous Assessment (CAT) or End of Semester Exam. Exam types, group exam types and course exam groups pick from this list.',
        save: 'Save exam group',
        fields: [
            { name: 'name', label: 'Exam group name', type: 'text', required: true, max: 100, placeholder: 'For example Continuous Assessment' },
            { name: 'code', label: 'Code', type: 'text', max: 20, placeholder: 'For example CAT', upper: true },
            { name: 'description', label: 'Description', type: 'text', max: 200 },
            { name: 'status', label: 'Status', type: 'select', options: () => examPairs(ACTIVE_STATUS), placeholder: null }
        ],
        columns: [['Exam group', r => r.name], ['Code', r => r.code], ['Description', r => r.description], ['Status', r => r.status || 'ACTIVE']],
        sort: (a, b) => String(a.name).localeCompare(String(b.name)),
        same: (a, b) => same(a.name, b.name),
        label: r => r.name,
        // A group in use is kept (its name is on exam types, group exam types and course exam groups)
        inUse: r => ['exam_types', 'group_exam_types', 'course_exam_groups'].some(s => examRows(s).some(x => same(x.examGroup, r.name))),
        renames: { field: 'name', stores: { exam_types: 'examGroup', group_exam_types: 'examGroup', course_exam_groups: 'examGroup' } }
    },
    {
        key: 'grading', title: 'Grading system', store: 'grading_systems',
        banner: 'The grade of each mark range, for example 70 to 100 = A (Distinction). Give the grading a name (one per kind of course, e.g. Diploma grading) and add its grades one by one.',
        save: 'Save grade',
        fields: [
            { name: 'gradingName', label: 'Grading name', type: 'text', required: true, max: 100, list: gradingNames, filter: true, placeholder: 'For example Diploma grading' },
            { name: 'grade', label: 'Grade', type: 'text', required: true, max: 10, upper: true, placeholder: 'For example A' },
            { name: 'minMark', label: 'From mark', type: 'number', min: 0, max: 100, required: true },
            { name: 'maxMark', label: 'To mark', type: 'number', min: 0, max: 100, required: true },
            { name: 'points', label: 'Points', type: 'number', min: 0, max: 100 },
            { name: 'remark', label: 'Remark', type: 'text', max: 100, placeholder: 'For example Distinction' }
        ],
        columns: [['Grading name', r => r.gradingName], ['Grade', r => r.grade], ['From', r => examNum(r.minMark), true],
            ['To', r => examNum(r.maxMark), true], ['Points', r => examNum(r.points), true], ['Remark', r => r.remark]],
        sort: (a, b) => String(a.gradingName).localeCompare(String(b.gradingName)) || Number(b.minMark) - Number(a.minMark),
        same: (a, b) => same(a.gradingName, b.gradingName) && same(a.grade, b.grade),
        label: r => `${r.grade} (${r.gradingName})`,
        check: (r, others) => {
            if (Number(r.minMark) > Number(r.maxMark)) return 'The From mark is above the To mark.';
            const clash = others.find(o => same(o.gradingName, r.gradingName) && overlaps(r.minMark, r.maxMark, o.minMark, o.maxMark));
            return clash ? `${examNum(r.minMark)}-${examNum(r.maxMark)} overlaps grade ${clash.grade} (${examNum(clash.minMark)}-${examNum(clash.maxMark)}) of ${r.gradingName}.` : '';
        },
        inUse: r => examRows('grading_systems').filter(x => same(x.gradingName, r.gradingName)).length === 1
            && examRows('course_exam_groups').some(x => same(x.gradingName, r.gradingName))
    },
    {
        key: 'groupTypes', title: 'Group exam types', store: 'group_exam_types',
        banner: 'The exams that make up an exam group, for example CAT 1, CAT 2 and Assignment in Continuous Assessment, with their marks out of and share of the group.',
        save: 'Save group exam type',
        fields: [
            { name: 'examGroup', label: 'Exam group', type: 'select', options: () => examPairs(activeGroups()), placeholder: '-- select one --', required: true, filter: true },
            { name: 'name', label: 'Exam type', type: 'text', required: true, max: 100, placeholder: 'For example CAT 1' },
            { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
            { name: 'outOf', label: 'Out of', type: 'number', min: 1, max: 1000 },
            { name: 'weight', label: 'Weight in the group (out of 100)', type: 'number', min: 0, max: 100 }
        ],
        columns: [['Exam group', r => r.examGroup], ['Exam type', r => r.name], ['Code', r => r.code],
            ['Out of', r => examNum(r.outOf), true], ['Weight', r => examNum(r.weight), true]],
        sort: (a, b) => String(a.examGroup).localeCompare(String(b.examGroup)) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }),
        same: (a, b) => same(a.examGroup, b.examGroup) && same(a.name, b.name),
        label: r => `${r.name} (${r.examGroup})`
    },
    {
        key: 'awards', title: 'Awards setup', store: 'award_setups',
        banner: 'How a final average is classified for each award, for example a Diploma average of 70 to 100 = Distinction. The awards are those in Settings > Program Setup > Award Types.',
        save: 'Save classification',
        fields: [
            { name: 'award', label: 'Award', type: 'select', options: () => examPairs(programmes), placeholder: '-- select one --', required: true, filter: true },
            { name: 'classification', label: 'Classification', type: 'text', required: true, max: 100, placeholder: 'For example Distinction',
                list: () => ['Distinction', 'Credit', 'Pass', 'Fail', 'Referred'] },
            { name: 'minAverage', label: 'From average', type: 'number', min: 0, max: 100, required: true },
            { name: 'maxAverage', label: 'To average', type: 'number', min: 0, max: 100, required: true },
            { name: 'remark', label: 'Remark', type: 'text', max: 200 }
        ],
        columns: [['Award', r => r.award], ['Classification', r => r.classification], ['From', r => examNum(r.minAverage), true],
            ['To', r => examNum(r.maxAverage), true], ['Remark', r => r.remark]],
        sort: (a, b) => String(a.award).localeCompare(String(b.award)) || Number(b.minAverage) - Number(a.minAverage),
        same: (a, b) => same(a.award, b.award) && same(a.classification, b.classification),
        label: r => `${r.classification} (${r.award})`,
        check: (r, others) => {
            if (Number(r.minAverage) > Number(r.maxAverage)) return 'The From average is above the To average.';
            const clash = others.find(o => same(o.award, r.award) && overlaps(r.minAverage, r.maxAverage, o.minAverage, o.maxAverage));
            return clash ? `${examNum(r.minAverage)}-${examNum(r.maxAverage)} overlaps ${clash.classification} (${examNum(clash.minAverage)}-${examNum(clash.maxAverage)}) of ${r.award}.` : '';
        }
    },
    {
        key: 'courseGroups', title: 'Course exam groups', store: 'course_exam_groups',
        banner: 'The exam groups of each course and their weight in the final mark (for example CAT 30 and End of Semester Exam 70), and the grading it uses.',
        save: 'Save course exam group',
        fields: [
            { name: 'course', label: 'Course', type: 'select', options: () => examPairs(courseItems.map(c => c.name)), placeholder: '-- select one --', required: true, filter: true },
            { name: 'examGroup', label: 'Exam group', type: 'select', options: () => examPairs(activeGroups()), placeholder: '-- select one --', required: true },
            { name: 'weight', label: 'Weight (out of 100)', type: 'number', min: 0, max: 100, required: true },
            { name: 'gradingName', label: 'Grading system', type: 'select', options: () => examPairs(gradingNames()), placeholder: '-- select one --' }
        ],
        columns: [['Course', r => r.course], ['Exam group', r => r.examGroup], ['Weight', r => examNum(r.weight), true], ['Grading system', r => r.gradingName]],
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
        banner: 'The kinds of exam paper, for example Theory, Practical, Oral or Project, with the marks they are usually out of.',
        save: 'Save paper type',
        fields: [
            { name: 'name', label: 'Paper type', type: 'text', required: true, max: 100, placeholder: 'For example Practical',
                list: () => ['Theory', 'Practical', 'Oral', 'Project'] },
            { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
            { name: 'description', label: 'Description', type: 'text', max: 200 },
            { name: 'outOf', label: 'Usually out of', type: 'number', min: 1, max: 1000 }
        ],
        columns: [['Paper type', r => r.name], ['Code', r => r.code], ['Description', r => r.description], ['Out of', r => examNum(r.outOf), true]],
        sort: (a, b) => String(a.name).localeCompare(String(b.name)),
        same: (a, b) => same(a.name, b.name),
        label: r => r.name
    }
];

const examTab = () => EXAM_TABS.find(t => t.key === examActive) || EXAM_TABS[0];
const examField = name => $('ex_' + name);

// Called by loadData() on this screen
async function loadExams() {
    const lists = await Promise.all(EXAM_TABS.map(t => fewaDB.getAll(t.store).catch(() => [])));
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
    const input = f => {
        const id = 'ex_' + f.name;
        if (f.type === 'select') return `<select id="${id}"></select>`;
        const list = f.list ? ` list="${id}_list"` : '';
        const attrs = f.type === 'number' ? ` type="number" min="${f.min ?? 0}" max="${f.max ?? 100000}" step="any"` : ` type="text" maxlength="${f.max || 200}"`;
        return `<input id="${id}"${attrs}${list} autocomplete="off" placeholder="${escapeHtml(f.placeholder || '')}">` +
            (f.list ? `<datalist id="${id}_list"></datalist>` : '');
    };
    const cells = t.fields.map(f => `<label for="ex_${f.name}">${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input(f)}`);
    if (cells.length % 2) cells.push('<span></span><span></span>');
    $('examBody').innerHTML = `<div class="settings-banner info-banner">${escapeHtml(t.banner)}</div>
        <div class="up-filters reg-fields lec-fields sched-fields exam-fields">${cells.join('')}
            <span></span>
            <div class="units-actions sched-buttons">
                <button type="button" class="btn-submit" id="examSave" data-edit onclick="saveExamRecord()">${escapeHtml(t.save)}</button>
                <button type="button" class="btn-secondary" onclick="clearExamForm()">Clear</button>
            </div>
        </div>
        <div class="units-subhead">${escapeHtml(t.title)}</div>
        <div class="units-count" id="examCount"></div>
        <div class="table-wrap"><table class="data-table">
            <thead><tr><th class="unit-actions"></th>${t.columns.map(([h, , num]) => `<th${num ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>
            <tbody id="examRows"></tbody></table></div>`;
    fillExamChoices();
    for (const f of t.fields.filter(f => f.filter)) examField(f.name).addEventListener(f.type === 'select' ? 'change' : 'input', renderExamList);
}

function fillExamChoices() {
    for (const f of examTab().fields) {
        if (f.type === 'select') fill(examField(f.name), f.options(), f.placeholder === undefined ? '-- select one --' : f.placeholder);
        if (f.list) $('ex_' + f.name + '_list').innerHTML = f.list().map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
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
    // The filter boxes (course, batch, period...) narrow the list; "all" rows show under any choice
    const filters = t.fields.filter(f => f.filter).map(f => [f, examField(f.name).value.trim()]).filter(([, v]) => v);
    const words = examFind.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = examRows(t.store)
        .filter(r => filters.every(([f, v]) => same(r[f.name], v) || (f.all && !r[f.name])))
        .filter(r => words.every(w => t.columns.map(([, get]) => get(r)).join(' ').toLowerCase().includes(w)))
        .sort(t.sort);
    $('examCount').textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}` +
        (filters.length ? ` for ${filters.map(([, v]) => v).join(', ')}` : '') + '.' + (t.summary ? t.summary(rows) : '');
    $('examRows').innerHTML = rows.length ? rows.map(r => `<tr${r.id === examEditing ? ' class="editing"' : ''}>
            <td class="unit-actions">${mayEdit() ? iconButton('edit', 'Change ' + escapeHtml(t.label(r)), `editExamRecord('${r.id}')`) +
                iconButton('delete', 'Remove ' + escapeHtml(t.label(r)), `deleteExamRecord('${r.id}')`) : ''}</td>
            ${t.columns.map(([, get, num]) => `<td${num ? ' class="num"' : ''}>${escapeHtml(get(r) ?? '')}</td>`).join('')}</tr>`).join('')
        : `<tr class="empty-row"><td colspan="${t.columns.length + 1}">Nothing here yet.</td></tr>`;
}

async function saveExamRecord() {
    if (!allowed('academics', 'edit')) return;
    const t = examTab();
    const record = {};
    for (const f of t.fields) {
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
    const missing = t.fields.filter(f => f.required && record[f.name] === '').map(f => f.label);
    if (missing.length) return alert('Please fill in: ' + missing.join(', ') + '.');
    const others = examRows(t.store).filter(r => r.id !== examEditing);
    const problem = t.check ? t.check(record, others.filter(o => !t.same(o, record))) : '';
    if (problem) return alert(problem);
    const existing = others.find(o => t.same(o, record));
    if (existing && !confirm(`${t.label(existing)} is already in the list. Replace it?`)) return;
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
        $('examSave').textContent = t.save;
        // The filter boxes keep their choice, the rest is emptied for the next entry
        for (const f of t.fields.filter(f => !f.filter)) examField(f.name).value = f.type === 'select' && f.placeholder === null
            ? (examField(f.name).options[0] || {}).value || '' : '';
        await loadData();
    } catch (err) { alert('It could not be saved: ' + err.message); await loadData(); }
}

function editExamRecord(id) {
    const t = examTab();
    const r = examRows(t.store).find(x => x.id === id);
    if (!r) return;
    examEditing = id;
    for (const f of t.fields) {
        const box = examField(f.name), value = r[f.name] === undefined || r[f.name] === null ? '' : String(r[f.name]);
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
    for (const f of t.fields) examField(f.name).value = f.type === 'select' && f.placeholder === null
        ? (examField(f.name).options[0] || {}).value || '' : '';
    renderExamList();
}

async function deleteExamRecord(id) {
    if (!allowed('academics', 'edit')) return;
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
