/* ---------- Manage Finance > Payments (the staff screens) ----------
   Drawn into <div id="financeApp"> of StudentAdmissions.html; financeOpen() is called each time the Payments link is
   pressed. Every number comes from the server (finance.mjs): this file only shows it and asks for changes. The server
   checks the rights again, so hiding a button here is a convenience, never the protection.
   Uses: api() from db.js, showToast() from notify.js, can() from auth.js. */
(function () {
    const TABS = [['overview', 'Overview'], ['pay', 'Record Payment'], ['payments', 'Payments'],
        ['statement', 'Student Statement'], ['fees', 'Fee Structure'], ['balances', 'Balances']];
    const METHODS = [['MPESA', 'M-Pesa'], ['BANK', 'Bank Deposit / EFT'], ['CASH', 'Cash'], ['CHEQUE', 'Cheque']];
    const METHOD_NAME = Object.fromEntries(METHODS);

    const state = { tab: 'overview', terms: [], courses: [], org: null, paymentDetails: null, student: null, statement: null,
        term: '', register: [], balances: [], preview: null, ready: false, token: 0 };

    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const kes = n => 'KES ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
    const date = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
    const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
    const call = (method, path, body) => api(method, '/finance' + path, body);
    const fail = err => showToast((err && err.message) || 'Something went wrong. Try again.', 'warning');
    const app = () => document.getElementById('financeApp');
    const mayAdd = () => can('finance', 'add');
    const mayEdit = () => can('finance', 'edit');
    const mayVoid = () => can('finance', 'void');

    /* ---------- Settings lists (terms, courses, the college's details), read once per opening ---------- */
    async function loadSettings() {
        const read = key => api('GET', '/stores/settings/' + key).catch(() => null);
        const [terms, courses, org, details] = await Promise.all([read('terms'), read('courses'), read('organization'), read('paymentDetails')]);
        state.terms = ((terms && terms.items) || []).map(t => t.name).filter(Boolean);
        state.courses = ((courses && courses.items) || []).filter(c => c.enabled !== 'NO' && c.name)
            .map(c => c.labelSuffix ? `${c.name} (${c.labelSuffix})` : c.name);
        state.org = org || {};
        state.paymentDetails = details || {};
        // The term running today, else the first one
        const now = today();
        const running = ((terms && terms.items) || []).find(t => t.startDate <= now && now <= t.endDate);
        if (!state.term || !state.terms.includes(state.term)) state.term = (running && running.name) || state.terms[0] || '';
    }

    const termOptions = (selected, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
        state.terms.map(t => `<option${t === selected ? ' selected' : ''}>${esc(t)}</option>`).join('');
    const courseOptions = (selected, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
        state.courses.map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');

    /* ---------- The frame: tabs ---------- */
    function frame() {
        app().innerHTML = `<div class="fin-tabs" role="tablist">${TABS.map(([key, name]) =>
            `<button type="button" role="tab" class="fin-tab${key === state.tab ? ' active' : ''}" data-act="tab" data-tab="${key}">${name}</button>`).join('')}</div>
            <div id="finBody"></div>`;
    }

    async function show(tab) {
        state.tab = tab || state.tab;
        const mine = ++state.token; // a slow answer for a tab already left is dropped
        frame();
        const body = document.getElementById('finBody');
        body.innerHTML = '<p class="fin-note">Loading...</p>';
        try {
            const html = await ({ overview, pay, payments, statement, fees, balances }[state.tab])();
            if (mine !== state.token) return;
            body.innerHTML = html.html;
            if (html.after) html.after();
        } catch (err) {
            if (mine === state.token) body.innerHTML = `<p class="fin-note fin-bad">${esc(err.message)}</p>`;
        }
    }

    window.financeOpen = async function () {
        if (!app()) return;
        if (!app().dataset.ready) { app().dataset.ready = '1'; wire(); }
        try { await loadSettings(); } catch (err) { fail(err); }
        show(state.tab);
    };

    /* ---------- Overview ---------- */
    async function overview() {
        const [s, recent] = await Promise.all([call('GET', '/summary'), call('GET', '/payments?from=' + today().slice(0, 8) + '01')]);
        const tile = (cls, value, label) => `<div class="fin-tile ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
        return {
            html: `<div class="fin-tiles">
                ${tile('green', kes(s.today), `Collected today (${s.receiptsToday} receipt${s.receiptsToday === 1 ? '' : 's'})`)}
                ${tile('blue', kes(s.month), 'Collected this month')}
                ${tile('purple', kes(s.collected), 'Collected in total')}
                ${tile('orange', kes(s.charged), 'Charged to students')}
                ${tile('red', kes(s.outstanding), `Outstanding (${s.owing} student${s.owing === 1 ? '' : 's'} owing)`)}
            </div>
            ${mayAdd() ? '<div class="fin-actions"><button type="button" class="btn-submit" data-act="tab" data-tab="pay">Record a Payment</button></div>' : ''}
            <div class="section-title">PAYMENTS THIS MONTH</div>
            ${registerTable(recent.slice(0, 15), false)}
            ${recent.length > 15 ? '<p class="fin-note">Showing the 15 newest. Open <b>Payments</b> for all of them.</p>' : ''}`
        };
    }

    /* ---------- Finding a student: type an AdmNo or name ---------- */
    function finder(inputId, onPick) {
        const input = document.getElementById(inputId);
        const list = document.getElementById(inputId + 'List');
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 2) { list.innerHTML = ''; return; }
            timer = setTimeout(async () => {
                try {
                    const found = await call('GET', '/find?q=' + encodeURIComponent(q));
                    if (input.value.trim() !== q) return;
                    list.innerHTML = found.length ? found.map(s => `<button type="button" class="fin-found-item" data-id="${esc(s.id)}">
                            <b>${esc(s.admNo)}</b> ${esc(s.name)} <small>${esc(s.course || '')}${s.activeStudent === 'no' ? ' - inactive' : ''}</small></button>`).join('')
                        : '<div class="fin-note">No student found.</div>';
                } catch (err) { fail(err); }
            }, 250);
        });
        list.addEventListener('click', event => {
            const item = event.target.closest('[data-id]');
            if (!item) return;
            list.innerHTML = '';
            input.value = item.textContent.trim().replace(/\s+/g, ' ');
            onPick(item.dataset.id);
        });
    }

    async function loadStudent(id) {
        state.statement = await call('GET', '/student/' + encodeURIComponent(id));
        state.student = state.statement.student;
        return state.statement;
    }

    const balanceText = balance => balance > 0 ? `<b class="fin-bad">owes ${kes(balance)}</b>`
        : balance < 0 ? `<b class="fin-good">paid ${kes(-balance)} in advance</b>` : '<b class="fin-good">fully paid</b>';

    /* ---------- Record Payment ---------- */
    async function pay() {
        if (!mayAdd()) return { html: '<p class="fin-note">You do not have the right to record fee payments. Ask an administrator to give your role <b>Record Fee Payments</b>.</p>' };
        const details = state.paymentDetails || {};
        return {
            html: `<div class="section-title">RECORD NEW STUDENT PAYMENT</div>
            <div class="fin-find">
                <label for="finPayFind">Student (AdmNo or name)</label>
                <input id="finPayFind" type="search" autocomplete="off" placeholder="Start typing, e.g. HD01/001 or Amina">
                <div id="finPayFindList" class="fin-found"></div>
            </div>
            <div id="finPicked" class="fin-picked">${state.student ? pickedCard() : '<p class="fin-note">Choose the student the money is for.</p>'}</div>
            <form id="finPayForm" data-form="pay" class="fin-form">
                <div class="grid-3">
                    <div class="form-group"><label>Payment Amount (KES) *</label><input name="amount" type="number" min="1" step="0.01" required inputmode="decimal"></div>
                    <div class="form-group"><label>Payment Method *</label><select name="method">${METHODS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
                    <div class="form-group"><label>Transaction Code / Ref No. <span id="finRefNeed">*</span></label><input name="reference" maxlength="60" placeholder="e.g. QX7892KL" autocomplete="off"></div>
                    <div class="form-group"><label>Payment Date *</label><input name="paidOn" type="date" value="${today()}" max="${today()}" required></div>
                    <div class="form-group"><label>Term</label><select name="term">${termOptions(state.term, '- none -')}</select></div>
                    <div class="form-group"><label>Note</label><input name="note" maxlength="300" placeholder="Optional"></div>
                </div>
                <div class="action-bar"><button type="submit" class="btn-submit" id="finPaySave">Post Payment</button></div>
            </form>
            ${(details.mpesaPaybill || details.bankAccountNo) ? `<p class="fin-note">Fees are paid to ${details.mpesaPaybill ? `M-Pesa Paybill <b>${esc(details.mpesaPaybill)}</b>` : ''}${details.mpesaPaybill && details.bankAccountNo ? ' or ' : ''}${details.bankAccountNo ? `${esc(details.bankName || 'bank')} account <b>${esc(details.bankAccountNo)}</b>` : ''}.</p>` : ''}`,
            after() {
                finder('finPayFind', async id => {
                    try { await loadStudent(id); document.getElementById('finPicked').innerHTML = pickedCard(); } catch (err) { fail(err); }
                });
                const form = document.getElementById('finPayForm');
                const needRef = () => document.getElementById('finRefNeed').style.visibility = form.method.value === 'CASH' ? 'hidden' : 'visible';
                form.method.addEventListener('change', needRef);
                needRef();
            }
        };
    }

    function pickedCard() {
        const st = state.statement;
        return `<div class="fin-card"><div><b>${esc(st.student.admNo)}</b> - ${esc(st.student.name)}<br><small>${esc(st.student.course || '')}</small></div>
            <div>Charged ${kes(st.charged)} &middot; Paid ${kes(st.paid)}<br>${balanceText(st.balance)}</div>
            <button type="button" class="btn-secondary btn-small" data-act="open-statement" data-id="${esc(st.student.id)}">Statement</button></div>`;
    }

    async function submitPayment(form) {
        if (!state.student) return showToast('Choose the student first.', 'warning');
        const button = document.getElementById('finPaySave');
        const data = Object.fromEntries(new FormData(form));
        if (data.method !== 'CASH' && !String(data.reference).trim()) return showToast('Enter the transaction code / reference number.', 'warning');
        const sure = `Record ${kes(data.amount)} ${METHOD_NAME[data.method]} from ${state.student.name} (${state.student.admNo})?\n\nA receipt number is given and the payment cannot be deleted, only reversed.`;
        if (!confirm(sure)) return;
        button.disabled = true;
        try {
            const payment = await call('POST', '/payment', { ...data, studentId: state.student.id });
            showToast(`Payment recorded. Receipt ${payment.receiptNo}.`);
            form.reset();
            form.paidOn.value = today();
            await loadStudent(state.student.id);
            document.getElementById('finPicked').innerHTML = pickedCard();
            showReceipt(payment);
        } catch (err) { fail(err); }
        button.disabled = false;
    }

    /* ---------- Payments register ---------- */
    function registerTable(rows, actions = true) {
        if (!rows.length) return '<p class="fin-note">No payments found.</p>';
        return `<div class="table-wrap"><table class="data-table fin-table">
            <thead><tr><th>Receipt</th><th>Date</th><th>AdmNo</th><th>Student</th><th>Method</th><th>Reference</th><th class="fin-num">Amount</th><th>By</th>${actions ? '<th></th>' : ''}</tr></thead>
            <tbody>${rows.map(p => `<tr class="${p.voided ? 'fin-void' : ''}"><td>${esc(p.receiptNo)}</td><td>${esc(date(p.paidOn))}</td><td>${esc(p.admNo)}</td>
                <td>${esc(p.studentName)}</td><td>${esc(METHOD_NAME[p.method] || p.method)}</td><td>${esc(p.reference)}</td><td class="fin-num">${kes(p.amount)}</td>
                <td>${esc(p.createdBy)}</td>
                ${actions ? `<td class="fin-row-actions"><button type="button" class="btn-small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button>
                    ${!p.voided && mayVoid() ? `<button type="button" class="btn-small btn-delete" data-act="void-payment" data-id="${esc(p.id)}">Reverse</button>` : ''}
                    ${p.voided ? `<small title="${esc(p.voidReason)}">Reversed</small>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    }

    async function payments() {
        return {
            html: `<div class="section-title">PAYMENTS REGISTER</div>
            <form id="finFilter" data-form="payments" class="fin-filter">
                <div class="form-group"><label>From</label><input type="date" name="from" value="${today().slice(0, 8)}01"></div>
                <div class="form-group"><label>To</label><input type="date" name="to" value="${today()}"></div>
                <div class="form-group"><label>Method</label><select name="method"><option value="">All</option>${METHODS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
                <div class="form-group"><label>Search</label><input name="q" placeholder="Name, AdmNo, receipt, reference"></div>
                <label class="fin-check"><input type="checkbox" name="voided" value="yes"> Include reversed</label>
                <button type="submit" class="btn-submit">Show</button>
                <button type="button" class="btn-secondary" data-act="export-payments">Export to Excel (CSV)</button>
            </form>
            <div id="finRegister"></div>`,
            after: () => runRegister()
        };
    }

    async function runRegister() {
        const form = document.getElementById('finFilter');
        const params = new URLSearchParams(Object.fromEntries([...new FormData(form)].filter(([, v]) => v)));
        const holder = document.getElementById('finRegister');
        holder.innerHTML = '<p class="fin-note">Loading...</p>';
        try {
            state.register = await call('GET', '/payments?' + params);
            const live = state.register.filter(p => !p.voided);
            const byMethod = METHODS.map(([v, n]) => [n, live.filter(p => p.method === v).reduce((s, p) => s + p.amount, 0)]).filter(([, total]) => total);
            holder.innerHTML = `<div class="fin-totals"><b>${live.length} payment${live.length === 1 ? '' : 's'}: ${kes(live.reduce((s, p) => s + p.amount, 0))}</b>
                ${byMethod.map(([n, total]) => `<span>${esc(n)} ${kes(total)}</span>`).join('')}</div>
                ${state.register.length >= 1000 ? '<p class="fin-note fin-bad">Only the newest 1,000 are shown. Narrow the dates.</p>' : ''}
                ${registerTable(state.register)}`;
        } catch (err) { holder.innerHTML = `<p class="fin-note fin-bad">${esc(err.message)}</p>`; }
    }

    /* ---------- Student statement ---------- */
    async function statement() {
        return {
            html: `<div class="section-title">STUDENT STATEMENT</div>
            <div class="fin-find"><label for="finStFind">Student (AdmNo or name)</label>
                <input id="finStFind" type="search" autocomplete="off" placeholder="Start typing, e.g. HD01/001 or Amina">
                <div id="finStFindList" class="fin-found"></div></div>
            <div id="finStatement">${state.statement ? statementHtml() : '<p class="fin-note">Choose a student to see what they were charged and have paid.</p>'}</div>`,
            after() {
                finder('finStFind', async id => {
                    try { await loadStudent(id); document.getElementById('finStatement').innerHTML = statementHtml(); } catch (err) { fail(err); }
                });
            }
        };
    }

    function statementHtml() {
        const st = state.statement;
        const charges = st.charges.length ? `<div class="table-wrap"><table class="data-table fin-table"><thead><tr><th>Date</th><th>Term</th><th>Description</th><th class="fin-num">Amount</th><th></th></tr></thead>
            <tbody>${st.charges.map(c => `<tr class="${c.voided ? 'fin-void' : ''}"><td>${esc(date(c.createdAt))}</td><td>${esc(c.term)}</td><td>${esc(c.description)}${c.amount < 0 ? ' <small>(waiver)</small>' : ''}</td>
                <td class="fin-num">${kes(c.amount)}</td><td class="fin-row-actions">${c.voided ? `<small title="${esc(c.voidReason)}">Reversed</small>` :
                    (mayVoid() ? `<button type="button" class="btn-small btn-delete" data-act="void-charge" data-id="${esc(c.id)}">Reverse</button>` : '')}</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="fin-note">No charges yet.</p>';
        const rows = st.payments.length ? `<div class="table-wrap"><table class="data-table fin-table"><thead><tr><th>Receipt</th><th>Date</th><th>Method</th><th>Reference</th><th class="fin-num">Amount</th><th></th></tr></thead>
            <tbody>${st.payments.map(p => `<tr class="${p.voided ? 'fin-void' : ''}"><td>${esc(p.receiptNo)}</td><td>${esc(date(p.paidOn))}</td><td>${esc(METHOD_NAME[p.method] || p.method)}</td><td>${esc(p.reference)}</td>
                <td class="fin-num">${kes(p.amount)}</td><td class="fin-row-actions"><button type="button" class="btn-small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button>
                ${p.voided ? `<small title="${esc(p.voidReason)}">Reversed</small>` : (mayVoid() ? `<button type="button" class="btn-small btn-delete" data-act="void-payment" data-id="${esc(p.id)}">Reverse</button>` : '')}</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="fin-note">No payments yet.</p>';
        return `${pickedCard()}
            <div class="fin-actions"><button type="button" class="btn-secondary" data-act="print-statement">Print Statement</button>
                ${mayAdd() ? '<button type="button" class="btn-secondary" data-act="tab" data-tab="pay">Record Payment</button>' : ''}</div>
            <div class="report-subtitle">Charges</div>${charges}
            <div class="report-subtitle">Payments</div>${rows}
            ${mayAdd() ? `<div class="report-subtitle">Add a Charge${mayEdit() ? ' or Waiver' : ''}</div>
            <form data-form="charge" class="fin-form"><div class="grid-3">
                <div class="form-group"><label>Description *</label><input name="description" required maxlength="200" placeholder="e.g. Uniform, Exam fee"></div>
                <div class="form-group"><label>Term</label><select name="term">${termOptions(state.term, '- none -')}</select></div>
                <div class="form-group"><label>Amount (KES) *</label><input name="amount" type="number" min="0.01" step="0.01" required></div>
                ${mayEdit() ? `<div class="form-group"><label>Type</label><select name="kind"><option value="charge">Charge (student owes more)</option><option value="waiver">Waiver / bursary (student owes less)</option></select></div>` : ''}
            </div><div class="action-bar"><button type="submit" class="btn-submit">Add</button></div></form>` : ''}`;
    }

    async function submitCharge(form) {
        const data = Object.fromEntries(new FormData(form));
        const amount = Number(data.amount) * (data.kind === 'waiver' ? -1 : 1);
        try {
            await call('POST', '/charge', { studentId: state.student.id, description: data.description, term: data.term, amount });
            showToast(amount < 0 ? 'Waiver added.' : 'Charge added.');
            await loadStudent(state.student.id);
            document.getElementById('finStatement').innerHTML = statementHtml();
        } catch (err) { fail(err); }
    }

    /* ---------- Fee structure ---------- */
    async function fees() {
        const items = await call('GET', '/fee-structure');
        state.preview = null;
        // Terms that have fee items but are no longer (or not yet) in Settings still show, so nothing is hidden
        items.forEach(f => { if (!state.terms.includes(f.term)) state.terms.push(f.term); });
        if (!state.term) state.term = state.terms[0] || '';
        const shown = items.filter(f => f.term === state.term);
        const byCourse = new Map();
        shown.forEach(f => byCourse.set(f.course, [...(byCourse.get(f.course) || []), f]));
        const others = [...new Set(items.map(f => f.term))].filter(t => t !== state.term);
        return {
            html: `<div class="section-title">FEE STRUCTURE</div>
            ${!state.terms.length ? '<p class="fin-note fin-bad">No Academic Terms are set up yet. Add them under Settings > Organisation Setup > Academic Terms first, then come back here.</p>'
                : `<div class="fin-filter"><div class="form-group"><label>Term</label><select id="finTerm" data-act="pick-term">${termOptions(state.term)}</select></div></div>`}
            ${byCourse.size ? [...byCourse].map(([course, list]) => `<div class="report-subtitle">${esc(course)} - ${kes(list.reduce((s, f) => s + f.amount, 0))} per student</div>
                <div class="table-wrap"><table class="data-table fin-table"><thead><tr><th>Fee item</th><th class="fin-num">Amount</th><th></th></tr></thead><tbody>
                ${list.map(f => `<tr><td>${esc(f.item)}</td><td class="fin-num">${kes(f.amount)}</td><td class="fin-row-actions">${mayEdit() ?
                    `<button type="button" class="btn-small" data-act="edit-fee" data-id="${esc(f.id)}" data-item="${esc(f.item)}" data-amount="${f.amount}">Edit</button>
                     <button type="button" class="btn-small btn-delete" data-act="delete-fee" data-id="${esc(f.id)}" data-item="${esc(f.item)}">Remove</button>` : ''}</td></tr>`).join('')}
                </tbody></table></div>`).join('') : `<p class="fin-note">No fee items for ${esc(state.term || 'this term')} yet.</p>`}
            ${mayEdit() && state.term ? `<div class="report-subtitle">Add a Fee Item to ${esc(state.term)}</div>
            <form data-form="fee" class="fin-form"><div class="grid-3">
                <div class="form-group"><label>Course *</label><select name="course" required>${courseOptions('', '- choose -')}</select></div>
                <div class="form-group"><label>Fee item *</label><input name="item" required maxlength="100" list="finItems" placeholder="e.g. Tuition"><datalist id="finItems"><option>Tuition</option><option>Registration</option><option>Exam Fee</option><option>Practical Materials</option><option>Uniform</option></datalist></div>
                <div class="form-group"><label>Amount (KES) *</label><input name="amount" type="number" min="0" step="0.01" required></div>
            </div><div class="action-bar"><button type="submit" class="btn-submit">Add Fee Item</button></div></form>
            ${others.length && !shown.length ? `<form data-form="copy" class="fin-form fin-filter"><div class="form-group"><label>Copy all fee items from</label><select name="fromTerm">${others.map(t => `<option>${esc(t)}</option>`).join('')}</select></div><button type="submit" class="btn-secondary">Copy to ${esc(state.term)}</button></form>` : ''}` : ''}
            ${mayAdd() && state.term && shown.length ? `<div class="report-subtitle">Post ${esc(state.term)} Fees to Students</div>
            <p class="fin-note">Charges each active student the fee items of their course for this term. A fee item is never charged twice to the same student, so pressing this again is safe.</p>
            <form data-form="post" class="fin-form fin-filter"><div class="form-group"><label>Course</label><select name="course">${courseOptions('', 'All courses with fees')}</select></div>
                <button type="submit" class="btn-secondary">Preview</button></form>
            <div id="finPostResult"></div>` : ''}`
        };
    }

    async function submitFee(form) {
        const data = Object.fromEntries(new FormData(form));
        try {
            await call('POST', '/fee-structure', { ...data, term: state.term });
            showToast('Fee item added.');
            show('fees');
        } catch (err) { fail(err); }
    }

    async function previewPost(form) {
        const course = new FormData(form).get('course');
        const holder = document.getElementById('finPostResult');
        try {
            const result = await call('POST', '/post-fees', { term: state.term, course, preview: true });
            state.preview = { term: state.term, course };
            holder.innerHTML = result.charges
                ? `<div class="fin-card"><div>This will add <b>${result.charges}</b> charge${result.charges === 1 ? '' : 's'} to <b>${result.students}</b> student${result.students === 1 ? '' : 's'}, totalling <b>${kes(result.total)}</b>.</div>
                    <button type="button" class="btn-submit" data-act="post-confirm">Post Fees Now</button></div>`
                : '<p class="fin-note">Nothing to post: every active student of these courses has already been charged for this term, or no active student has a course with fees.</p>';
        } catch (err) { fail(err); }
    }

    async function confirmPost() {
        if (!state.preview) return;
        try {
            const result = await call('POST', '/post-fees', state.preview);
            showToast(`${result.charges} charge${result.charges === 1 ? '' : 's'} posted to ${result.students} student${result.students === 1 ? '' : 's'} (${kes(result.total)}).`);
            state.preview = null;
            document.getElementById('finPostResult').innerHTML = '';
        } catch (err) { fail(err); }
    }

    /* ---------- Balances ---------- */
    async function balances() {
        const rows = await call('GET', '/balances');
        state.balances = rows;
        return {
            html: `<div class="section-title">STUDENT BALANCES</div>
            <div class="fin-filter">
                <div class="form-group"><label>Course</label><select id="finBalCourse" data-act="filter-balances">${courseOptions('', 'All courses')}</select></div>
                <div class="form-group"><label>Show</label><select id="finBalShow" data-act="filter-balances"><option value="owing">Students who owe</option><option value="all">Everyone</option><option value="credit">Paid in advance</option></select></div>
                <button type="button" class="btn-secondary" data-act="export-balances">Export to Excel (CSV)</button></div>
            <div id="finBalances"></div>`,
            after: drawBalances
        };
    }

    function balanceRows() {
        const course = document.getElementById('finBalCourse').value.toLowerCase();
        const show = document.getElementById('finBalShow').value;
        return state.balances.filter(b => (!course || (b.course || '').toLowerCase() === course) &&
            (show === 'all' || (show === 'owing' ? b.balance > 0 : b.balance < 0)));
    }

    function drawBalances() {
        const rows = balanceRows();
        document.getElementById('finBalances').innerHTML = rows.length ? `<div class="fin-totals"><b>${rows.length} student${rows.length === 1 ? '' : 's'}</b>
            <span>Charged ${kes(rows.reduce((s, b) => s + b.charged, 0))}</span><span>Paid ${kes(rows.reduce((s, b) => s + b.paid, 0))}</span>
            <span>Balance ${kes(rows.reduce((s, b) => s + b.balance, 0))}</span></div>
            <div class="table-wrap"><table class="data-table fin-table"><thead><tr><th>AdmNo</th><th>Student</th><th>Course</th><th class="fin-num">Charged</th><th class="fin-num">Paid</th><th class="fin-num">Balance</th><th></th></tr></thead>
            <tbody>${rows.map(b => `<tr><td>${esc(b.admNo)}</td><td>${esc(b.name)}${b.activeStudent === 'no' ? ' <small>(inactive)</small>' : ''}</td><td>${esc(b.course)}</td>
                <td class="fin-num">${kes(b.charged)}</td><td class="fin-num">${kes(b.paid)}</td><td class="fin-num ${b.balance > 0 ? 'fin-bad' : 'fin-good'}">${kes(b.balance)}</td>
                <td><button type="button" class="btn-small" data-act="open-statement" data-id="${esc(b.id)}">Statement</button></td></tr>`).join('')}</tbody></table></div>`
            : '<p class="fin-note">No students to show.</p>';
    }

    /* ---------- Receipt and statement printing ---------- */
    function overlay(html) {
        closeOverlay();
        const box = document.createElement('div');
        box.id = 'finOverlay';
        box.innerHTML = `<div class="fin-paper"><div class="fin-paper-bar no-print">
            <button type="button" class="btn-submit" data-act="print">Print</button><button type="button" class="btn-secondary" data-act="close-overlay">Close</button></div>${html}</div>`;
        document.body.appendChild(box);
        document.body.classList.add('fin-printing');
        box.addEventListener('click', event => {
            const act = event.target.closest('[data-act]');
            if (act && act.dataset.act === 'print') window.print();
            else if (act && act.dataset.act === 'close-overlay' || event.target === box) closeOverlay();
        });
    }

    function closeOverlay() {
        const old = document.getElementById('finOverlay');
        if (old) old.remove();
        document.body.classList.remove('fin-printing');
    }

    function letterhead(title) {
        const o = state.org || {};
        return `<div class="fin-head">${o.logo ? `<img src="${esc(o.logo)}" alt="">` : ''}<div><h2>${esc(o.collegeName || 'FEWA Beauty & Fashion College')}</h2>
            <small>${[o.postalAddress, o.phone, o.email].filter(Boolean).map(esc).join(' &middot; ')}</small></div></div><h3 class="fin-title">${esc(title)}</h3>`;
    }

    async function showReceipt(payment) {
        // The balance now, with the rest of the receipt as it was recorded
        let balance = null;
        try { balance = (await call('GET', '/student/' + encodeURIComponent(payment.studentId))).balance; } catch { }
        overlay(`${letterhead('OFFICIAL RECEIPT')}${payment.voided ? '<div class="fin-stamp">REVERSED</div>' : ''}
            <table class="fin-receipt">
                <tr><th>Receipt No.</th><td>${esc(payment.receiptNo)}</td><th>Date</th><td>${esc(date(payment.paidOn))}</td></tr>
                <tr><th>Received from</th><td colspan="3">${esc(payment.studentName)} (${esc(payment.admNo)})</td></tr>
                <tr><th>Amount</th><td colspan="3"><b>${kes(payment.amount)}</b></td></tr>
                <tr><th>Paid by</th><td>${esc(METHOD_NAME[payment.method] || payment.method)}</td><th>Reference</th><td>${esc(payment.reference) || '-'}</td></tr>
                ${payment.term ? `<tr><th>Term</th><td colspan="3">${esc(payment.term)}</td></tr>` : ''}
                ${payment.note ? `<tr><th>Note</th><td colspan="3">${esc(payment.note)}</td></tr>` : ''}
                ${balance === null ? '' : `<tr><th>Fee balance now</th><td colspan="3">${balance > 0 ? kes(balance) + ' due' : balance < 0 ? kes(-balance) + ' paid in advance' : 'Fully paid'}</td></tr>`}
                <tr><th>Received by</th><td colspan="3">${esc(payment.createdBy)}</td></tr>
            </table><p class="fin-foot">This receipt is a computer record of the college system. Thank you.</p>`);
    }

    function printStatement() {
        const st = state.statement;
        if (!st) return;
        const lines = [...st.charges.filter(c => !c.voided).map(c => ({ at: c.createdAt, text: `${c.description}${c.term ? ' (' + c.term + ')' : ''}`, debit: c.amount > 0 ? c.amount : 0, credit: c.amount < 0 ? -c.amount : 0 })),
            ...st.payments.filter(p => !p.voided).map(p => ({ at: p.paidOn, text: `Payment ${p.receiptNo} - ${METHOD_NAME[p.method] || p.method}${p.reference ? ' ' + p.reference : ''}`, debit: 0, credit: p.amount }))]
            .sort((a, b) => String(a.at).localeCompare(String(b.at)));
        let running = 0;
        overlay(`${letterhead('FEE STATEMENT')}<p><b>${esc(st.student.name)}</b> (${esc(st.student.admNo)})<br>${esc(st.student.course || '')}<br><small>Printed ${esc(date(today()))}</small></p>
            <table class="data-table fin-table"><thead><tr><th>Date</th><th>Details</th><th class="fin-num">Charged</th><th class="fin-num">Paid</th><th class="fin-num">Balance</th></tr></thead><tbody>
            ${lines.map(l => { running = Math.round((running + l.debit - l.credit) * 100) / 100; return `<tr><td>${esc(date(l.at))}</td><td>${esc(l.text)}</td>
                <td class="fin-num">${l.debit ? kes(l.debit) : ''}</td><td class="fin-num">${l.credit ? kes(l.credit) : ''}</td><td class="fin-num">${kes(running)}</td></tr>`; }).join('')}
            <tr><th colspan="2">Total</th><th class="fin-num">${kes(st.charged)}</th><th class="fin-num">${kes(st.paid)}</th><th class="fin-num">${kes(st.balance)}</th></tr></tbody></table>
            <p><b>${st.balance > 0 ? 'Balance due: ' + kes(st.balance) : st.balance < 0 ? 'Paid in advance: ' + kes(-st.balance) : 'Fully paid'}</b></p>`);
    }

    /* ---------- Export (CSV opens in Excel) ---------- */
    function download(name, rows) {
        // A cell that starts with = + - @ would run as a formula in Excel: a ' in front keeps it text
        const cell = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
        const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${name}-${today()}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    }

    /* ---------- Clicks and forms ---------- */
    const actions = {
        tab: el => show(el.dataset.tab),
        'open-statement': async el => {
            try { await loadStudent(el.dataset.id); show('statement'); } catch (err) { fail(err); }
        },
        receipt: async el => {
            const known = [...state.register, ...(state.statement ? state.statement.payments.map(p => ({ ...p, studentId: state.student.id, admNo: state.student.admNo, studentName: state.student.name })) : [])]
                .find(p => p.id === el.dataset.id);
            if (known) showReceipt(known);
        },
        'void-payment': async el => {
            const reason = prompt('Reverse this payment?\n\nIt stays on record as reversed (it is never deleted). Reason:');
            if (reason === null) return;
            try {
                await call('POST', `/payment/${encodeURIComponent(el.dataset.id)}/void`, { reason });
                showToast('Payment reversed.');
                if (state.tab === 'payments') runRegister();
                else if (state.tab === 'statement' && state.student) { await loadStudent(state.student.id); document.getElementById('finStatement').innerHTML = statementHtml(); }
                else show(state.tab);
            } catch (err) { fail(err); }
        },
        'void-charge': async el => {
            const reason = prompt('Reverse this charge?\n\nIt stays on record as reversed (it is never deleted). Reason:');
            if (reason === null) return;
            try {
                await call('POST', `/charge/${encodeURIComponent(el.dataset.id)}/void`, { reason });
                showToast('Charge reversed.');
                await loadStudent(state.student.id);
                document.getElementById('finStatement').innerHTML = statementHtml();
            } catch (err) { fail(err); }
        },
        'print-statement': printStatement,
        'export-payments': () => download('FEWA-payments', [['Receipt', 'Date', 'AdmNo', 'Student', 'Method', 'Reference', 'Amount', 'Received by', 'Reversed'],
            ...state.register.map(p => [p.receiptNo, p.paidOn, p.admNo, p.studentName, METHOD_NAME[p.method] || p.method, p.reference, p.amount, p.createdBy, p.voided ? 'YES' : ''])]),
        'export-balances': () => download('FEWA-balances', [['AdmNo', 'Student', 'Course', 'Charged', 'Paid', 'Balance'],
            ...balanceRows().map(b => [b.admNo, b.name, b.course, b.charged, b.paid, b.balance])]),
        'filter-balances': drawBalances,
        'pick-term': el => { state.term = el.value; show('fees'); },
        'edit-fee': async el => {
            const item = prompt('Fee item name:', el.dataset.item);
            if (item === null) return;
            const amount = prompt('Amount (KES):', el.dataset.amount);
            if (amount === null) return;
            try { await call('PUT', '/fee-structure/' + encodeURIComponent(el.dataset.id), { item, amount }); showToast('Fee item changed. Charges already posted stay as they are.'); show('fees'); } catch (err) { fail(err); }
        },
        'delete-fee': async el => {
            if (!confirm(`Remove "${el.dataset.item}" from the fee structure?\n\nCharges already posted to students stay.`)) return;
            try { await call('DELETE', '/fee-structure/' + encodeURIComponent(el.dataset.id)); show('fees'); } catch (err) { fail(err); }
        },
        'post-confirm': confirmPost
    };

    const forms = {
        pay: submitPayment, charge: submitCharge, fee: submitFee, post: previewPost,
        payments: runRegister,
        copy: async form => {
            try { const r = await call('POST', '/fee-structure-copy', { fromTerm: new FormData(form).get('fromTerm'), toTerm: state.term }); showToast(`${r.copied} fee item(s) copied.`); show('fees'); } catch (err) { fail(err); }
        }
    };

    function wire() {
        app().addEventListener('click', event => {
            const el = event.target.closest('[data-act]');
            if (el && el.tagName !== 'SELECT' && actions[el.dataset.act]) actions[el.dataset.act](el);
        });
        app().addEventListener('change', event => {
            const el = event.target.closest('select[data-act]');
            if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
        });
        app().addEventListener('submit', event => {
            const form = event.target.closest('form[data-form]');
            if (!form) return;
            event.preventDefault();
            forms[form.dataset.form](form);
        });
    }
})();