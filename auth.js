/* ---------- Login / Logout ----------
   User accounts (the administrator and staff) live in the PostgreSQL database, through db.js (loaded before this
   file): passwords are stored as salted SHA-256 hashes, never as plain text. The signed-in user lives in this
   tab's sessionStorage, which is cleared when the browser is closed. */
const AUTH_ACCOUNTS_KEY = 'fewaAccounts';
const AUTH_OLD_ACCOUNT_KEY = 'fewaAdminAccount';
const AUTH_SESSION_KEY = 'fewaSessionUser';

const ROLE_ADMIN = 'Administrator';
const ROLE_STAFF = 'Staff';

// Staff roles (job titles) offered until Settings > Access Management > Roles is changed
const DEFAULT_STAFF_ROLES = ['System Administrator', 'Registrar', 'Accountant', 'Tutor', 'Receptionist'];

function getAccounts() {
    try {
        const accounts = JSON.parse(serverValue(AUTH_ACCOUNTS_KEY));
        if (Array.isArray(accounts)) return accounts;
    } catch { }

    // Before staff accounts existed there was a single administrator account (in this browser); carry it over
    if (!fewaServer.online) return [];
    try {
        const old = JSON.parse(localStorage.getItem(AUTH_OLD_ACCOUNT_KEY));
        if (old) {
            const accounts = [{
                id: newAccountId(), firstName: 'Administrator', lastName: '', jobTitle: 'System Administrator',
                role: ROLE_ADMIN, status: 'Active', createdAt: new Date().toISOString(), ...old
            }];
            saveAccounts(accounts);
            localStorage.removeItem(AUTH_OLD_ACCOUNT_KEY);
            return accounts;
        }
    } catch { }
    return [];
}

function saveAccounts(accounts) {
    setServerValue(AUTH_ACCOUNTS_KEY, JSON.stringify(accounts));
    if (typeof scheduleBackup === 'function') scheduleBackup(); // backup.js
}

function newAccountId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const sameEmail = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

function findAccount(email) {
    return getAccounts().find(a => sameEmail(a.username, email)) || null;
}

// Active accounts are the only ones that can log in or be sent codes
function isRegisteredEmail(email) {
    const account = findAccount(email);
    return !!account && account.status !== 'Inactive';
}

