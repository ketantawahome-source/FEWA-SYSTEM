/* ---------- FEWA system: Settings > System Data Backups ----------
   The page for backups (the server side is backups.mjs): the password-protected download, the database backups, and
   uploading corrected students. Loaded by StudentAdmissions.html, whose helpers it uses (escapeHtml, showToast, api...). */
async function renderBackupPage() {
    document.getElementById('settingsBanner').innerText = 'System Data Backups';
    const content = document.getElementById('settingsContent');
    if (!isAdmin()) {
        content.innerHTML = '<div class="empty-state">Only administrators can back up or restore the system.</div>';
        return;
    }
    content.innerHTML = '<div class="empty-state">Loading the backups...</div>';
    let list;
    try {
        list = await api('GET', '/backups');
    } catch (error) {
        content.innerHTML = `<div class="empty-state">The backups could not be loaded: ${escapeHtml(error.message)}</div>`;
        return;
    }
    const sizeText = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((bytes || 0) / 1024)) + ' KB';
    const rows = list.backups.map(b => {
        const s = b.summary || {};
        return `<tr>
            <td>${escapeHtml(new Date(b.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
            <td>${escapeHtml(b.note || '')}</td>
            <td>${escapeHtml(`${s.students || 0} student(s), ${s.documents || 0} document(s), ${s.staff || 0} staff, ${s.files || 0} file(s)`)}</td>
            <td>${escapeHtml(sizeText(b.sizeBytes))}</td>
            <td>${escapeHtml(b.createdBy || '')}</td>
            <td style="white-space:nowrap">
                <button type="button" class="btn-submit btn-secondary" onclick="restoreOnlineBackup('${escapeHtml(b.id)}')">Restore</button>
                <button type="button" class="btn-submit btn-secondary" onclick="deleteOnlineBackup('${escapeHtml(b.id)}')">Delete</button>
            </td></tr>`;
    }).join('');
    content.innerHTML = `
        <div class="backup-page">
            <p class="backup-intro">All staff accounts, rights, students, photos, documents and settings are saved straight
                into the main database (<b>Supabase</b>) every time you press Save. Backups are kept separately in
                <b>PostgreSQL on the office computer</b>: database <b>fewa_backups</b>, schema <b>backups</b>, table
                <b>snapshots</b> (in pgAdmin). One is made by itself every day, and any time with <b>Back Up Now</b>.
                You can also download your own password-protected copy below.</p>
            <div class="backup-status">
                <div><span>Online system:</span> <b>fewa-system.onrender.com</b></div>
                <div><span>Main database:</span> <b>Supabase</b> (online)</div>
                <div><span>Copy:</span> <b>PostgreSQL</b> on the office computer, database fewa_college (kept in step both ways)</div>
                <div><span>Backups:</span> <b>PostgreSQL</b> on the office computer, database fewa_backups</div>
            </div>
            ${backupDownloadForm()}
            <h3 class="backup-heading">Database backups</h3>
            ${list.available ? '' : `<div class="empty-state" style="margin-top:16px">${escapeHtml(list.reason || '')}</div>`}
            ${list.problem ? `<div class="empty-state" style="margin-top:16px;color:#c0392b"><b>The last daily backup failed:</b> ${escapeHtml(list.problem)}</div>` : ''}
            <div class="backup-actions" style="${list.available ? '' : 'display:none'}">
                <input type="text" id="backupNote" maxlength="200" placeholder="Note (optional), e.g. Before the January intake"
                    style="flex:1;min-width:220px;padding:10px;border:1px solid #d8cfe3;border-radius:8px">
                <button type="button" class="btn-submit" id="backupNowButton" onclick="makeOnlineBackup()">Back Up Now</button>
            </div>
            ${!list.available ? '' : list.backups.length ? `<div class="table-wrapper" style="overflow-x:auto;margin-top:16px"><table class="data-table">
                <thead><tr><th>Made</th><th>Note</th><th>Contents</th><th>Size</th><th>By</th><th></th></tr></thead>
                <tbody>${rows}</tbody></table></div>`
            : '<div class="empty-state" style="margin-top:16px">No backups yet. Press Back Up Now to make the first one.</div>'}
            <p class="backup-note">The newest 60 backups are kept. Restoring first makes a backup of the data as it is now,
                so a restore can always be undone.</p>
                ${list.available ? backupUploadForm() : ''}
        </div>`;
    updateBackupCount();
}

