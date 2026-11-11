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
const STORE_KEYS = { students: 'id', documents: 'id', settings: 'key', deferrals: 'id', applications: 'id' };
const fewaServer = { online: false, error: '' };

function apiSync(method, path, body) {
    if (method !== 'GET' && typeof forgetReads === 'function') forgetReads();
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

/* Records read from the server are remembered on this page for a minute, so moving between tabs does not fetch the
   same students or settings again (each fetch goes to the database online, which takes time). Anything saved clears
   them at once, so this page never shows its own changes late; another person's changes show within a minute, or
   straight away after a refresh. Only kept in the page's memory, never stored in the browser. */
const READ_MEMORY_MS = 60000;
const readMemory = new Map();
function forgetReads() { readMemory.clear(); }
function rememberedGet(path) {
    const hit = readMemory.get(path);
    if (hit && Date.now() - hit.at < READ_MEMORY_MS) return hit.answer;
    const answer = api('GET', path);
    readMemory.set(path, { at: Date.now(), answer });
    answer.catch(() => readMemory.delete(path));
    return answer;
}

async function api(method, path, body) {
    if (method !== 'GET') forgetReads();
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
        return unpackRecord(await rememberedGet(storePath(store)));
    },
    // undefined when there is no such record
    async getOne(store, id) {
        await dataReady;
        if (id == null || id === '') return undefined;
        // Taken from the whole list when this page has just read it
        const list = readMemory.get(storePath(store));
        if (list && Date.now() - list.at < READ_MEMORY_MS && STORE_KEYS[store]) {
            const all = await list.answer.catch(() => null);
            if (Array.isArray(all)) {
                const found = all.find(r => String(r[STORE_KEYS[store]]) === String(id));
                return found ? unpackRecord(found) : undefined;
            }
        }
        const record = await rememberedGet(storePath(store, id));
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

/* ---------- Nothing is kept in the browser ----------
   All data lives in the database (Supabase, through the server). Copies that older versions of the system kept
   in this browser (staff accounts, students, documents, settings, backup-file details) are deleted, so nothing
   of the college's data stays on this computer. */
function clearOldBrowserData() {
    try {
        ['fewaAccounts', 'fewaRoleOperations', 'fewaMovedToServer', 'fewaLastBackup', 'fewaDataChanged']
            .forEach(key => localStorage.removeItem(key));
    } catch { }
    try {
        if (window.indexedDB) ['fewaCollegeDB', 'fewaBackupFile'].forEach(name => indexedDB.deleteDatabase(name));
    } catch { }
}
if (fewaServer.online) clearOldBrowserData();

/* ---------- Opened as a file, or the server/database is not available ---------- */
function showServerProblem() {
    const asFile = location.protocol === 'file:';
    const online = !asFile && !['localhost', '127.0.0.1'].includes(location.hostname);
    // The server has just started and is still connecting to its database: straight to the login page, which waits
    if (!asFile && fewaServer.error === 'The database is not connected yet.') {
        if (!/(^\/|\/login\.html)$/.test(location.pathname)) return location.replace('login.html');
        const note = document.getElementById('loginSubtitle');
        note.innerText = 'The system is starting. You can log in in a moment.';
        note.style.display = 'block';
        document.getElementById('loginButton').disabled = true;
        return waitForDatabase();
    }
    const box = document.createElement('div');
    box.className = 'fewa-server-problem';
    box.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#f6f2fb;display:flex;align-items:center;' +
        'justify-content:center;padding:16px;font-family:inherit;color:#24103a;overflow:auto';
    box.innerHTML = `
        <div style="max-width:620px;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(36,16,58,.18);
                    border-top:5px solid #d4a843;line-height:1.55">
            <h2 style="margin:0 0 12px">${asFile ? 'Open the FEWA system through its server' : 'The FEWA system cannot reach its database'}</h2>
            <p style="margin:0 0 12px" class="problem-text"></p>
            <p style="margin:0 0 16px;${online ? '' : 'display:none'}">The online system is not available right now.
                Please try again in a few minutes, or tell the college office.</p>
            <ol style="margin:0 0 16px;padding-left:20px;${online ? 'display:none' : ''}">
                <li>Double-click <b>start-server.bat</b> in the FEWA SYSTEM folder and keep its window open.</li>
                <li>Open <a href="${FEWA_ADDRESS}" style="color:#5b2d8e;font-weight:bold">${FEWA_ADDRESS}</a></li>
            </ol>
        </div>`;
    box.querySelector('.problem-text').textContent = asFile
        ? 'The system now keeps all its data in the PostgreSQL database, so it must be opened at its web address, not as a file.'
        : fewaServer.error;
    document.body.appendChild(box);
    if (/could not connect to the database/.test(fewaServer.error)) waitForDatabase();
}

// Opens the page as soon as the database is connected
function waitForDatabase() {
    setTimeout(async () => {
        try {
            const response = await fetch(FEWA_API + '/session', { headers: { 'X-FEWA-Client': '1' }, cache: 'no-store' });
            if (response.ok) return location.reload();
        } catch { } // the server itself is restarting: keep waiting
        waitForDatabase();
    }, 3000);
}

if (!fewaServer.online) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showServerProblem);
    else showServerProblem();
}

// Staff pages: fetch all the Settings lists (and the students) once as the page opens, in the background, so tabs and
// dropdowns that need them show straight away instead of each asking the server in turn
if (fewaServer.online && fewaSession.kind === 'staff') {
    dataReady.then(() => {
        rememberedGet(storePath('settings')).catch(() => { });
        rememberedGet(storePath('students')).catch(() => { });
    });
}