async function hashPassword(password, salt) {
    const bytes = new TextEncoder().encode(salt + ':' + password);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
    return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// First visit: the person setting the system up becomes the first administrator
async function createAdminAccount(username, password, phone) {
    const salt = randomHex(16);
    saveAccounts([...getAccounts(), {
        id: newAccountId(), username, phone, firstName: 'Administrator', lastName: '',
        jobTitle: 'System Administrator', role: ROLE_ADMIN, status: 'Active',
        createdAt: new Date().toISOString(), salt, hash: await hashPassword(password, salt)
    }]);
    // Log in with it, so the server starts the session
    await serverLogin(username, password);
}

// The part of a username (email) a password must not contain, e.g. "jane" for jane@fewacollege.ac.ke
const usernamePart = username => (username || '').split('@')[0].trim().toLowerCase();

/* ---------- Role Operations (rights) ----------
   Set in Settings > Access Management > Role Operations: for each role (job title), what it may do in
   each part of the system. Administrators always have every right; a role that has never been set up
   keeps every right too, so nobody is locked out before their role is decided. Kept in the database
   with the accounts (read when the page opens, by db.js), so every page can check rights straight away. */
const ROLE_OPERATIONS_KEY = 'fewaRoleOperations';

// Every operation in the system that a role can be assigned, as "part.operation" keys.
// Listed A-Z by name on the Role Operations page.
const ROLE_OPERATIONS = [
    ['students.view', 'Access Student Hub', 'Ability to access the Student Hub and New Students screens.'],
    ['finance.view', 'Access Manage Finance', 'Ability to access the Manage Finance screens.'],
    ['reports.view', 'Access Reports', 'Ability to open, print and export reports.'],
    ['settings.view', 'Access Settings', 'Ability to access the Settings screens.'],
    ['students.add', 'Add Students', 'Ability to admit (add) new students.'],
    ['settings.add', 'Add Settings Items', 'Ability to add courses, campuses, terms, roles and other setup items.'],
    ['students.delete', 'Delete Students', 'Ability to delete students and their deferral/suspension records.'],
    ['settings.delete', 'Delete Settings Items', 'Ability to delete courses, campuses, terms, roles and other setup items.'],
    ['finance.edit', 'Edit Fee Payment Details', 'Ability to change the M-Pesa and bank details fees are paid to.'],
    ['settings.edit', 'Edit Settings', 'Ability to change setup items and the School Setup details.'],
    ['students.edit', 'Edit Students', 'Ability to change student details, status, contacts and deferrals.'],
    ['finance.add', 'Record Fee Payments', 'Ability to post student fee payments, up to the Auth Limit amount.'],
    ['documents.add', 'Upload Student Documents', 'Ability to upload documents for a student.'],
    ['documents.view', 'View Student Documents', 'Ability to open the Student Documents screen and view documents.']
].map(([key, name, remarks]) => ({ key, name, remarks })).sort((a, b) => a.name.localeCompare(b.name));

function getRoleOperations() {
    try {
        return JSON.parse(serverValue(ROLE_OPERATIONS_KEY)) || {};
    } catch {
        return {};
    }
}

function saveRoleOperations(operations) {
    setServerValue(ROLE_OPERATIONS_KEY, JSON.stringify(operations));
    if (typeof scheduleBackup === 'function') scheduleBackup(); // backup.js
}

// A role's saved rights: { assigned: ['students.view', ...], limits: { 'finance.add': 50000 } }
function roleRights(role) {
    const saved = getRoleOperations()[role];
    if (!saved) return null;
    if (Array.isArray(saved.assigned)) return saved;
    // Rights saved by the earlier tick-box grid were { students: ['view', 'edit'], ... }
    return { assigned: Object.entries(saved).flatMap(([part, ops]) => ops.map(op => `${part}.${op}`)), limits: {} };
}

// Whether the signed-in person may do this, e.g. can('students', 'delete')
function can(part, operation) {
    const account = currentAccount();
    if (!account) return false;
    if (account.role === ROLE_ADMIN) return true;
    const rights = roleRights(account.jobTitle);
    if (!rights) return true;
    return rights.assigned.includes(`${part}.${operation}`);
}

// For actions: true when allowed, otherwise explains and returns false
function allowed(part, operation) {
    if (can(part, operation)) return true;
    const key = `${part}.${operation}`;
    const name = (ROLE_OPERATIONS.find(o => o.key === key) || { name: key }).name;
    alert(`You do not have the right to: ${name}.\n\n` +
        'Ask an administrator to assign it to your role under Settings > Access Management > Role Operations.');
    return false;
}

// A new password must pass every rule (login page and ChangePassword.html).
// Each test gets the password and, when known, the username it belongs to.
const PASSWORD_MAX_LENGTH = 20;
const PASSWORD_RULES = [
    ['at least 8 characters', p => p.length >= 8],
    [`at most ${PASSWORD_MAX_LENGTH} characters`, p => p.length <= PASSWORD_MAX_LENGTH],
    ['a capital letter (A-Z)', p => /[A-Z]/.test(p)],
    ['a small letter (a-z)', p => /[a-z]/.test(p)],
    ['a number (0-9)', p => /[0-9]/.test(p)],
    ['a special character (e.g. ! @ # $ %)', p => /[^A-Za-z0-9\s]/.test(p)],
    ['not your username', (p, username) => usernamePart(username).length < 3 || !p.toLowerCase().includes(usernamePart(username))]
];

// Ticks each rule off as the password is typed
function renderPasswordRules(inputId, listId, username = '') {
    const password = document.getElementById(inputId).value;
    document.getElementById(listId).innerHTML = PASSWORD_RULES.map(([text, test]) => {
        const met = test(password, username);
        return `<li class="${met ? 'met' : ''}">${met ? '&#10003;' : '&#10007;'} ${text}</li>`;
    }).join('');
}

// Returns the rules a password still fails, as text
const missingPasswordRules = (password, username = '') =>
    PASSWORD_RULES.filter(([, test]) => !test(password, username)).map(([text]) => text);

// A random password that passes every rule, shown as an example, e.g. "lXD7cZ9@"
function samplePassword() {
    const pick = chars => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz', digits = '23456789', special = '@#$%!&*';
    const chars = [pick(upper), pick(upper), pick(lower), pick(lower), pick(lower), pick(digits), pick(digits), pick(special)];
    // Shuffle so the kinds of characters are mixed
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

// The logged-in staff member's own new password, set by the server. Returns 'ok', or 'same' when it is
// the current password.
async function setPassword(email, password) {
    const { result } = await api('POST', '/password', { password });
    return result;
}

// A deactivated or reactivated staff member whose password has been cancelled: only an
// administrator's reset link (Staff Management > Send Reset Link) lets them in again
const needsAdminReset = email => !!(findAccount(email) || {}).adminResetRequired;

// Adds a staff account (no password yet; they set one from the emailed link) or updates an existing one.
// Deactivating an account cancels its password and any reset code it was sent, so the old password
// never works again, even after the account is made active again.
function saveStaffAccount(staff) {
    const accounts = getAccounts();
    const existing = accounts.find(a => a.id === staff.id);
    if (existing) {
        const deactivated = staff.status === 'Inactive' && existing.status !== 'Inactive';
        if (deactivated) serverStorage.removeItem(codeKey(AUTH_RESET_KEY, existing.username));
        saveAccounts(accounts.map(a => a.id !== staff.id ? a
            : deactivated ? { ...a, ...staff, salt: null, hash: null, adminResetRequired: true }
            : { ...a, ...staff }));
    } else {
        saveAccounts([...accounts, { ...staff, id: newAccountId(), createdAt: new Date().toISOString(), salt: null, hash: null }]);
    }
}

function deleteStaffAccount(id) {
    saveAccounts(getAccounts().filter(a => a.id !== id));
}

// Kenyan mobile numbers (07.. / 01.. / +254..), stored as +254XXXXXXXXX; null when not valid
function normalizeKenyanPhone(value) {
    const digits = value.replace(/[\s-]/g, '');
    const match = digits.match(/^(?:\+?254|0)([17]\d{8})$/);
    return match ? '+254' + match[1] : null;
}

// Shows only the start and end of a phone number or email, e.g. +2547•••••678 and ad•••@fewacollege.ac.ke
function maskPhone(phone) {
    return phone ? phone.slice(0, 5) + '•'.repeat(phone.length - 8) + phone.slice(-3) : '';
}

function maskEmail(email) {
    const [name, domain] = email.split('@');
    return name.slice(0, 2) + '•••@' + domain;
}

/* Logging in: the server checks the username and password and, when right, starts a session (a cookie).
   Staff log in with their email, students with their AdmNo. Returns { result, kind, username, studentId, admNo }:
   result is 'ok', 'wrong', 'locked' (too many wrong tries), or for staff 'inactive', 'reset-required'
   (reactivated; an administrator must send a reset link), 'no-password'; for students 'wrong-case',
   'wrong-password', 'inactive', 'reset-required', 'no-password'. */
async function serverLogin(username, password) {
    return api('POST', '/session/login', { username, password });
}

// The page keeps a note of who logged in (the server's session is what counts)
function startSession(username) {
    sessionStorage.setItem(AUTH_SESSION_KEY, username);
}

// The logged-in staff member, as the server knows them (null for students and visitors)
function currentAccount() {
    if (fewaSession.kind !== 'staff') return null;
    return getAccounts().find(a => a.id === fewaSession.accountId) || null;
}

function currentUser() {
    const account = currentAccount();
    return account ? account.username : null;
}

const isAdmin = () => (currentAccount() || {}).role === ROLE_ADMIN;

function accountName(account) {
    return [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username;
}

function endServerSession() {
    try {
        apiSync('POST', '/session/logout', {});
    } catch { }
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(STUDENT_SESSION_KEY);
}

function logout() {
    endServerSession();
    location.replace('login.html');
}

// A system update logs everyone out; the login page says why
function logOutAfterUpdate() {
    endServerSession();
    location.replace('login.html?updated=1');
}

/* ---------- Emailed 6-digit codes (OTP login and password reset) ----------
   Only a code's hash is kept; it expires after a few minutes and is cancelled after CODE_MAX_ATTEMPTS wrong tries.
   Each code belongs to one account, so staff can't use each other's codes. */
const CODE_MAX_ATTEMPTS = 5;

const codeKey = (prefix, email) => prefix + ':' + email.trim().toLowerCase();

async function createCode(storage, key, validMinutes) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const salt = String(Date.now());
    storage.setItem(key, JSON.stringify({
        salt, hash: await hashPassword(code, salt),
        expires: Date.now() + validMinutes * 60 * 1000, attempts: 0
    }));
    return code;
}

// Returns 'ok', 'wrong', 'expired' or 'none' (no code requested, or too many wrong tries)
async function checkCode(storage, key, code) {
    let saved;
    try {
        saved = JSON.parse(storage.getItem(key));
    } catch {
        saved = null;
    }
    if (!saved) return 'none';
    if (Date.now() > saved.expires) {
        storage.removeItem(key);
        return 'expired';
    }
    if (saved.hash === await hashPassword(code.trim(), saved.salt)) {
        storage.removeItem(key);
        return 'ok';
    }
    saved.attempts++;
    if (saved.attempts >= CODE_MAX_ATTEMPTS) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(saved));
    return saved.attempts >= CODE_MAX_ATTEMPTS ? 'none' : 'wrong';
}

// OTP login: the code lives in this tab's sessionStorage
const AUTH_OTP_KEY = 'fewaPendingOtp';
const OTP_VALID_MINUTES = 5;

const createOtp = email => createCode(sessionStorage, codeKey(AUTH_OTP_KEY, email), OTP_VALID_MINUTES);
const verifyOtp = (email, code) => checkCode(sessionStorage, codeKey(AUTH_OTP_KEY, email), code);

/* ---------- Forgot password / new staff password ----------
   The reset code is made and checked by the server (only a hash of it is kept), so the link in the email
   works in a new tab or on another computer. Only an administrator's page can have a code made, since the
   page emails it: a person who forgot their password asks an administrator (Staff Management > Send Reset
   Link). A right code lets that person choose a new password within 10 minutes. */
const AUTH_RESET_KEY = 'fewaPendingReset';
const RESET_VALID_MINUTES = 15;
const NEW_STAFF_VALID_MINUTES = 24 * 60;

// Resetting is two steps: a right code (step 1) unlocks the new password form (step 2) for
// RESET_GRANT_MINUTES in this tab only. The code is used up as soon as it is accepted.
const AUTH_RESET_GRANT_KEY = 'fewaResetGranted';
const RESET_GRANT_MINUTES = 10;

// Returns the same results as checkCode
async function verifyResetCode(email, code) {
    const { result } = await api('POST', '/password-reset/verify', { email, code });
    if (result === 'ok') {
        sessionStorage.setItem(AUTH_RESET_GRANT_KEY, JSON.stringify({
            email: email.trim().toLowerCase(), expires: Date.now() + RESET_GRANT_MINUTES * 60 * 1000
        }));
    }
    return result;
}

function resetGrantedFor() {
    try {
        const grant = JSON.parse(sessionStorage.getItem(AUTH_RESET_GRANT_KEY));
        return grant && Date.now() <= grant.expires ? grant.email : null;
    } catch {
        return null;
    }
}

// Sets the new password only for the account whose code was accepted; false when that has run out
async function completePasswordReset(newPassword) {
    sessionStorage.removeItem(AUTH_RESET_GRANT_KEY);
    const { result } = await api('POST', '/password-reset', { password: newPassword });
    return result === 'ok';
}

// Emails a link and code for setting a password. New staff get a day to use it; a forgotten
// password reset lasts RESET_VALID_MINUTES. Returns 'sent', 'failed', 'not-configured', 'unknown'
// or 'admin-only' (only an administrator can send reset links; byAdmin is set from Staff Management).
async function sendPasswordLink(email, { newStaff = false, byAdmin = false } = {}) {
    if (!isEmailConfigured()) return 'not-configured';
    if (!isAdmin()) return 'admin-only';
    if (!isRegisteredEmail(email)) return 'unknown';

    const minutes = newStaff ? NEW_STAFF_VALID_MINUTES : RESET_VALID_MINUTES;
    const { code } = await api('POST', '/reset-code', { email, minutes });
    const link = new URL('login.html', location.href).href.split(/[?#]/)[0] +
        '?reset=' + code + '&user=' + encodeURIComponent(email.trim());
    const sent = await sendResetEmail(email.trim(), code, link, minutes, { newStaff, name: accountName(findAccount(email)) });
    return sent ? 'sent' : 'failed';
}

/* ---------- "⌂ Home › page name" at the top right of every page ----------
   Home goes to the Dashboard. The page name is the open section's name in the sidebar (or the page's title),
   and follows as the person moves between sections. Not shown on the Dashboard itself. */
document.addEventListener('DOMContentLoaded', () => {
    const content = document.getElementById('content-area');
    if (!content || /Dashboard\.html$/i.test(location.pathname)) return;

    const crumbs = document.createElement('div');
    crumbs.className = 'sp-crumbs page-crumbs no-print';
    crumbs.innerHTML = `
        <a class="sp-home" href="Dashboard.html">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/></svg>
            Home</a>
        <span class="sp-crumb-sep" aria-hidden="true">&rsaquo;</span>
        <span class="page-crumb-name"></span>`;
    content.insertBefore(crumbs, content.firstChild);

    const pageName = () => {
        const active = document.querySelector('#sidebar .submenu-item.active')
            || document.querySelector('#sidebar .menu-list > .nav-item.active .nav-label');
        return active ? active.textContent.trim() : document.title.split(' - ')[0];
    };
    const update = () => crumbs.querySelector('.page-crumb-name').textContent = pageName();
    update();
    // Moving between sections changes which sidebar item is active
    const sidebar = document.getElementById('sidebar');
    if (sidebar) new MutationObserver(update).observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['class'] });
});

/* ---------- Footer at the bottom of every page ----------
   Copyright (this year) WAFA Systems | Last Activity: when this person last did something here |
   the college name | Last System Update: when Settings > System Update last finished (asked again every 30 seconds) */
const FOOTER_CHECK_MS = 30000;
const formatFooterTime = date => date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
}).replace(',', '');