/* A password-protected zip file to keep (server.mjs: sendBackupZip) */
const BACKUP_DOWNLOAD_PARTS = [
    ['students', 'Students', "Every student's admission details, course and contacts. A date range keeps only students admitted in it."],
    ['applications', 'Online applications', 'Applications sent through the online form. A date range keeps only those sent in it.'],
    ['documents', 'Student documents (list)', 'The list of documents uploaded for students. A date range keeps only those uploaded in it.'],
    ['deferrals', 'Deferrals and suspensions', 'Deferral and suspension records. A date range keeps only those starting in it.'],
    ['files', 'Photos and uploaded files', 'The photos and documents themselves. A date range keeps only those uploaded in it.'],
    ['staff', 'Staff', 'Staff details (never their passwords). Always everything, whatever the period.'],
    ['settings', 'Settings', 'School Setup, courses, campuses, terms and other setup lists. Always everything, whatever the period.'],
    ['code', 'System code', "The system's own program files, in a folder called code (never any passwords). Always the current version, whatever the period."]
];

function backupDownloadForm() {
    return `<form class="backup-download" onsubmit="downloadBackup(event)">
        <h3 class="backup-heading">Download a password-protected copy</h3>
        <p class="backup-note">Makes a protected zip file of the records you choose, so the college keeps its own copy.
            It downloads straight to this computer: <b>keep the file somewhere safe</b>.</p>
        <h4><span class="backup-step">1</span> Choose what to include</h4>
        <label class="backup-check backup-all"><input type="checkbox" id="backupAll" checked onchange="toggleBackupParts(this.checked)">
            <b>Select all</b> <span id="backupCount"></span></label>
        ${BACKUP_DOWNLOAD_PARTS.map(([value, name, about]) => `<label class="backup-check">
            <input type="checkbox" name="part" value="${value}" checked onchange="updateBackupCount()">
            <span><b>${escapeHtml(name)}</b><small>${escapeHtml(about)}</small></span></label>`).join('')}
        <h4><span class="backup-step">2</span> Choose the period</h4>
        <div class="backup-period">
            <label><input type="radio" name="period" value="all" checked onchange="updateBackupPeriod()"> All records (recommended for a backup)</label>
            <label><input type="radio" name="period" value="range" onchange="updateBackupPeriod()"> Only a date range</label>
        </div>
        <div class="backup-dates" id="backupDates" hidden>
            <label>From <input type="date" name="from"></label>
            <label>To <input type="date" name="to"></label>
        </div>
        <h4><span class="backup-step">3</span> Protect the file with a password</h4>
        <div class="backup-passwords">
            <label>Password <input type="password" name="password" placeholder="At least 8 characters" autocomplete="new-password" required minlength="8" maxlength="128"></label>
            <label>Type the password again <input type="password" name="again" autocomplete="new-password" required maxlength="128"></label>
            <label class="backup-show"><input type="checkbox" onchange="showBackupPasswords(this)"> Show password</label>
        </div>
        <p class="backup-note">Keep this password safe: the system does not store it and cannot recover it. To open the backup, use
            <b>7-Zip</b> (free, www.7-zip.org) or WinZip and enter this password. The zip tool built into Windows cannot open protected files of this kind.</p>
        <button type="submit" class="btn-submit" id="backupDownloadButton">Create Backup</button>
    </form>`;
}

function updateBackupCount() {
    const boxes = [...document.querySelectorAll('.backup-download [name=part]')];
    const ticked = boxes.filter(b => b.checked).length;
    document.getElementById('backupCount').textContent = `(${ticked} of ${boxes.length} selected)`;
    document.getElementById('backupAll').checked = ticked === boxes.length;
}

