/* ---------- Feedback messages ----------
   showToast('Student saved successfully.') shows a green banner at the top of the page that closes by itself;
   showToast(text, 'warning') shows an amber one that stays a little longer. Every page of the system uses it.
   The banner sits at the top of the page content (under "Home ›") and stays in view while the page is scrolled.
   It is also kept for a few seconds in sessionStorage, so when a save moves on to another page
   (e.g. back to NewStudents.html) the message still shows there. */
const TOAST_KEY = 'fewaPendingToast';
const TOAST_SECONDS = 4;
const TOAST_WARNING_SECONDS = 8;

function showToast(message, kind = 'success') {
    try {
        sessionStorage.setItem(TOAST_KEY, JSON.stringify({ message, kind, at: Date.now() }));
    } catch { }
    renderToast(message, kind);
}

let toastArea = null;

// Puts the banner area at the top of the page content (after "Home ›"), or at the top of the window
function placeToastArea() {
    const content = document.getElementById('content-area') || document.querySelector('.enquiry-main');
    toastArea.classList.toggle('toast-area-window', !content);
    if (!content) return document.body.appendChild(toastArea);
    const crumbs = content.querySelector(':scope > .page-crumbs, :scope > .sp-crumbs');
    content.insertBefore(toastArea, crumbs ? crumbs.nextSibling : content.firstChild);
}

function renderToast(message, kind) {
    if (!toastArea) {
        toastArea = document.createElement('div');
        toastArea.id = 'toastArea';
        toastArea.setAttribute('role', 'status');
        toastArea.setAttribute('aria-live', 'polite');
        // Pages that redraw themselves (e.g. the Student Portal) would remove the banner; put it back
        new MutationObserver(() => {
            if (!toastArea.isConnected && toastArea.children.length) placeToastArea();
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (!toastArea.isConnected) placeToastArea();

    const toast = document.createElement('div');
    toast.className = 'toast ' + kind;
    toast.innerHTML = `<span class="toast-icon">${kind === 'success' ? '&#10003;' : '!'}</span>
        <span class="toast-text"></span>
        <button type="button" class="toast-close" aria-label="Close message">&times;</button>`;
    toast.querySelector('.toast-text').textContent = message;
    toastArea.appendChild(toast);

    const close = () => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
        try {
            sessionStorage.removeItem(TOAST_KEY);
        } catch { }
    };
    toast.querySelector('.toast-close').onclick = close;
    setTimeout(close, (kind === 'success' ? TOAST_SECONDS : TOAST_WARNING_SECONDS) * 1000);
}

// A message saved just before moving to this page
document.addEventListener('DOMContentLoaded', () => {
    try {
        const pending = JSON.parse(sessionStorage.getItem(TOAST_KEY));
        sessionStorage.removeItem(TOAST_KEY);
        if (pending && Date.now() - pending.at < 10000) renderToast(pending.message, pending.kind);
    } catch { }
});

/* ---------- Empty lists show a short note, not an empty table ----------
   A table whose body holds only its "nothing yet" row (class empty-row) is hidden, with its heading row, and that
   row's message is shown in its place as a short note (e.g. "Nothing is listed here yet."). As soon as the table
   has a real row again, the table comes back and the note goes. Works for every list on every page, as they redraw. */
(function () {
    const style = document.createElement('style');
    style.textContent = '.list-empty-note { font-weight: 600; color: #333; font-size: 14px; margin: 14px 0 6px; }';
    document.head.append(style);

    function tidyEmptyLists() {
        for (const table of document.querySelectorAll('table')) {
            const body = table.tBodies[0];
            if (!body) continue;
            const rows = [...body.rows];
            const empty = rows.length > 0 && rows.every(r => r.classList.contains('empty-row'));
            const box = table.parentElement && table.parentElement.classList.contains('table-wrap') ? table.parentElement : table;
            let note = box.previousElementSibling && box.previousElementSibling.classList.contains('list-empty-note') ? box.previousElementSibling : null;
            if (empty) {
                const text = rows.map(r => r.innerText.trim()).filter(Boolean).join(' ') || 'Nothing is listed here yet.';
                if (!note) { note = document.createElement('p'); note.className = 'list-empty-note'; box.before(note); }
                if (note.textContent !== text) note.textContent = text;
                if (box.style.display !== 'none') box.style.display = 'none';
            } else {
                if (note) note.remove();
                if (box.style.display === 'none') box.style.display = '';
            }
        }
    }

    let queued = false;
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; tidyEmptyLists(); }); } };
    const start = () => {
        tidyEmptyLists();
        new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