document.addEventListener('DOMContentLoaded', () => {
    const wrapper = document.getElementById('main-wrapper');
    if (!wrapper) return;
    const account = currentAccount();
    const activityKey = 'fewaLastActivity:' + (account ? account.username : '');

    const footer = document.createElement('footer');
    footer.className = 'system-footer no-print';
    footer.innerHTML = `
        <span><b>Copyright &copy; ${new Date().getFullYear()}</b> <span class="footer-brand">WAFA Systems</span></span>
        <span>Last Activity: <span id="footerActivity"></span></span>
        <span id="footerCollege"></span>
        <span>Last System Update: <span id="footerUpdate">...</span></span>`;
    wrapper.appendChild(footer);
    document.getElementById('footerCollege').textContent =
        (brandName || 'FEWA Beauty & Fashion College').toUpperCase();

    /* Last System Update, kept up to date while the page is open. When an update finishes, the server logs
       everyone out: this page notices within 30 seconds and goes to the login page. */
    const loggedIn = !!fewaSession.kind;
    let lastUpdate;
    const checkUpdate = async () => {
        try {
            const { finishedAt, kind } = await api('GET', '/system-update/last');
            const updated = lastUpdate !== undefined && finishedAt !== lastUpdate;
            lastUpdate = finishedAt;
            document.getElementById('footerUpdate').textContent = finishedAt ? formatFooterTime(new Date(finishedAt)) : 'Not run yet';
            if (loggedIn && !kind) {
                if (updated || finishedAt && Date.now() - new Date(finishedAt) < 5 * 60000) return logOutAfterUpdate();
                endServerSession();
                return location.replace('login.html');
            }
        } catch { } // the server is restarting or the internet is down: ask again next time
        setTimeout(checkUpdate, FOOTER_CHECK_MS);
    };
    if (fewaServer.online) checkUpdate();

    /* Last Activity: when this person last actually did something (a click, typing, a save), on any page or tab.
       Opening or refreshing a page does not count. */
    let lastActivity = null;
    try {
        const saved = localStorage.getItem(activityKey);
        if (saved) lastActivity = new Date(saved);
    } catch { }

    const showActivity = () => {
        document.getElementById('footerActivity').textContent = lastActivity ? formatFooterTime(lastActivity) : 'No activity yet';
    };

    // Shown straight away; saved for other pages and tabs at most once a second
    let lastSaved = 0;
    const recordActivity = () => {
        lastActivity = new Date();
        showActivity();
        if (lastActivity - lastSaved < 1000) return;
        lastSaved = lastActivity;
        try {
            localStorage.setItem(activityKey, lastActivity.toISOString());
        } catch { }
    };
    ['click', 'keydown', 'submit', 'change'].forEach(type => document.addEventListener(type, recordActivity, { passive: true }));

    // Activity in another tab of the system shows here too
    window.addEventListener('storage', event => {
        if (event.key === activityKey && event.newValue) {
            lastActivity = new Date(event.newValue);
            showActivity();
        }
    });

    showActivity();

    // The institution's name as saved in Settings > Organisation Setup > School Setup (in the database),
    // for the footer and the sidebar on every page
    if (fewaServer.online) {
        fewaDB.getOne('settings', 'organization')
            .then(org => { if (org && org.collegeName) setBrandName(org.collegeName); })
            .catch(() => { });
    }
});