function toggleBackupParts(on) {
    document.querySelectorAll('.backup-download [name=part]').forEach(b => b.checked = on);
    updateBackupCount();
}

function updateBackupPeriod() {
    document.getElementById('backupDates').hidden = document.querySelector('.backup-download [name=period]:checked').value !== 'range';
}

function showBackupPasswords(box) {
    document.querySelectorAll('.backup-passwords input:not([type=checkbox])').forEach(i => i.type = box.checked ? 'text' : 'password');
}

async function downloadBackup(event) {
    event.preventDefault();
    const form = event.target;
    const include = [...form.querySelectorAll('[name=part]:checked')].map(b => b.value);
    if (!include.length) return alert('Tick at least one thing to include.');
    const password = form.elements['password'].value;
    if (password !== form.elements['again'].value) return alert('The two passwords are not the same.');
    const ranged = form.querySelector('[name=period]:checked').value === 'range';
    const from = ranged ? form.elements['from'].value : '';
    const to = ranged ? form.elements['to'].value : '';
    if (ranged && (!from || !to)) return alert('Choose both dates of the period.');
    const button = document.getElementById('backupDownloadButton');
    button.disabled = true;
    button.textContent = 'Preparing the backup...';
    try {
        const response = await fetch(FEWA_API + '/backups/download', {
            method: 'POST',
            headers: { 'X-FEWA-Client': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ include, from, to, password })
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The server could not make the backup.');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `FEWA-backup-${new Date().toISOString().slice(0, 10)}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        form.elements['password'].value = form.elements['again'].value = '';
        showToast('Backup downloaded. Keep the file and its password safe.');
    } catch (error) {
        alert('The backup could not be made: ' + error.message);
    }
    button.disabled = false;
    button.textContent = 'Create Backup';
}

async function makeOnlineBackup() {
    const button = document.getElementById('backupNowButton');
    button.disabled = true;
    button.textContent = 'Backing up...';
    try {
        const result = await api('POST', '/backups', { note: document.getElementById('backupNote').value.trim() });
        showToast('Backup saved in PostgreSQL on the office computer (fewa_backups).');
    } catch (error) {
        showToast('The backup could not be made: ' + error.message, 'warning');
    }
    renderBackupPage();
}

async function restoreOnlineBackup(id) {
    if (!confirm('Restore this backup?\n\nEVERYTHING in the system now (students, documents, settings, staff accounts) ' +
        'will be replaced by the backup. A backup of the data as it is now is made first, so this can be undone.')) return;
    try {
        const result = await api('POST', `/backups/${encodeURIComponent(id)}/restore`);
        if (result.result === 'no-staff') return alert('This backup has no staff accounts, so nobody could log in after restoring it. It was not restored.');
        if (result.result !== 'ok') return alert('This backup no longer exists.');
        showToast('Backup restored successfully.');
        // The signed-in account may differ in the backup
        setTimeout(() => location.reload(), 1200);
    } catch (error) {
        alert('The backup could not be restored: ' + error.message + '\n\nNothing was changed.');
    }
}

async function deleteOnlineBackup(id) {
    if (!confirm('Delete this backup from the office computer? This cannot be undone.')) return;
    try {
        await api('DELETE', `/backups/${encodeURIComponent(id)}`);
        showToast('Backup deleted.');
    } catch (error) {
        showToast('The backup could not be deleted: ' + error.message, 'warning');
    }
    renderBackupPage();
}

/* Uploading corrected students: nothing is saved until the administrator has seen exactly what will change */
let uploadedStudents = null; // { csv, planId } after a check with nothing wrong

function backupUploadForm() {
    return `<div class="backup-download">
        <h3 class="backup-heading">Upload corrected student details</h3>
        <p class="backup-note">Open <b>students.csv</b> from a downloaded backup, correct it in Excel, and save it (choose <b>CSV UTF-8</b>).
            Nothing is saved until you have seen the changes. A student missing from the file is left as they are, and to add a student,
            add a row with the id left empty. Admission numbers, logins, status and photos can't be changed this way.</p>
        <input type="file" id="studentsFile" accept=".csv,text/csv" onchange="clearUploadCheck()">
        <button type="button" class="btn-secondary" id="checkUploadButton" onclick="checkUploadedStudents()">Check the File</button>
        <div id="uploadResult"></div>
    </div>`;
}

function clearUploadCheck() {
    uploadedStudents = null;
    document.getElementById('uploadResult').innerHTML = '';
}

async function checkUploadedStudents() {
    clearUploadCheck();
    const file = document.getElementById('studentsFile').files[0];
    if (!file) return alert('Choose the students.csv file first.');
    if (file.size > 4 * 1024 * 1024) return alert('This file is too large.');
    const button = document.getElementById('checkUploadButton');
    button.disabled = true;
    try {
        const csv = await file.text();
        const plan = await api('POST', '/backups/upload/check', { csv });
        document.getElementById('uploadResult').innerHTML = uploadPlanHtml(plan);
        if (!plan.errorCount && (plan.changes.length || plan.adds.length)) uploadedStudents = { csv, planId: plan.planId };
    } catch (error) {
        document.getElementById('uploadResult').innerHTML = `<div class="upload-problems">${escapeHtml(error.message)}</div>`;
    }
    button.disabled = false;
}

function uploadPlanHtml(plan) {
    const summary = `<p><b>${plan.total}</b> row(s) read: <b>${plan.changes.length}</b> student(s) to update, <b>${plan.adds.length}</b> to add,
        ${plan.unchanged} unchanged.</p>`;
    if (plan.errorCount) {
        return summary + `<div class="upload-problems"><b>Nothing can be saved until these ${plan.errorCount} problem(s) are fixed in the file:</b>
            <ul>${plan.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`;
    }
    if (!plan.changes.length && !plan.adds.length) return summary + '<p>There is nothing to save: the file is the same as the system.</p>';
    const label = column => escapeHtml(column.replace(/_/g, ' '));
    const rows = plan.changes.flatMap(c => c.fields.map(f => `<tr><td>${escapeHtml(c.admNo)}</td><td>${escapeHtml(c.name)}</td><td>${label(f.column)}</td>
        <td>${escapeHtml(f.from) || '<em>empty</em>'}</td><td>${escapeHtml(f.to) || '<em>empty</em>'}</td></tr>`)).concat(
        plan.adds.map(a => `<tr><td>${escapeHtml(a.admNo)}</td><td>${escapeHtml(a.name)}</td><td colspan="3"><b>New student</b></td></tr>`)).join('');
    return summary + `<div class="table-wrapper" style="overflow-x:auto"><table class="data-table">
        <thead><tr><th>AdmNo</th><th>Student</th><th>Detail</th><th>Now</th><th>Will become</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${plan.ignored.length ? `<p class="backup-note">These columns are not changed by an upload: ${escapeHtml(plan.ignored.join(', '))}.</p>` : ''}
        <button type="button" class="btn-submit" id="saveUploadButton" onclick="saveUploadedStudents()">Save These Changes</button>`;
}

async function saveUploadedStudents() {
    if (!uploadedStudents) return;
    if (!confirm('Save these changes to the student records?\n\nA backup of the data as it is now is made first, so this can be undone with Restore.')) return;
    const button = document.getElementById('saveUploadButton');
    button.disabled = true;
    button.textContent = 'Saving...';
    try {
        const result = await api('POST', '/backups/upload/apply', uploadedStudents);
        showToast(`Saved: ${result.updated || 0} student(s) updated, ${result.added || 0} added.`);
        uploadedStudents = null;
        renderBackupPage();
    } catch (error) {
        alert('Nothing was saved: ' + error.message);
        button.disabled = false;
        button.textContent = 'Save These Changes';
    }
}
