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
