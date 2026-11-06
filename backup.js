/* ---------- Backup ----------
   Everything the system keeps lives in the database: Supabase online (through the server), with a two-way synced
   PostgreSQL copy on the office computer. Nothing is saved in the browser, on this computer or in OneDrive;
   database backups are made in Supabase (Database > Backups).
   The only thing left here: when a brand-new, empty system is set up, the login page's "Restore from Backup File"
   can read a backup file made by an older version and put its data into the database.
   Needs db.js and auth.js loaded first. */
const BACKUP_APP = 'FEWA College System';
const BACKUP_STORES = ['students', 'documents', 'settings', 'deferrals'];
const BACKUP_LOCAL_KEYS = ['fewaAccounts', 'fewaRoleOperations'];

// Photos and documents in a backup file are text; they become files again
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

// Puts a backup file's data into the database. Without "merge" it replaces everything; with "merge" it only
// adds or updates its own records.
async function restoreBackup(backup) {
    for (const name of BACKUP_STORES) {
        await fewaDB.replace(name, await unpackValue(backup.stores[name] || []), !!backup.merge);
    }
    for (const key of BACKUP_LOCAL_KEYS) {
        if (backup.merge && backup.local[key] == null) continue;
        setServerValue(key, backup.local[key] == null ? null : backup.local[key]);
    }
    if (typeof announceDataChange === 'function') announceDataChange('all');
}

// auth.js calls this after every change; the database already has it, so there is nothing more to save
function scheduleBackup() { }
