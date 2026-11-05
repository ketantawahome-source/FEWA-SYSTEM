/* ---------- Shared helpers for pages that read the student data (Dashboard.html, NewStudents.html) ----------
   Students, deferrals and settings are kept in the PostgreSQL database, through db.js. */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fullName(s) {
    return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
}

function formatDate(value) {
    const date = new Date(value);
    return isNaN(date) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Reads every record in one store of the database (db.js); [] when there is none or it cannot be read
function readAll(storeName) {
    if (!fewaServer.online) return Promise.resolve([]);
    return fewaDB.getAll(storeName).catch(err => {
        console.error(err);
        return [];
    });
}

// Uses the terms set up in Settings > Organisation Setup > Academic Terms. Without one that covers
// today, the college year is taken as three terms: Jan-Apr, May-Aug and Sep-Dec.
function currentTerm(today, terms = []) {
    const setUp = terms.map(t => {
        const end = new Date(t.endDate + 'T00:00');
        end.setDate(end.getDate() + 1);
        return { name: t.name, start: new Date(t.startDate + 'T00:00'), end };
    }).find(t => today >= t.start && today < t.end);
    if (setUp) return setUp;

    const index = Math.floor(today.getMonth() / 4);
    return {
        name: `Term ${index + 1}, ${today.getFullYear()}`,
        start: new Date(today.getFullYear(), index * 4, 1),
        end: new Date(today.getFullYear(), index * 4 + 4, 1)
    };
}

// The current term, with inTerm(date) telling whether a date falls in it
function termFromSettings(settings, today = new Date()) {
    const terms = settings.find(s => s.key === 'terms');
    const term = currentTerm(today, terms ? terms.items : []);
    term.inTerm = value => !!value && new Date(value) >= term.start && new Date(value) < term.end;
    return term;
}

// Shows the college name from Settings at the top of the sidebar
function applyCollegeName(settings) {
    const org = settings.find(s => s.key === 'organization');
    if (org && org.collegeName) setBrandName(org.collegeName);
}
