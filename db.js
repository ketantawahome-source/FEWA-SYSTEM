/* ---------- Where the system's data is kept: PostgreSQL, through the FEWA server ----------
   Every page loads this first (before auth.js). All the system's data lives in the PostgreSQL database behind
   server.mjs, so it is the same on every browser and computer that opens the system, and clearing the browser's
   data loses nothing.
   - fewaDB.getAll / getOne / put / remove / replace: students, documents, settings and deferrals.
     Photos and documents are files (Blobs) in the records, as before; their bytes are stored on the server.
   - serverValue / setServerValue: staff accounts and role rights, kept as text values (as they were in
     localStorage). They are read once when the page opens, so pages can use them straight away.
   - fewaSession: who is logged in. Logins and passwords are checked by the server (see auth.js), which only
     hands each person the data they may see.
   Only small conveniences stay in the browser: the remembered username, the sidebar choice, Last Activity.

   The first time a browser that kept the data itself (before PostgreSQL) opens the system and the database is
   still empty, its data is moved into the database by itself.
   Opened as a file, or with the server stopped, the page says how to open the system instead. */
const FEWA_API = '/api';
const FEWA_ADDRESS = 'http://localhost:5600/';
const STORE_KEYS = { students: 'id', documents: 'id', settings: 'key', deferrals: 'id' };
const fewaServer = { online: false, error: '' };

function apiSync(method, path, body) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, FEWA_API + path, false);
    xhr.setRequestHeader('X-FEWA-Client', '1');
    if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(body === undefined ? null : JSON.stringify(body));
    let result = null;
    try {
        result = xhr.responseText ? JSON.parse(xhr.responseText) : null;
    } catch { }
    if (xhr.status !== 200) throw new Error((result && result.error) || 'The FEWA server did not answer.');
    return result;
}

