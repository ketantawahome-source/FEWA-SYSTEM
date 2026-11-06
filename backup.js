/* ---------- Backup & Restore ----------
   Everything the system keeps lives in the PostgreSQL database (through db.js): staff accounts and rights,
   students, photos, documents, settings and deferrals (Supabase, with a two-way synced PostgreSQL copy).
   Backup files on this computer / OneDrive are switched off for now (BACKUP_FILES_ON below).
   Reading an old backup file still works: the login page's "Restore from backup" (first setup only).
   Needs db.js and auth.js (account keys, announceDataChange) loaded first. */
const BACKUP_APP = 'FEWA College System';
const BACKUP_STORES = ['students', 'documents', 'settings', 'deferrals'];
const BACKUP_LOCAL_KEYS = ['fewaAccounts', 'fewaRoleOperations'];
const LAST_BACKUP_KEY = 'fewaLastBackup';
const BACKUP_DELAY_MS = 3000;

const backupSupported = () => typeof window.showSaveFilePicker === 'function';

// Photos and documents are files (Blobs); in the backup they are written out as text and turned back on restore
function blobToText(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function packValue(value) {
    if (value instanceof Blob) {
        return { __backupBlob: true, type: value.type, name: value.name || null, data: await blobToText(value) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(packValue));
    if (value && typeof value === 'object') {
        const packed = {};
        for (const [key, inner] of Object.entries(value)) packed[key] = await packValue(inner);
        return packed;
    }
    return value;
}

async function unpackValue(value) {
    if (value && value.__backupBlob) {
        const blob = await (await fetch(value.data)).blob();
        return value.name ? new File([blob], value.name, { type: value.type }) : new Blob([blob], { type: value.type });
    }
    if (Array.isArray(value)) return Promise.all(value.map(unpackValue));
    if (value && typeof value === 'object') {
        const unpacked = {};
        for (const [key, inner] of Object.entries(value)) unpacked[key] = await unpackValue(inner);
        return unpacked;
    }
    return value;
}

// All the system's data as one object
async function collectBackup() {
    const stores = {};
    for (const name of BACKUP_STORES) stores[name] = await packValue(await fewaDB.getAll(name));
    // Staff accounts and rights ("local": where they were kept before the database, so old backups still restore)
    const local = {};
    for (const key of BACKUP_LOCAL_KEYS) local[key] = serverValue(key);
    return { app: BACKUP_APP, version: 1, savedAt: new Date().toISOString(), local, stores };
}

const backupSummary = backup => {
    let staff = 0;
    try { staff = JSON.parse(backup.local.fewaAccounts || '[]').length; } catch { }
    return `${staff} staff account(s), ${(backup.stores.students || []).length} student(s), ` +
        `${(backup.stores.documents || []).length} document(s)`;
};

// Reads a backup file; throws with a plain message when it is not one
async function readBackupFile(file) {
    let backup;
    try {
        backup = JSON.parse(await file.text());
    } catch {
        throw new Error('This file is not a FEWA backup file.');
    }
    if (!backup || backup.app !== BACKUP_APP || !backup.stores || !backup.local) {
        throw new Error('This file is not a FEWA backup file.');
    }
    return backup;
}

// Replaces everything in the database with the backup. A backup marked "merge" (e.g. records recovered
// from exported lists) only adds or updates its own records and keeps everything else, staff accounts included.
async function restoreBackup(backup) {
    for (const name of BACKUP_STORES) {
        await fewaDB.replace(name, await unpackValue(backup.stores[name] || []), !!backup.merge);
    }
    for (const key of BACKUP_LOCAL_KEYS) {
        if (backup.merge && backup.local[key] == null) continue;
        setServerValue(key, backup.local[key] == null ? null : backup.local[key]);
    }
    if (!backup.merge) localStorage.setItem(LAST_BACKUP_KEY, backup.savedAt);
    if (typeof announceDataChange === 'function') announceDataChange('all');
}

// A copy saved by hand into the Downloads folder (works in every browser)
async function downloadBackup() {
    const backup = await collectBackup();
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `FEWA-backup-${backup.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    return backup;
}

/* ---------- Automatic backup into a chosen file ----------
   The chosen file is remembered in its own small database. After the browser is restarted it may ask once
   for permission to keep saving; until then a bar at the top of staff pages offers "Resume backup". */
function handleStore(mode, action) {
    return new Promise(resolve => {
        const request = indexedDB.open('fewaBackupFile', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('handles', mode);
            const result = action(transaction.objectStore('handles'));
            transaction.oncomplete = () => { db.close(); resolve(result && result.result); };
            transaction.onerror = () => { db.close(); resolve(null); };
        };
    });
}

const getBackupHandle = () => handleStore('readonly', store => store.get('main'));
const saveBackupHandle = handle => handleStore('readwrite', store => store.put(handle, 'main'));
const forgetBackupHandle = () => handleStore('readwrite', store => store.delete('main'));

// Returns 'saved', 'no-file', 'needs-permission', 'unsupported' or 'failed'
async function backupNow({ askPermission = false } = {}) {
    if (!backupSupported()) return 'unsupported';
    const handle = await getBackupHandle();
    if (!handle) return 'no-file';
    try {
        let permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted' && askPermission) permission = await handle.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') return 'needs-permission';
        const backup = await collectBackup();
        // Never replace a good backup with an empty system (e.g. right after the browsing data was cleared)
        if (!getAccounts().length) return 'failed';
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(backup));
        await writable.close();
        localStorage.setItem(LAST_BACKUP_KEY, backup.savedAt);
        hideBackupBar();
        return 'saved';
    } catch {
        return 'failed';
    }
}

// Asks where to keep the backup file, then saves it there
async function chooseBackupFile() {
    if (!backupSupported()) return 'unsupported';
    let handle;
    try {
        handle = await showSaveFilePicker({
            suggestedName: 'FEWA-backup.json',
            types: [{ description: 'FEWA backup', accept: { 'application/json': ['.json'] } }]
        });
    } catch {
        return 'cancelled';
    }
    await saveBackupHandle(handle);
    return backupNow({ askPermission: true });
}

// Called after every change. Backup files on this computer / OneDrive are switched off for now: the data is
// kept online (Supabase) and in the PostgreSQL copy, so nothing is saved to a file any more.
const BACKUP_FILES_ON = false;
let backupTimer = null;
function scheduleBackup() {
    if (!BACKUP_FILES_ON) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
        const result = await backupNow();
        if (result === 'needs-permission' || result === 'failed') showBackupBar(result);
    }, BACKUP_DELAY_MS);
}
// A backup file chosen earlier is forgotten, so the browser no longer keeps writing to it
if (!BACKUP_FILES_ON && typeof indexedDB !== 'undefined') forgetBackupHandle().catch(() => { });

function lastBackupText() {
    const at = localStorage.getItem(LAST_BACKUP_KEY);
    return at ? new Date(at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'never';
}

/* The bar at the top of staff pages: backup not set up (administrators), or paused until permission is given */
function hideBackupBar() {
    const bar = document.getElementById('backupBar');
    if (bar) bar.remove();
}

function showBackupBar(reason) {
    if (!document.getElementById('content-area') || !currentUser()) return;
    if (reason === 'no-file' && !isAdmin()) return;
    hideBackupBar();
    const bar = document.createElement('div');
    bar.id = 'backupBar';
    bar.className = 'backup-bar no-print';
    const text = {
        'no-file': 'Backup is not set up. If the browsing data is cleared, all staff and student data will be lost.',
        'needs-permission': 'Automatic backup is paused. Press "Resume Backup" to keep the backup file up to date.',
        failed: 'The backup file could not be saved. Check that it is still there, then press "Resume Backup".'
    }[reason];
    bar.innerHTML = `<span class="backup-bar-icon">!</span><span class="backup-bar-text"></span>
        <button type="button" class="backup-bar-button"></button>`;
    bar.querySelector('.backup-bar-text').textContent = text;
    const button = bar.querySelector('.backup-bar-button');
    button.textContent = reason === 'no-file' ? 'Set Up Backup' : 'Resume Backup';
    button.onclick = async () => {
        const result = reason === 'no-file' ? await chooseBackupFile() : await backupNow({ askPermission: true });
        if (result === 'saved' && typeof showToast === 'function') showToast('Backup saved. It will now update by itself after every change.');
    };
    const content = document.getElementById('content-area');
    const crumbs = content.querySelector(':scope > .page-crumbs');
    content.insertBefore(bar, crumbs ? crumbs.nextSibling : content.firstChild);
}

// The data is kept in the database (Supabase, plus the PostgreSQL copy on the office computer), so pages no
// longer warn about backup files; Settings > System Data Backups shows where the data is kept.
