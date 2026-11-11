/* ---------- Top bar student search: results while typing ----------
   On every staff page with "Search for a student..." in the top bar. As soon as something is typed, a list of the
   matching students opens under the box (every word typed must be in their names, AdmNo, phone or email, in any
   order). Click a student, or pick one with the arrow keys and press Enter, to open them in Student Queries. Enter
   with nobody picked searches as before. Escape or a click elsewhere closes the list. */
(function () {
    const MAX_SHOWN = 8;
    /* Only the students in the system's database (students.students): read afresh every time the box is clicked
       into, so a student added a moment ago (on any computer) can be found at once, and a deleted one is gone. Online
       applicants not yet admitted, and staff, are never listed. */
    let students = null;
    let loading = null;
    let shown = [];
    let picked = -1;

    const nameOf = s => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
    const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // fresh: read the database again (on clicking into the box); otherwise the list read then is used while typing
    function loadStudents(fresh = false) {
        if (students && !fresh && !loading) return Promise.resolve(students);
        loading ||= fewaDB.getAll('students')
            .then(list => (students = list.map(s => ({
                id: s.id, admNo: s.admNo || '', name: nameOf(s), course: s.admissionCourse || '', inactive: s.activeStudent === 'no',
                text: [nameOf(s), s.admNo, s.phone, s.email, s.prospectNo].filter(Boolean).join(' ').toLowerCase()
            })).sort((a, b) => a.name.localeCompare(b.name))))
            .catch(() => (students || []))
            .finally(() => { loading = null; });
        return loading;
    }

    // Opens the student: straight away on the Student Hub page, otherwise there (by AdmNo)
    function openStudent(student) {
        const key = student.admNo || student.name;
        if (typeof searchFromTopbar === 'function' && /StudentAdmissions\.html$/i.test(location.pathname)) {
            searchFromTopbar(key);
        } else {
            location.href = 'StudentAdmissions.html?search=' + encodeURIComponent(key);
        }
    }

    function attach(input) {
        const box = input.closest('.search-box');
        const list = document.createElement('div');
        list.className = 'search-results';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        box.appendChild(list);
        input.setAttribute('autocomplete', 'off');
        input.removeAttribute('list');

        const close = () => { list.hidden = true; picked = -1; };

        function render() {
            list.innerHTML = shown.length
                ? shown.map((s, i) => `
                    <button type="button" class="search-result${i === picked ? ' picked' : ''}" data-index="${i}" role="option">
                        <span class="search-result-name">${escape(s.name)}${s.inactive ? ' <span class="search-result-inactive">Inactive</span>' : ''}</span>
                        <span class="search-result-sub">${escape([s.admNo, s.course].filter(Boolean).join(' · '))}</span>
                    </button>`).join('')
                : '<div class="search-result-none">No student matches.</div>';
            list.hidden = false;
        }

        async function update() {
            const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.length) return close();
            const all = await loadStudents();
            const typed = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (typed.join(' ') !== words.join(' ')) return; // the box changed while loading
            shown = all.filter(s => words.every(word => s.text.includes(word))).slice(0, MAX_SHOWN);
            picked = shown.length ? 0 : -1;
            render();
        }

        input.addEventListener('input', update);
        input.addEventListener('focus', () => { loadStudents(true).then(() => { if (input.value.trim()) update(); }); });
        input.addEventListener('blur', () => setTimeout(close, 150));
        // Arrow keys move through the list; Enter opens the picked student (the page's own Enter search is skipped)
        input.addEventListener('keydown', event => {
            if (list.hidden) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!shown.length) return;
                picked = (picked + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
                render();
            } else if (event.key === 'Escape') {
                close();
            } else if (event.key === 'Enter' && picked >= 0 && shown[picked]) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const student = shown[picked];
                close();
                openStudent(student);
            }
        }, true);
        list.addEventListener('mousedown', event => event.preventDefault()); // keep the box focused
        list.addEventListener('click', event => {
            const item = event.target.closest('.search-result');
            if (!item) return;
            const student = shown[Number(item.dataset.index)];
            close();
            if (student) openStudent(student);
        });
        document.addEventListener('click', event => { if (!box.contains(event.target)) close(); });
    }

    function start() {
        const input = document.querySelector('#topbar .search-box input');
        if (input && /student/i.test(input.placeholder || '')) attach(input);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