async function api(method, path, body) {
    let response;
    try {
        response = await fetch(FEWA_API + path, {
            method,
            headers: { 'X-FEWA-Client': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new Error('The FEWA server is not running. Start it with start-server.bat, then try again.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error((result && result.error) || `The FEWA server answered with an error (${response.status}).`);
    return result;
}

/* ---------- Who is logged in (the server decides, from its session cookie) ----------
   fewaSession: { kind: 'staff' | 'student' | 'reset' | null, accountId, username, admin, studentId,
   setupNeeded (no staff account yet, on the office computer), setupBlocked (no staff account yet, online) } */
let fewaSession = { kind: null };

/* ---------- Staff accounts and role rights ---------- */
let serverValues = {};
try {
    if (location.protocol === 'file:') throw new Error('The system was opened as a file.');
    fewaSession = apiSync('GET', '/session') || { kind: null };
    // Only staff (and the very first setup) see the accounts; the server gives nobody else any
    if (fewaSession.kind === 'staff' || fewaSession.setupNeeded) serverValues = apiSync('GET', '/values') || {};
    fewaServer.online = true;
} catch (err) {
    fewaServer.error = err.message;
}

const serverValue = key => Object.prototype.hasOwnProperty.call(serverValues, key) ? serverValues[key] : null;

let valueChannel = null;
try {
    valueChannel = new BroadcastChannel('fewa-value-changes');
} catch { }

// value: text, or null to remove it. Other open pages are told, and re-read the values.
function setServerValue(key, value) {
    const text = value == null ? null : String(value);
    apiSync('PUT', '/values/' + encodeURIComponent(key), { value: text });
    if (text === null) delete serverValues[key];
    else serverValues[key] = text;
    if (valueChannel) valueChannel.postMessage({ key });
}

// Works like localStorage, for code that is given a storage to use (removing a reset code in auth.js)
const serverStorage = {
    getItem: serverValue,
    setItem: setServerValue,
    removeItem: key => setServerValue(key, null)
};

// Another page changed a value: read them all again, then fire "fewa-value-change" (auth.js listens for it)
if (valueChannel) {
    valueChannel.addEventListener('message', event => {
        try {
            fewaSession = apiSync('GET', '/session') || { kind: null };
            serverValues = fewaSession.kind === 'staff' || fewaSession.setupNeeded ? apiSync('GET', '/values') || {} : {};
        } catch {
            return;
        }
        window.dispatchEvent(new CustomEvent('fewa-value-change', { detail: { key: event.data.key } }));
    });
}

/* ---------- Files inside records (student photos, uploaded documents) ---------- */
const fileRefs = new WeakMap(); // a Blob that came from (or was saved to) the server -> its reference there
const fileDownloads = new Map(); // file id -> Promise of its Blob, so each file is downloaded once per page

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function packRecord(value) {
    if (value instanceof Blob) {
        const ref = fileRefs.get(value);
        if (ref) return ref; // already on the server: not sent again
        const dataUrl = await blobToDataUrl(value);
        return { __newFile: true, type: value.type, name: value.name || null, data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(packRecord));
    if (value && typeof value === 'object') {
        const packed = {};
        for (const [key, inner] of Object.entries(value)) packed[key] = await packRecord(inner);
        return packed;

    }
    return value;
}

function downloadFile(ref) {
    if (!fileDownloads.has(ref.__file)) {
        fileDownloads.set(ref.__file, (async () => {
            const response = await fetch(`${FEWA_API}/files/${encodeURIComponent(ref.__file)}`, { headers: { 'X-FEWA-Client': '1' } });
            if (!response.ok) return null;
            const bytes = await response.blob();
            const blob = ref.name ? new File([bytes], ref.name, { type: ref.type }) : new Blob([bytes], { type: ref.type });
            fileRefs.set(blob, ref);
            return blob;
        })().catch(() => null));
    }
    return fileDownloads.get(ref.__file);
}

async function unpackRecord(value) {
    if (Array.isArray(value)) return Promise.all(value.map(unpackRecord));
    if (!value || typeof value !== 'object') return value;
    if (value.__file) return downloadFile(value);
    const unpacked = {};
    for (const [key, inner] of Object.entries(value)) unpacked[key] = await unpackRecord(inner);
    return unpacked;
}

// After a save: the Blobs in the record are now on the server, so saving the record again does not resend them
function rememberRefs(local, stored) {
    if (local instanceof Blob) {
        if (stored && stored.__file) fileRefs.set(local, stored);
    } else if (local && stored && typeof local === 'object' && typeof stored === 'object') {
        Object.keys(local).forEach(key => rememberRefs(local[key], stored[key]));
    }
}

/* ---------- Records: students, documents, settings, deferrals ---------- */
const storePath = (store, id) => `/stores/${encodeURIComponent(store)}` + (id === undefined ? '' : '/' + encodeURIComponent(id));

async function replaceStore(store, records, merge) {
    await api('POST', storePath(store, 'replace'), { records: await packRecord(records || []), merge: !!merge });
}

let dataReady = Promise.resolve();

const fewaDB = {
    async getAll(store) {
        await dataReady;
        return unpackRecord(await api('GET', storePath(store)));
    },
    // undefined when there is no such record
    async getOne(store, id) {
        await dataReady;
        if (id == null || id === '') return undefined;
        const record = await api('GET', storePath(store, id));
        return record ? unpackRecord(record) : undefined;
    },
    async put(store, record) {
        await dataReady;
        const id = record[STORE_KEYS[store]];
        rememberRefs(record, await api('PUT', storePath(store, id), await packRecord(record)));
        return id;
    },
    async remove(store, id) {
        await dataReady;
        await api('DELETE', storePath(store, id));
    },
    // Restoring a backup: writes every record; without merge, the store's other records are removed
    async replace(store, records, merge = false) {
        await dataReady;
        await replaceStore(store, records, merge);
    }
};

/* ---------- Data this browser kept itself, before PostgreSQL ---------- */
const LEGACY_LOCAL_KEYS = ['fewaAccounts', 'fewaRoleOperations'];
const MOVED_TO_SERVER_KEY = 'fewaMovedToServer';

// Every record this browser's own database (IndexedDB) holds, by store; {} when it has none
function readLegacyStores() {
    return new Promise(resolve => {
        let request;
        try {
            request = indexedDB.open('fewaCollegeDB');
        } catch {
            return resolve({});
        }
        request.onerror = () => resolve({});
        request.onsuccess = async () => {
            const db = request.result;
            const stores = {};
            for (const name of Object.keys(STORE_KEYS)) {
                if (!db.objectStoreNames.contains(name)) continue;
                stores[name] = await new Promise(done => {
                    const get = db.transaction(name).objectStore(name).getAll();
                    get.onsuccess = () => done(get.result || []);
                    get.onerror = () => done([]);
                });
            }
            db.close();
            resolve(stores);
        };
    });
}

const legacyLocal = key => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

// The database is empty and this browser has the system's data from before: move it in (accounts first, so
// logging in works straight away; the records follow, and pages wait for them before reading any)
// (Only while the system is being set up on the office computer: no staff account in the database yet)
if (fewaServer.online && fewaSession.setupNeeded && legacyLocal('fewaAccounts') && !legacyLocal(MOVED_TO_SERVER_KEY)) {
    try {
        LEGACY_LOCAL_KEYS.forEach(key => {
            const value = legacyLocal(key);
            if (value) setServerValue(key, value);
        });
        dataReady = (async () => {
            const stores = await readLegacyStores();
            for (const [name, records] of Object.entries(stores)) {
                if (records.length) await replaceStore(name, records, true);
            }
            localStorage.setItem(MOVED_TO_SERVER_KEY, new Date().toISOString());
            console.log('FEWA: this browser\'s data was moved into the PostgreSQL database.');
            if (typeof announceDataChange === 'function') announceDataChange('all');
        })().catch(err => {
            console.error('FEWA: moving this browser\'s data into the database failed', err);
            alert('Some of the data kept in this browser could not be moved into the database: ' + err.message +
                '\n\nIt is still in this browser. Restart the server, then open the system again to retry.');
        });
    } catch (err) {
        console.error('FEWA: moving this browser\'s data into the database failed', err);
    }
}

// Saves the data this browser kept itself into a backup file (for "Restore from backup" on the login page)
async function exportLegacyData() {
    const toBackupValue = async value => {
        if (value instanceof Blob) return { __backupBlob: true, type: value.type, name: value.name || null, data: await blobToDataUrl(value) };
        if (Array.isArray(value)) return Promise.all(value.map(toBackupValue));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, inner] of Object.entries(value)) out[key] = await toBackupValue(inner);
            return out;
        }
        return value;
    };
    const stores = {};
    for (const [name, records] of Object.entries(await readLegacyStores())) stores[name] = await toBackupValue(records);
    const local = Object.fromEntries(LEGACY_LOCAL_KEYS.map(key => [key, legacyLocal(key)]));
    const backup = { app: 'FEWA College System', version: 1, savedAt: new Date().toISOString(), local, stores };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    link.download = `FEWA-data-from-this-browser-${backup.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    const students = (stores.students || []).length;
    let staff = 0;
    try { staff = JSON.parse(local.fewaAccounts || '[]').length; } catch { }
    return `${staff} staff account(s) and ${students} student(s)`;
}

/* ---------- Opened as a file, or the server/database is not available ---------- */
function showServerProblem() {
    const asFile = location.protocol === 'file:';
    const box = document.createElement('div');
    box.className = 'fewa-server-problem';
    box.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#f6f2fb;display:flex;align-items:center;' +
        'justify-content:center;padding:16px;font-family:inherit;color:#24103a;overflow:auto';
    box.innerHTML = `
        <div style="max-width:620px;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(36,16,58,.18);
                    border-top:5px solid #d4a843;line-height:1.55">
            <h2 style="margin:0 0 12px">${asFile ? 'Open the FEWA system through its server' : 'The FEWA system cannot reach its database'}</h2>
            <p style="margin:0 0 12px" class="problem-text"></p>
            <ol style="margin:0 0 16px;padding-left:20px">
                <li>Double-click <b>start-server.bat</b> in the FEWA SYSTEM folder and keep its window open.</li>
                <li>Open <a href="${FEWA_ADDRESS}" style="color:#5b2d8e;font-weight:bold">${FEWA_ADDRESS}</a></li>
            </ol>
            <div class="legacy-export" style="display:none;border-top:1px solid #e6def0;padding-top:14px">
                <p style="margin:0 0 10px">This browser still has data saved by the old version of the system.
                    Save it to a file, then on the login page at ${FEWA_ADDRESS} press <b>Restore from backup</b> and choose that file.</p>
                <button type="button" style="background:#24103a;color:#fff;border:0;border-radius:8px;padding:10px 16px;
                        font-weight:bold;cursor:pointer">Save this browser's data to a file</button>
                <span class="legacy-result" style="margin-left:10px"></span>
            </div>
        </div>`;
    box.querySelector('.problem-text').textContent = asFile
        ? 'The system now keeps all its data in the PostgreSQL database, so it must be opened at its web address, not as a file.'
        : fewaServer.error;
    document.body.appendChild(box);

    if (asFile && legacyLocal('fewaAccounts')) {
        const area = box.querySelector('.legacy-export');
        area.style.display = '';
        area.querySelector('button').onclick = async () => {
            try {
                const summary = await exportLegacyData();
                area.querySelector('.legacy-result').textContent = `Saved (${summary}) to your Downloads folder.`;
            } catch (err) {
                area.querySelector('.legacy-result').textContent = 'Could not save: ' + err.message;
            }
        };
    }
}

if (!fewaServer.online) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showServerProblem);
    else showServerProblem();
}