/* ---------- Brand header at the top of the sidebar ----------
   The college logo on a round badge beside the name: the first word large in gold, the rest below it.
   Pages show the name saved in School Setup with setBrandName(). Clicking it goes to the Dashboard. */
let brandName = null;

function setBrandName(name) {
    brandName = name;
    const footerName = document.getElementById('footerCollege');
    if (footerName) footerName.textContent = name.toUpperCase();
    const label = document.querySelector('#sidebar .brand .brand-name');
    if (!label) return; // drawn when the page has loaded
    const [first, ...rest] = name.trim().split(/\s+/);
    label.innerHTML = `<b>${escapeProfileText(first)}</b><small>${escapeProfileText(rest.join(' '))}</small>`;
}

document.addEventListener('DOMContentLoaded', () => {
    const brand = document.querySelector('#sidebar .brand');
    if (!brand) return;
    const name = brandName || brand.textContent.trim() || 'FEWA Beauty & Fashion College';
    brand.innerHTML = `<span class="brand-logo"><img src="fewa-logo.jpg" alt=""></span><span class="brand-name"></span>`;
    setBrandName(name);
    brand.classList.add('brand-home');
    brand.title = 'Go to the Dashboard';
    brand.setAttribute('role', 'link');
    brand.tabIndex = 0;
    brand.addEventListener('click', () => location.href = 'Dashboard.html');
    brand.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            location.href = 'Dashboard.html';
        }
    });
});

