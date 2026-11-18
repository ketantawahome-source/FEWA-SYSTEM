/* ---------- Settings > Program Setup > Programme Units ----------
   The units each course is made of, with the year and semester they are taken in and whether they are Core or
   Elective (table academics.programme_units). Units come from Academic Management > Manage Units > Units register.
   Used by StudentAdmissions.html (SETTINGS_PAGES.programmeUnits); Manage Units reads the same records to put a
   course's units on offer. May be changed by roles with Edit Settings or Edit Units. */
let programmeCourse = '';

const mayEditProgrammes = () => can('settings', 'edit') || can('academics', 'edit');

async function renderProgrammeUnits() {
    document.getElementById('settingsBanner').innerText = 'Programme units: choose a course, then add the units it is made of, ' +
        'with the year and semester they are taken in and whether they are Core or Elective. Courses come from the Courses tab; ' +
        'units from Academic Management > Manage Units > Units register.';
    document.getElementById('settingsBanner').classList.add('info-banner');
    const content = document.getElementById('settingsContent');
    content.innerHTML = '<div class="empty-state">Loading the programme units...</div>';

    const [courseItems, units, rows] = await Promise.all([
        getSettingItems('courses').catch(() => []),
        fewaDB.getAll('units').catch(() => []),
        fewaDB.getAll('programme_units').catch(() => [])
    ]);
    const courses = courseItems.filter(c => c.enabled !== 'NO').map(courseLabel).filter(Boolean);
    units.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
    if (!courses.includes(programmeCourse)) programmeCourse = '';
    const unitOf = code => units.find(u => String(u.code).toLowerCase() === String(code).toLowerCase()) || {};
    const option = (value, text, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(text)}</option>`;
    const mine = rows.filter(p => p.course === programmeCourse)
        .sort((a, b) => a.yearOfStudy - b.yearOfStudy || a.semester - b.semester || String(a.unitCode).localeCompare(String(b.unitCode)));
    const hours = mine.reduce((sum, p) => sum + Number(unitOf(p.unitCode).creditHours || 0), 0);
    const edit = mayEditProgrammes();

    content.innerHTML = `
        <div class="settings-form">
            <div class="section-title">Add a Unit to a Course</div>
            <div class="grid-3">
                <div class="form-group"><label>Course <span class="req">*</span></label>
                    <select id="puCourse" onchange="programmeCourse = this.value; renderProgrammeUnits()">
                        ${option('', courses.length ? '-- choose a course --' : '-- no courses yet (Courses tab) --', !programmeCourse)}
                        ${courses.map(c => option(c, c, c === programmeCourse)).join('')}</select></div>
                <div class="form-group"><label>Unit <span class="req">*</span></label>
                    <select id="puUnit">${option('', units.length ? '-- choose a unit --' : '-- no units yet (Manage Units > Units register) --', true)}
                        ${units.map(u => option(u.code, `${u.code} - ${u.title}`)).join('')}</select></div>
                <div class="form-group"><label>Type</label>
                    <select id="puType">${option('Core', 'Core', true)}${option('Elective', 'Elective')}</select></div>
                <div class="form-group"><label>Year of study <span class="req">*</span></label>
                    <select id="puYear">${[1, 2, 3, 4, 5, 6].map(n => option(n, 'Year ' + n, n === 1)).join('')}</select></div>
                <div class="form-group"><label>Semester <span class="req">*</span></label>
                    <select id="puSemester">${[1, 2, 3].map(n => option(n, 'Semester ' + n, n === 1)).join('')}</select></div>
            </div>
            <div style="margin-top: 12px;"><button type="button" class="btn-submit" onclick="addProgrammeUnitSetting()" ${edit ? '' : 'disabled'}>Add Unit</button></div>
        </div>
        <div class="section-title" style="margin-top: 22px;">Units of ${escapeHtml(programmeCourse || 'the course')}</div>
        ${programmeCourse ? `<p class="units-count" style="color: var(--fewa-muted); margin: 6px 0;">${mine.length} unit${mine.length === 1 ? '' : 's'}, ${hours} credit hours in all</p>` : ''}
        <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Year</th><th>Semester</th><th>Unit Code</th><th>Unit Title</th><th>Credit Hours</th><th>Type</th><th>Actions</th></tr></thead>
            <tbody>${!programmeCourse ? '<tr class="empty-row"><td colspan="7">Choose a course above.</td></tr>'
                : mine.length ? mine.map(p => `<tr><td>Year ${escapeHtml(p.yearOfStudy)}</td><td>Semester ${escapeHtml(p.semester)}</td>
                    <td>${escapeHtml(p.unitCode)}</td><td>${escapeHtml(unitOf(p.unitCode).title || '(not in the Units register)')}</td>
                    <td>${escapeHtml(unitOf(p.unitCode).creditHours ?? '')}</td><td>${escapeHtml(p.unitType || 'Core')}</td>
                    <td>${edit ? iconButton('delete', 'Remove ' + escapeHtml(p.unitCode), `removeProgrammeUnitSetting('${p.id}')`) : ''}</td></tr>`).join('')
                : '<tr class="empty-row"><td colspan="7">This course has no units yet. Add them above.</td></tr>'}</tbody>
        </table></div>`;
}

async function addProgrammeUnitSetting() {
    if (!mayEditProgrammes()) return allowed('settings', 'edit');
    const course = document.getElementById('puCourse').value, unitCode = document.getElementById('puUnit').value;
    if (!course || !unitCode) return alert('Choose the course and the unit.');
    const rows = await fewaDB.getAll('programme_units');
    if (rows.some(p => p.course === course && String(p.unitCode).toLowerCase() === unitCode.toLowerCase())) {
        return alert(`${unitCode} is already a unit of ${course}.`);
    }
    try {
        await fewaDB.put('programme_units', {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10), course, unitCode,
            yearOfStudy: Number(document.getElementById('puYear').value), semester: Number(document.getElementById('puSemester').value),
            unitType: document.getElementById('puType').value
        });
        showToast(`${unitCode} added to ${course}.`);
        renderProgrammeUnits();
    } catch (err) { alert('The unit could not be added: ' + err.message); }
}

async function removeProgrammeUnitSetting(id) {
    if (!mayEditProgrammes()) return allowed('settings', 'edit');
    const p = (await fewaDB.getAll('programme_units')).find(x => x.id === id);
    if (!p || !confirm(`Remove ${p.unitCode} from ${p.course}? The unit stays in the Units register.`)) return;
    try {
        await fewaDB.remove('programme_units', id);
        showToast(`${p.unitCode} removed from ${p.course}.`);
        renderProgrammeUnits();
    } catch (err) { alert('The unit could not be removed: ' + err.message); }
}
