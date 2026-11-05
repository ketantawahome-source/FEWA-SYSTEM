/* ---------- Icon buttons used across the system ----------
   Edit is a pencil and Delete a bin. Each keeps its name as a tooltip and for screen readers. */
const ICON_SHAPES_24 = {
    edit: '<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    delete: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6"/>'
};

function iconSvg(kind) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${ICON_SHAPES_24[kind]}</svg>`;
}

// A small square button with an icon, e.g. iconButton('edit', 'Edit Jane', "editStaff('42')")
function iconButton(kind, label, onclick) {
    return `<button type="button" class="btn-icon${kind === 'delete' ? ' danger' : ''}" title="${label}"
        aria-label="${label}" onclick="${onclick}">${iconSvg(kind)}</button>`;
}

// The same look as a link to another page
function iconLink(kind, label, href) {
    return `<a class="btn-icon${kind === 'delete' ? ' danger' : ''}" title="${label}" aria-label="${label}"
        href="${href}">${iconSvg(kind)}</a>`;
}