/* ---------- Sidebar icons and the three-line menu button ----------
   Each main menu item gets an icon. The three-line button at the left of the top bar shrinks the sidebar
   to its icons only, and back; the choice is remembered on this computer. */
const SIDEBAR_KEY = 'fewaSidebarCollapsed';
const NAV_ICONS = {
    'Dashboard': '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.5"/>',
    'Students Management': '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/>',
    'Manage Finance': '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    'Reports': '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    'Staff Management': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.7 0 4.5 2 5 5"/>',
    'Settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>'
};

const navIconSvg = shape => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;

// Set before the page is drawn, so a shrunk sidebar doesn't flash open first
try {
    if (localStorage.getItem(SIDEBAR_KEY) === 'yes') document.documentElement.classList.add('sidebar-collapsed');
} catch { }

function setSidebarCollapsed(collapsed) {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? 'yes' : 'no');
    } catch { }
}

document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const search = document.querySelector('#topbar .search-box');
    if (!sidebar || !search) return;

    // An icon before each main menu name; the name goes in its own span so it can be hidden
    sidebar.querySelectorAll('.menu-list > .nav-item > a').forEach(link => {
        const oldIcon = link.querySelector('.icon-bar');
        if (oldIcon) oldIcon.remove();
        const name = link.textContent.trim();
        link.innerHTML = `<span class="nav-icon">${navIconSvg(NAV_ICONS[name] || NAV_ICONS['Dashboard'])}</span>
            <span class="nav-label">${name}</span>`;
        link.title = name;
        // With the sidebar shrunk, a menu with sub-items opens the sidebar so its list can show
        if (link.parentElement.classList.contains('has-submenu')) {
            link.addEventListener('click', () => {
                if (document.documentElement.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
                openMenuStraightAway(link.parentElement);
            });
        }
    });

    /* One tap on a main menu (e.g. Settings) goes straight there: its list opens, the other lists close (so it
       is not lost at the bottom of the menu), and its first section opens, unless one of its sections is
       already open. (The page's own onclick has just opened or closed the list.) */
    function openMenuStraightAway(item) {
        const list = item.querySelector('.submenu');
        if (!list || !list.classList.contains('open')) return;
        sidebar.querySelectorAll('.submenu.open').forEach(other => { if (other !== list) other.classList.remove('open'); });
        const subs = [...list.querySelectorAll('.submenu-item')].filter(sub => sub.style.display !== 'none');
        if (subs.length && !subs.some(sub => sub.classList.contains('active'))) subs[0].click();
    }

    // A quick double tap on a main menu would open its list and close it again at once: the second tap is ignored
    sidebar.addEventListener('click', event => {
        if (event.detail > 1 && event.target.closest('.menu-list > .nav-item.has-submenu > a')) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'btn-menu';
    menuButton.title = 'Show or hide the menu names';
    menuButton.setAttribute('aria-label', 'Show or hide the menu names');
    menuButton.innerHTML = navIconSvg('<path d="M3 6h18M3 12h18M3 18h18"/>');
    // On a phone the menu slides in over the page instead (styles.css, max-width 768px) and closes again
    // when a page or section is chosen, or when the dimmed page beside it is tapped
    const isPhone = () => window.matchMedia('(max-width: 768px)').matches;
    const setPhoneMenu = open => document.documentElement.classList.toggle('mobile-menu-open', open);
    if (isPhone()) document.documentElement.classList.remove('sidebar-collapsed'); // names always show on a phone
    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-menu-backdrop';
    backdrop.addEventListener('click', () => setPhoneMenu(false));
    document.body.appendChild(backdrop);
    sidebar.addEventListener('click', event => {
        if (!isPhone()) return;
        const link = event.target.closest('.submenu-item, .menu-list > .nav-item:not(.has-submenu) > a');
        if (link) setPhoneMenu(false);
    });
    menuButton.addEventListener('click', () => {
        if (isPhone()) return setPhoneMenu(!document.documentElement.classList.contains('mobile-menu-open'));
        setSidebarCollapsed(!document.documentElement.classList.contains('sidebar-collapsed'));
    });
    search.insertBefore(menuButton, search.firstChild);

    // Parts of the system this person may not view are taken out of the sidebar (Role Operations)
    const menuPart = { 'Manage Finance': 'finance', 'Reports': 'reports', 'Settings': 'settings' };
    const subItemPart = { 'Student Hub': 'students', 'Student Queries': 'students', 'Student Documents': 'documents' };
    sidebar.querySelectorAll('.menu-list > .nav-item').forEach(item => {
        const label = item.querySelector('.nav-label');
        const part = label && menuPart[label.textContent.trim()];
        if (part && !can(part, 'view')) item.style.display = 'none';
        item.querySelectorAll('.submenu-item').forEach(sub => {
            const subPart = subItemPart[sub.textContent.trim()];
            if (subPart && !can(subPart, 'view')) sub.style.display = 'none';
            // Backing up and restoring the whole system is for administrators only
            if (sub.textContent.trim() === 'System Data Backups' && !isAdmin()) sub.style.display = 'none';
            // ... and so is System Update (any item marked admin-only)
            if (sub.classList.contains('admin-only') && !isAdmin()) sub.style.display = 'none';
        });
        // A menu whose sub-items are all hidden goes too
        const subs = [...item.querySelectorAll('.submenu-item')];
        if (subs.length && subs.every(sub => sub.style.display === 'none')) item.style.display = 'none';
    });
});

// A refresh button (two arrows going round) beside the top bar search: takes you home to the Dashboard
// with fresh figures (the browser's own refresh reloads the page you are on)
document.addEventListener('DOMContentLoaded', () => {
    const search = document.querySelector('#topbar .search-box');
    if (!search) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-refresh';
    button.title = 'Refresh and go to the Dashboard';
    button.setAttribute('aria-label', 'Refresh and go to the Dashboard');
    // Two thick curved arrows with solid heads, chasing each other round
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 13a7 7 0 0 1 12.2-5.2" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M21 4v7h-7z" fill="currentColor"/>
        <path d="M19 11a7 7 0 0 1-12.2 5.2" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M3 20v-7h7z" fill="currentColor"/></svg>`;
    button.addEventListener('click', () => {
        button.classList.add('spinning');
        location.href = 'Dashboard.html';
    });
    search.appendChild(button);
});

/* ---------- Profile menu (top right of every page) ----------
   The name and picture open a panel with the signed-in person's details, Change Password and Sign out.
   It replaces the old Log Out button. */
const PROFILE_PICTURE = `<svg viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="41" cy="21" r="11" fill="#6b3b1f"/>
    <circle cx="41" cy="24" r="8" fill="#f2c08a"/>
    <path d="M27 60c0-11 6-18 14-18s14 7 14 18z" fill="#f39c3d"/>
    <circle cx="24" cy="26" r="10" fill="#f5c48f"/>
    <path d="M14 25c0-8 4.5-13 10-13s10 4.5 10 12c-3-3-6.5-4-10-4s-7 1-10 5z" fill="#7a4a26"/>
    <path d="M6 62c0-13 8-20 18-20s18 7 18 20z" fill="#8fc3e8"/>
</svg>`;

function escapeProfileText(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
    const area = document.querySelector('#topbar .topbar-user');
    if (!area) return;
    const info = area.querySelector('.user-info');
    const logoutButton = area.querySelector('.btn-logout');
    if (logoutButton) logoutButton.remove();

    // The name stays in its spans, so each page's showCurrentUser() still fills it in
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'profile-toggle';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = 'Your profile';
    toggle.innerHTML = `<span class="profile-picture small">${PROFILE_PICTURE}</span>`;
    toggle.appendChild(info);
    area.appendChild(toggle);

    const menu = document.createElement('div');
    menu.className = 'profile-menu';
    menu.hidden = true;
    area.appendChild(menu);

    const close = () => {
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', () => {
        if (!menu.hidden) return close();
        const account = currentAccount() || {};
        const since = account.createdAt
            ? new Date(account.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        menu.innerHTML = `
            <div class="profile-card">
                <span class="profile-picture large">${PROFILE_PICTURE}</span>
                <div class="profile-name">${escapeProfileText(account.username ? accountName(account) : 'Administrator')}
                    - ${escapeProfileText(account.role || ROLE_ADMIN)}${account.jobTitle ? ` (${escapeProfileText(account.jobTitle)})` : ''}</div>
                ${since ? `<div>Member since ${since}</div>` : ''}
                <div>${escapeProfileText(account.username)}</div>
            </div>
            <div class="profile-actions">
                <button type="button" class="profile-action" data-action="password">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                    Change Password</button>
                <button type="button" class="profile-action" data-action="signout">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/></svg>
                    Sign out</button>
            </div>`;
        menu.querySelector('[data-action="password"]').onclick = () => location.href = 'ChangePassword.html';
        menu.querySelector('[data-action="signout"]').onclick = () => {
            if (confirm('Sign out of the FEWA system?')) logout();
        };
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
    });

    // Clicking elsewhere or pressing Escape closes the panel
    document.addEventListener('click', event => {
        if (!area.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
    });
});

/* ---------- Eye icon in password boxes ----------
   Every password box (login, first-time setup, reset, Change Password) gets an eye at its right end:
   click it to show the password, click again to hide it. */
const EYE_ICONS = {
    show: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    hide: '<path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'
};

function addPasswordEye(input) {
    const wrap = document.createElement('span');
    wrap.className = 'password-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'password-eye';
    const draw = () => {
        const showing = input.type === 'text';
        eye.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EYE_ICONS[showing ? 'hide' : 'show']}</svg>`;
        eye.title = showing ? 'Hide password' : 'Show password';
        eye.setAttribute('aria-label', eye.title);
    };
    eye.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        draw();
        input.focus();
    });

    // The eye only shows once something has been typed; an emptied box hides it and the password again
    const showWhenTyped = () => {
        eye.hidden = !input.value;
        if (!input.value && input.type === 'text') {
            input.type = 'password';
            draw();
        }
    };
    input.addEventListener('input', showWhenTyped);
    if (input.form) input.form.addEventListener('reset', () => setTimeout(showWhenTyped));

    draw();
    showWhenTyped();
    wrap.appendChild(eye);

    // Passwords must match capital and small letters, so warn while Caps Lock is on
    const capsWarning = document.createElement('div');
    capsWarning.className = 'caps-warning';
    capsWarning.textContent = '⚠ Caps Lock is on';
    capsWarning.hidden = true;
    wrap.insertAdjacentElement('afterend', capsWarning);
    const checkCaps = event => {
        if (event.getModifierState) capsWarning.hidden = !event.getModifierState('CapsLock');
    };
    input.addEventListener('keydown', checkCaps);
    input.addEventListener('keyup', checkCaps);
    input.addEventListener('blur', () => capsWarning.hidden = true);
}

document.addEventListener('DOMContentLoaded', () =>
    document.querySelectorAll('input[type="password"]').forEach(addPasswordEye));

/* ---------- Student login ----------
   Students log in on the login page with their AdmNo and a password set by staff with
   "Reset Password" on the student's record. The password is kept as a salted hash on the student's record
   (in the database, with the other student details); mustChangePassword makes them choose
   their own at the next login. The server checks the password (serverLogin) and keeps the student's session;
   a student's session only ever gets their own record, documents and deferrals. */
const STUDENT_SESSION_KEY = 'fewaStudentSession';

// The student record to save when a student stops being active (deactivated, deferred or suspended):
// their password is cancelled, so after being made active again they can only log in once the
// office presses Reset Password. Records that were already inactive before are returned unchanged.
function deactivatedStudent(student, before = {}) {
    if (student.activeStudent !== 'no' || before.activeStudent === 'no') return student;
    return { ...student, loginHash: null, loginSalt: null, mustChangePassword: true, adminResetRequired: true };
}

// Sets a student's password (on the server); mustChange makes them choose their own at the next login.
// Returns 'ok', 'none' (no such student) or, when a student sets their own, 'same' (it is the current one).
async function setStudentPassword(studentId, password, mustChange) {
    const { result } = await api('POST', '/student-password', { studentId, password, mustChange });
    if (result === 'ok') announceDataChange('students');
    return result;
}

/* ---------- Changes reaching other open pages ----------
   When staff save student data, announceDataChange tells every other open page of the system (in other tabs or
   windows of this browser), so a student's open portal shows the change straight away. */
const DATA_CHANNEL = 'fewa-data-changes';
let dataChannel = null;
try {
    dataChannel = new BroadcastChannel(DATA_CHANNEL);
} catch { }

function announceDataChange(storeName) {
    const message = { store: storeName, at: Date.now() };
    try {
        if (dataChannel) dataChannel.postMessage(message);
        // Also through localStorage, for browsers without BroadcastChannel
        localStorage.setItem('fewaDataChanged', JSON.stringify(message));
    } catch { }
    if (typeof scheduleBackup === 'function') scheduleBackup(); // backup.js
}

// Runs onChange(storeName) whenever another page announces a change
function onDataChange(onChange) {
    if (dataChannel) dataChannel.addEventListener('message', event => onChange(event.data.store));
    window.addEventListener('storage', event => {
        if (event.key !== 'fewaDataChanged' || !event.newValue) return;
        try {
            onChange(JSON.parse(event.newValue).store);
        } catch { }
    });
}

// Whether anything in this part of the page was changed and not yet saved (typed text, ticks, choices)
function hasUnsavedChanges(container) {
    if (!container) return false;
    return [...container.querySelectorAll('input, textarea, select')].some(el => {
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
        if (el.type === 'file') return el.files && el.files.length > 0;
        if (el.tagName === 'SELECT') return [...el.options].some(o => o.selected !== o.defaultSelected);
        return el.value !== el.defaultValue;
    });
}

/* Staff pages call this with what to redraw when data changes in another tab or window (a student saving their
   portal password, another staff member's changes, staff accounts or role rights). It waits while someone is
   typing in a box and runs once they click away, so nothing being typed is lost. */
function whenDataChanges(refresh) {
    let timer = null;
    let pending = false;
    const typing = () => {
        const el = document.activeElement;
        return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
    };
    const run = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (typing()) return pending = true;
            pending = false;
            refresh();
        }, 300);
    };
    onDataChange(run);
    // Staff accounts and role rights changed on another page (db.js re-reads them, then fires this)
    window.addEventListener('fewa-value-change', event => {
        if ([AUTH_ACCOUNTS_KEY, ROLE_OPERATIONS_KEY].includes(event.detail.key)) run();
    });
    document.addEventListener('focusout', () => {
        if (pending) run();
    });
}

function startStudentSession(studentId) {
    sessionStorage.setItem(STUDENT_SESSION_KEY, studentId);
}

// The logged-in student, as the server knows them
const currentStudentId = () => fewaSession.kind === 'student' ? fewaSession.studentId : null;

function studentLogout() {
    endServerSession();
    location.replace('login.html');
}

// The Student Portal calls this first; anyone else goes to the login page
function requireStudentLogin() {
    if (!fewaServer.online) return; // db.js is showing how to start the server
    if (!currentStudentId()) location.replace('login.html');
}

// Pages that need a signed-in user call this first; anyone else (or a deactivated account) goes to the login page
function requireLogin() {
    if (!fewaServer.online) return; // db.js is showing how to start the server
    const account = currentAccount();
    if (!account || account.status === 'Inactive') {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        location.replace('login.html');
    }
}

// A staff member who is deactivated while logged in (from another tab or computer session) is
// logged out straight away
window.addEventListener('fewa-value-change', event => {
    if (event.detail.key !== AUTH_ACCOUNTS_KEY || !currentUser()) return;
    const account = currentAccount();
    if (!account || account.status === 'Inactive') {
        alert('Your account has been deactivated. You will be logged out.');
        logout();
    }
});
