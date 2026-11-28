/* ---------- Manage Finance > Fee Setup (owner, 2026-11-28) ----------
   Nine tabs, each a list kept in its own table in the "finance" schema (database/3-finance.sql, end):
     Fee Types               finance.fee_types               the fees the school charges and how each is billed
     VoteHeads               finance.vote_heads              where the money of a fee type is shared out (Tuition, Exams...)
     Discount Types          finance.discount_types          kinds of discount (Sibling, Staff child, Bursary...)
     Discount Amounts        finance.discount_amounts        how much a discount type gives, per course / fee type / semester
     Discounts & Surcharges  finance.discounts_surcharges    amounts taken off or added on, and when they apply
     Payment Methods         finance.payment_methods         how fees can be paid (M-Pesa, Bank, Cash, Cheque...)
     School Payment Methods  finance.school_payment_methods  the payment methods of each school, with paybill / bank account
     Bank Accounts           finance.bank_accounts           the college's bank accounts
     Lists                   finance.finance_lists           the small lists the boxes above choose from (income classes...)
   Drawn into <div id="feeSetupApp"> of StudentAdmissions.html; feeSetupOpen() is called each time Fee Setup is pressed.
   Seeing: the finance rights (server: RIGHTS_TO_READ); changing: Edit Fee Setup (finance.setup), checked by the server too.
   Uses: fewaDB (db.js), fewaConfirm (safe-actions.js), showToast (notify.js), iconButton (icons.js), can/allowed/currentUser (auth.js). */
(function () {
    const STATUS = ['ACTIVE', 'INACTIVE'];
    const CALCULATED = ['PERCENT', 'AMOUNT'];
    const LIST_NAMES = ['INCOME CLASS', 'INCOME / LIABILITY ACCOUNT', 'CURRENCY'];
    const DEFAULT_METHODS = ['M-PESA', 'BANK DEPOSIT', 'CASH', 'CHEQUE'];

    const state = { tab: 'feeTypes', data: {}, courses: [], schools: [], terms: [], editing: null, find: '' };
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    const rows = store => state.data[store] || [];
    const names = (store, field) => [...new Set(rows(store).filter(r => r.status !== 'INACTIVE').map(r => r[field]).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const listItems = list => [...new Set(rows('finance_lists').filter(r => same(r.listName, list)).map(r => r.item).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    const num = v => v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString();
    const yn = v => v === 'Y' ? 'Yes' : 'No';
    // A tick box's value on a record (an older record without it: the box's starting value)
    const isTicked = (f, r) => r[f.name] === undefined || r[f.name] === null || r[f.name] === '' ? !!f.start : r[f.name] === 'Y';
    const ticked = (t, r) => t.fields.filter(f => f.type === 'check' && isTicked(f, r)).map(f => f.label).join(', ');
    const value = (r, kind) => r.calculatedAs === 'PERCENT' ? `${num(r.value)}%` : r.value === '' || r.value == null ? '' : `KES ${num(r.value)}`;
    const mayChange = () => can('finance', 'setup');
    const app = () => document.getElementById('feeSetupApp');
    const box = name => document.getElementById('fs_' + name);
    const methodNames = () => { const saved = names('payment_methods', 'name'); return saved.length ? saved : DEFAULT_METHODS; };
    const bankLabel = r => [r.bankName, r.accountName, r.accountNumber].filter(Boolean).join(' - ');

    const TABS = [
        {
            key: 'feeTypes', title: 'Fee Types', store: 'fee_types', save: 'Save fee type',
            note: 'Define the fees the school charges and how each is billed.',
            fields: [
                { name: 'feeName', label: 'Fee Name', type: 'text', required: true, max: 100, placeholder: 'For example Tuition Fee',
                    list: () => names('fee_types', 'feeName') },
                { name: 'appliesTo', label: 'Applies To', type: 'select', options: () => state.courses, placeholder: '-- all courses --' },
                { name: 'incomeClass', label: 'Income Class', type: 'select', options: () => listItems('INCOME CLASS'), placeholder: '-- DEFAULT --' },
                { name: 'account', label: 'Income/Liability Account', type: 'select', options: () => listItems('INCOME / LIABILITY ACCOUNT') },
                { name: 'feeType', label: 'Fee Type', type: 'select', options: () => ['NORMAL FEES', 'OTHER CHARGES'], placeholder: null },
                { name: 'priority', label: 'Priority', type: 'number', min: 1, max: 99, start: 1 },
                { name: 'consolidationType', label: 'Consolidation Fee Type', type: 'select',
                    options: () => names('fee_types', 'feeName').filter(n => !box('feeName') || !same(n, box('feeName').value)) },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null },
                // Options: two columns as the owner's example (left, right, left, right...)
                { name: 'optionalFee', label: 'Optional Fee', type: 'check' },
                { name: 'chargeOnce', label: 'Charge Once (On Admission)', type: 'check' },
                { name: 'miscellaneousFee', label: 'Miscellaneous Fee', type: 'check' },
                { name: 'chargeOnceYear', label: 'Charge Once Every Year', type: 'check' },
                { name: 'discountEligible', label: 'Discount Eligible', type: 'check' },
                { name: 'chargeOncePerFamily', label: 'Charge Once Per Family', type: 'check' },
                { name: 'refundable', label: 'Refundable', type: 'check' },
                { name: 'continuingOnly', label: 'Charge Continuing Students Only', type: 'check' },
                { name: 'chargeOnTransfer', label: 'Charge On Inter School Transfer', type: 'check', start: true },
                { name: 'billProspective', label: 'Bill Prospective Students', type: 'check' }
            ],
            columns: [['Charge', r => r.feeName], ['Apply to', r => r.appliesTo || 'All courses'], ['Fee type', r => r.feeType],
                ['Priority', r => num(r.priority), true], ['Options', r => ticked(TABS[0], r)], ['Consolidate to', r => r.consolidationType],
                ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => Number(a.priority || 99) - Number(b.priority || 99) || String(a.feeName).localeCompare(String(b.feeName)),
            same: (a, b) => same(a.feeName, b.feeName) && same(a.appliesTo, b.appliesTo),
            label: r => r.feeName + (r.appliesTo ? ` (${r.appliesTo})` : ''),
            uses: { field: 'feeName', in: [['vote_heads', 'feeType'], ['discount_amounts', 'feeType'], ['discounts_surcharges', 'feeType'],
                ['fee_types', 'consolidationType']] }
        },
        {
            key: 'voteHeads', title: 'VoteHeads', store: 'vote_heads', save: 'Save vote head',
            note: 'Define the voteheads that fees are grouped under. A sub-votehead belongs to a main votehead. Priority 1 is paid first.',
            fields: [
                { name: 'name', label: 'VoteHead', type: 'text', required: true, max: 100, upper: true },
                { name: 'displayName', label: 'Display Name', type: 'text', required: true, max: 100, upper: true },
                // Only main voteheads can have sub-voteheads (one level), never the votehead itself
                { name: 'parent', label: 'Sub-votehead of', type: 'select', placeholder: '-- none, main votehead --',
                    options: () => rows('vote_heads').filter(r => !r.parent && r.id !== state.editing).map(r => r.name).filter(Boolean)
                        .sort((a, b) => a.localeCompare(b)) },
                { name: 'billableSubs', label: 'Billable Sub-voteheads', type: 'number', min: 0, max: 99, placeholder: 'Leave blank if not limited' },
                { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
                { name: 'feeType', label: 'Fee Type', type: 'select', options: () => names('fee_types', 'feeName') },
                { name: 'priority', label: 'Priority', type: 'number', min: 1, max: 99, start: 1 },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null },
                { name: 'showOnFeeStructure', label: 'Show on fee structure', type: 'check', start: true },
                { name: 'showOnInvoices', label: 'Show on invoices', type: 'check', start: true },
                { name: 'extraCurricular', label: 'Extra-curricular', type: 'check' }
            ],
            columns: [['VoteHead', r => r.name], ['Display name', r => r.displayName || r.name], ['Sub-votehead of', r => r.parent],
                ['Fee type', r => r.feeType], ['Priority', r => num(r.priority), true],
                ['Invoices', r => isTicked(TABS[1].fields.find(f => f.name === 'showOnInvoices'), r) ? 'YES' : 'NO'],
                ['Fee structure', r => isTicked(TABS[1].fields.find(f => f.name === 'showOnFeeStructure'), r) ? 'YES' : 'NO'],
                ['Extra-curricular', r => r.extraCurricular === 'Y' ? 'YES' : 'NO'],
                ['Billable sub-voteheads', r => r.billableSubs === '' || r.billableSubs == null ? '' : num(r.billableSubs), true],
                ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.parent || a.name).localeCompare(String(b.parent || b.name)) || (a.parent ? 1 : 0) - (b.parent ? 1 : 0)
                || Number(a.priority || 99) - Number(b.priority || 99) || String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.name, b.name),
            label: r => r.name,
            check: r => {
                if (r.parent && same(r.parent, r.name)) return 'A votehead cannot be a sub-votehead of itself.';
                const old = rows('vote_heads').find(x => x.id === state.editing);
                if (r.parent && old && rows('vote_heads').some(x => same(x.parent, old.name)))
                    return `${old.name} has sub-voteheads of its own, so it stays a main votehead.`;
                return '';
            },
            uses: { field: 'name', in: [['vote_heads', 'parent']] }
        },
        {
            key: 'discountTypes', title: 'Discount Types', store: 'discount_types', save: 'Save discount type',
            note: 'The kinds of discount the school gives (for example Sibling discount, Staff child, Bursary).',
            fields: [
                { name: 'name', label: 'Discount Name', type: 'text', required: true, max: 100 },
                { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
                { name: 'description', label: 'Description', type: 'text', max: 200 },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null }
            ],
            columns: [['Discount type', r => r.name], ['Code', r => r.code], ['Description', r => r.description], ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.name, b.name),
            label: r => r.name,
            uses: { field: 'name', in: [['discount_amounts', 'discountType']] }
        },
        {
            key: 'discountAmounts', title: 'Discount Amounts', store: 'discount_amounts', save: 'Save discount amount',
            note: 'How much each discount type gives: a percentage or an amount, for a course, fee type and semester (empty = all).',
            fields: [
                { name: 'discountType', label: 'Discount Type', type: 'select', options: () => names('discount_types', 'name'), required: true },
                { name: 'course', label: 'Course', type: 'select', options: () => state.courses, placeholder: '-- all courses --' },
                { name: 'feeType', label: 'Fee Type', type: 'select', options: () => names('fee_types', 'feeName'), placeholder: '-- all fee types --' },
                { name: 'period', label: 'Semester', type: 'select', options: () => state.terms, placeholder: '-- every semester --' },
                { name: 'calculatedAs', label: 'Calculated As', type: 'select', options: () => CALCULATED, placeholder: null },
                { name: 'value', label: 'Value (% or KES)', type: 'number', min: 0, max: 10000000, required: true }
            ],
            columns: [['Discount type', r => r.discountType], ['Course', r => r.course || 'All courses'], ['Fee type', r => r.feeType || 'All fee types'],
                ['Semester', r => r.period || 'Every semester'], ['Discount', r => value(r), true]],
            sort: (a, b) => String(a.discountType).localeCompare(String(b.discountType)) || String(a.course).localeCompare(String(b.course)),
            same: (a, b) => same(a.discountType, b.discountType) && same(a.course, b.course) && same(a.feeType, b.feeType) && same(a.period, b.period),
            label: r => `${r.discountType} (${r.course || 'all courses'})`,
            check: r => r.calculatedAs === 'PERCENT' && Number(r.value) > 100 ? 'A percentage cannot be above 100.' : ''
        },
        {
            key: 'discountsSurcharges', title: 'Discounts & Surcharges', store: 'discounts_surcharges', save: 'Save',
            note: 'Amounts taken off (discount) or added on (surcharge, for example a late payment) and when they apply.',
            fields: [
                { name: 'kind', label: 'Discount or Surcharge', type: 'select', options: () => ['DISCOUNT', 'SURCHARGE'], placeholder: null },
                { name: 'name', label: 'Name', type: 'text', required: true, max: 100, placeholder: 'For example Late payment' },
                { name: 'course', label: 'Course', type: 'select', options: () => state.courses, placeholder: '-- all courses --' },
                { name: 'feeType', label: 'Fee Type', type: 'select', options: () => names('fee_types', 'feeName'), placeholder: '-- all fee types --' },
                { name: 'calculatedAs', label: 'Calculated As', type: 'select', options: () => CALCULATED, placeholder: null },
                { name: 'value', label: 'Value (% or KES)', type: 'number', min: 0, max: 10000000, required: true },
                { name: 'condition', label: 'When it applies', type: 'text', max: 200, placeholder: 'For example Paid after the semester start' },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null }
            ],
            columns: [['Kind', r => r.kind], ['Name', r => r.name], ['Course', r => r.course || 'All courses'], ['Fee type', r => r.feeType || 'All fee types'],
                ['Value', r => value(r), true], ['When it applies', r => r.condition], ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.kind, b.kind) && same(a.name, b.name) && same(a.course, b.course) && same(a.feeType, b.feeType),
            label: r => `${r.name} (${String(r.kind || '').toLowerCase()})`,
            check: r => r.calculatedAs === 'PERCENT' && Number(r.value) > 100 ? 'A percentage cannot be above 100.' : ''
        },
        {
            key: 'paymentMethods', title: 'Payment Methods', store: 'payment_methods', save: 'Save payment method',
            note: 'The ways fees can be paid. Tick "Needs a reference" when a transaction code or slip number must be typed.',
            fields: [
                { name: 'name', label: 'Payment Method', type: 'text', required: true, max: 60, upper: true, list: () => DEFAULT_METHODS },
                { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null },
                { name: 'needsReference', label: 'Needs a reference (code / slip number)', type: 'check' }
            ],
            columns: [['Payment method', r => r.name], ['Code', r => r.code], ['Needs a reference', r => yn(r.needsReference)], ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.name, b.name),
            label: r => r.name,
            uses: { field: 'name', in: [['school_payment_methods', 'paymentMethod']] }
        },
        {
            key: 'schoolMethods', title: 'School Payment Methods', store: 'school_payment_methods', save: 'Save school payment method',
            note: 'The payment methods each school takes, with the paybill / till number or bank account the money goes to.',
            fields: [
                { name: 'school', label: 'School', type: 'select', options: () => state.schools, required: true },
                { name: 'paymentMethod', label: 'Payment Method', type: 'select', options: methodNames, required: true },
                { name: 'bankAccount', label: 'Bank Account', type: 'select', options: () => rows('bank_accounts').filter(r => r.status !== 'INACTIVE').map(bankLabel) },
                { name: 'payNumber', label: 'Paybill / Till No.', type: 'text', max: 30 },
                { name: 'accountFormat', label: 'Account No. to use', type: 'text', max: 100, placeholder: 'For example Student AdmNo' },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null }
            ],
            columns: [['School', r => r.school], ['Payment method', r => r.paymentMethod], ['Bank account', r => r.bankAccount],
                ['Paybill / Till', r => r.payNumber], ['Account no. to use', r => r.accountFormat], ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.school).localeCompare(String(b.school)) || String(a.paymentMethod).localeCompare(String(b.paymentMethod)),
            same: (a, b) => same(a.school, b.school) && same(a.paymentMethod, b.paymentMethod) && same(a.bankAccount, b.bankAccount),
            label: r => `${r.paymentMethod} (${r.school})`
        },
        {
            key: 'bankAccounts', title: 'Bank Accounts', store: 'bank_accounts', save: 'Save bank account',
            note: "The college's bank accounts fees are paid into.",
            fields: [
                { name: 'bankName', label: 'Bank Name', type: 'text', required: true, max: 100 },
                { name: 'branch', label: 'Branch', type: 'text', max: 100 },
                { name: 'accountName', label: 'Account Name', type: 'text', required: true, max: 150 },
                { name: 'accountNumber', label: 'Account Number', type: 'text', required: true, max: 40 },
                { name: 'currency', label: 'Currency', type: 'select', options: () => { const l = listItems('CURRENCY'); return l.length ? l : ['KES']; }, placeholder: null },
                { name: 'school', label: 'School', type: 'select', options: () => state.schools, placeholder: '-- all schools --' },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null }
            ],
            columns: [['Bank', r => r.bankName], ['Branch', r => r.branch], ['Account name', r => r.accountName], ['Account number', r => r.accountNumber],
                ['Currency', r => r.currency], ['School', r => r.school || 'All schools'], ['Status', r => r.status || 'ACTIVE']],
            sort: (a, b) => String(a.bankName).localeCompare(String(b.bankName)),
            same: (a, b) => same(a.bankName, b.bankName) && same(a.accountNumber, b.accountNumber),
            label: r => `${r.bankName} ${r.accountNumber}`,
            inUse: r => rows('school_payment_methods').some(s => same(s.bankAccount, bankLabel(r)))
        },
        {
            key: 'lists', title: 'Lists', store: 'finance_lists', save: 'Save list item',
            note: 'The small lists the boxes on the other tabs choose from: income classes, income / liability accounts and currencies.',
            fields: [
                { name: 'listName', label: 'List', type: 'select', options: () => LIST_NAMES, placeholder: null, filter: true },
                { name: 'item', label: 'Item', type: 'text', required: true, max: 100, upper: true }
            ],
            columns: [['List', r => r.listName], ['Item', r => r.item]],
            sort: (a, b) => String(a.listName).localeCompare(String(b.listName)) || String(a.item).localeCompare(String(b.item)),
            same: (a, b) => same(a.listName, b.listName) && same(a.item, b.item),
            label: r => `${r.item} (${r.listName})`,
            inUse: r => (same(r.listName, 'INCOME CLASS') && rows('fee_types').some(f => same(f.incomeClass, r.item)))
                || (same(r.listName, 'INCOME / LIABILITY ACCOUNT') && rows('fee_types').some(f => same(f.account, r.item)))
                || (same(r.listName, 'CURRENCY') && rows('bank_accounts').some(b => same(b.currency, r.item)))
        }
    ];
    const tab = () => TABS.find(t => t.key === state.tab) || TABS[0];

    /* ---------- Reading ---------- */
    async function load() {
        const stores = [...new Set(TABS.map(t => t.store))];
        const read = key => fewaDB.getOne('settings', key).catch(() => null);
        const [lists, courses, schools] = await Promise.all([
            Promise.all(stores.map(s => fewaDB.getAll(s).catch(() => []))), read('courses'), read('schools')]);
        stores.forEach((s, i) => { state.data[s] = Array.isArray(lists[i]) ? lists[i] : []; });
        const courseItems = ((courses && courses.items) || []).filter(c => c.enabled !== 'NO' && c.name);
        state.courses = courseItems.map(c => c.labelSuffix ? `${c.name} (${c.labelSuffix})` : c.name);
        state.schools = ((schools && schools.items) || []).map(s => s.name).filter(Boolean);
        // SEMESTER 1..N (N = the longest course: 3 semesters a year), as Manage Finance > Payments
        const semesters = c => { const n = Number(c.duration) || 0, t = String(c.durationType || '').toUpperCase().replace(/S$/, '');
            return t === 'YEAR' ? n * 3 : t === 'MONTH' ? Math.ceil(n / 4) : 1; };
        const most = Math.max(1, ...courseItems.map(semesters));
        state.terms = Array.from({ length: most }, (_, i) => `SEMESTER ${i + 1}`);
    }

    /* ---------- Drawing ---------- */
    function draw() {
        const t = tab();
        const input = f => {
            const id = 'fs_' + f.name;
            if (f.type === 'select') return `<select id="${id}"></select>`;
            if (f.type === 'number') return `<input id="${id}" type="number" min="${f.min ?? 0}" max="${f.max ?? 100000}" step="any" autocomplete="off" value="${f.start ?? ''}" placeholder="${esc(f.placeholder || '')}">`;
            return `<input id="${id}" type="text" maxlength="${f.max || 200}" autocomplete="off" placeholder="${esc(f.placeholder || '')}"${f.list ? ` list="${id}_list"` : ''}>` +
                (f.list ? `<datalist id="${id}_list"></datalist>` : '');
        };
        const plain = t.fields.filter(f => f.type !== 'check'), checks = t.fields.filter(f => f.type === 'check');
        app().innerHTML = `<div class="fin-tabs fs-tabs" role="tablist">${TABS.map(x =>
                `<button type="button" role="tab" class="fin-tab${x.key === t.key ? ' active' : ''}" onclick="feeSetupTab('${x.key}')">${esc(x.title)}</button>`).join('')}</div>
            <div class="fs-sheet">
                <h2 class="fs-title">${esc(t.title)}</h2>
                <div class="fs-info">${esc(t.note)}</div>
                <div class="fs-grid">${plain.map(f => `<label for="fs_${f.name}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input(f)}`).join('')}
                    ${checks.length ? `<span class="fs-options-label">Options</span><div class="fs-options${checks.length <= 3 ? ' fs-options-row' : ''}">${checks.map(f =>
                        `<label class="fs-check"><input type="checkbox" id="fs_${f.name}"${f.start ? ' checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>` : ''}
                </div>
                <div class="fs-buttons">
                    ${mayChange() ? `<button type="button" class="btn-submit" id="fsSave" onclick="feeSetupSave()">${esc(t.save)}</button>` : ''}
                    <button type="button" class="btn-secondary" onclick="feeSetupClear()">Clear</button>
                    ${mayChange() ? '' : '<span class="fs-readonly">You can see this list. Changing it needs the right Edit Fee Setup.</span>'}
                </div>
                <div class="fs-listbar"><span id="fsCount"></span>
                    <input type="search" id="fsFind" placeholder="Search this list..." autocomplete="off" value="${esc(state.find)}" data-no-save-question></div>
                <div class="table-wrap"><table class="data-table">
                    <thead><tr><th class="unit-actions"></th>${t.columns.map(([h, , n]) => `<th${n ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
                    <tbody id="fsRows"></tbody></table></div>
            </div>`;
        fillChoices();
        box(t.fields[0].name).addEventListener('input', fillChoices);
        for (const f of t.fields.filter(f => f.filter)) box(f.name).addEventListener('change', drawList);
        document.getElementById('fsFind').addEventListener('input', e => { state.find = e.target.value; drawList(); });
        drawList();
    }

    function fillChoices() {
        for (const f of tab().fields) {
            const el = box(f.name);
            if (!el) continue;
            if (f.type === 'select') {
                const keep = el.value;
                const opts = f.options();
                const blank = f.placeholder === null ? '' : `<option value="">${esc(f.placeholder || '-- select one --')}</option>`;
                el.innerHTML = blank + opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
                if (keep && [...el.options].some(o => o.value === keep)) el.value = keep;
            }
            if (f.list && document.getElementById(`fs_${f.name}_list`)) {
                document.getElementById(`fs_${f.name}_list`).innerHTML = f.list().map(v => `<option value="${esc(v)}"></option>`).join('');
            }
        }
    }

    function drawList() {
        const t = tab();
        const filters = t.fields.filter(f => f.filter).map(f => [f, box(f.name).value]).filter(([, v]) => v);
        const words = state.find.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const list = rows(t.store).filter(r => filters.every(([f, v]) => same(r[f.name], v)))
            .filter(r => words.every(w => t.columns.map(([, get]) => get(r)).join(' ').toLowerCase().includes(w)))
            .sort(t.sort);
        document.getElementById('fsCount').textContent = `${list.length} ${list.length === 1 ? 'entry' : 'entries'}.`;
        document.getElementById('fsRows').innerHTML = list.length ? list.map(r => `<tr${r.id === state.editing ? ' class="editing"' : ''}>
                <td class="unit-actions">${mayChange() ? iconButton('edit', 'Change ' + esc(t.label(r)), `feeSetupEdit('${r.id}')`) +
                    iconButton('delete', 'Remove ' + esc(t.label(r)), `feeSetupRemove('${r.id}')`) : ''}</td>
                ${t.columns.map(([, get, n]) => `<td${n ? ' class="num"' : ''}>${esc(get(r) ?? '')}</td>`).join('')}</tr>`).join('')
            : `<tr class="empty-row"><td colspan="${t.columns.length + 1}">Nothing is listed here yet.</td></tr>`;
    }

    /* ---------- Changing ---------- */
    function readForm(t) {
        const record = {};
        for (const f of t.fields) {
            const el = box(f.name);
            if (f.type === 'check') { record[f.name] = el.checked ? 'Y' : 'N'; continue; }
            let v = el.value.trim().replace(/\s+/g, ' ');
            if (f.upper) v = v.toUpperCase();
            if (f.type === 'number' && v !== '') {
                if (!Number.isFinite(Number(v)) || Number(v) < (f.min ?? 0) || Number(v) > (f.max ?? 100000)) {
                    throw new Error(`${f.label}: enter a number from ${num(f.min ?? 0)} to ${num(f.max ?? 100000)}.`);
                }
                v = Number(v);
            }
            record[f.name] = v;
        }
        const missing = t.fields.filter(f => f.required && record[f.name] === '').map(f => f.label);
        if (missing.length) throw new Error('Please fill in: ' + missing.join(', ') + '.');
        const problem = t.check ? t.check(record) : '';
        if (problem) throw new Error(problem);
        return record;
    }

    async function save() {
        if (!allowed('finance', 'setup')) return;
        const t = tab();
        let record;
        try { record = readForm(t); } catch (err) { return alert(err.message); }
        const old = rows(t.store).find(r => r.id === state.editing);
        const existing = rows(t.store).find(r => r.id !== state.editing && t.same(r, record));
        if (existing) return alert(`${t.label(existing)} is already in the list. Change that one with its pencil instead.`);
        if (!await fewaConfirm(`Save ${t.label(record)}?`)) return;
        const saved = { ...(old || {}), ...record, id: (old && old.id) || newId(), updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' };
        try {
            await fewaDB.put(t.store, saved);
            // A renamed entry is renamed where the other tabs use it
            if (t.uses && old && old[t.uses.field] && !same(old[t.uses.field], saved[t.uses.field])) {
                for (const [store, field] of t.uses.in) {
                    for (const r of rows(store).filter(x => x.id !== saved.id && same(x[field], old[t.uses.field]))) {
                        await fewaDB.put(store, { ...r, [field]: saved[t.uses.field] });
                    }
                }
            }
            showToast(`${t.label(saved)} saved.`);
            state.editing = null;
            await load();
            draw();
        } catch (err) { alert('It could not be saved: ' + err.message); }
    }

    function edit(id) {
        const t = tab();
        const r = rows(t.store).find(x => x.id === id);
        if (!r) return;
        state.editing = id;
        for (const f of t.fields) {
            const el = box(f.name), v = r[f.name] === undefined || r[f.name] === null ? '' : String(r[f.name]);
            if (f.type === 'check') { el.checked = isTicked(f, r); continue; }
            if (f.type === 'select' && v && ![...el.options].some(o => o.value === v)) el.add(new Option(v, v));
            el.value = v;
        }
        fillChoices();
        document.getElementById('fsSave').textContent = 'Save change';
        drawList();
        box(t.fields[0].name).focus();
        box(t.fields[0].name).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function clear() {
        state.editing = null;
        draw();
    }

    async function remove(id) {
        if (!allowed('finance', 'setup')) return;
        const t = tab();
        const r = rows(t.store).find(x => x.id === id);
        if (!r) return;
        const used = t.inUse ? t.inUse(r)
            : t.uses ? t.uses.in.some(([store, field]) => rows(store).some(x => x.id !== r.id && same(x[field], r[t.uses.field]))) : false;
        if (used) return alert(`${t.label(r)} is in use (on this tab or another one), so it is kept. Change or remove those entries first (or set it INACTIVE).`);
        if (!await fewaConfirm(`Remove ${t.label(r)}?`)) return;
        try {
            await fewaDB.remove(t.store, id);
            if (state.editing === id) state.editing = null;
            showToast(`${t.label(r)} removed.`);
            await load();
            draw();
        } catch (err) { alert('It could not be removed: ' + err.message); }
    }

    const newId = () => 'fs-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    window.feeSetupTab = key => { state.tab = key; state.editing = null; state.find = ''; draw(); };
    window.feeSetupSave = save;
    window.feeSetupEdit = edit;
    window.feeSetupClear = clear;
    window.feeSetupRemove = remove;
    window.feeSetupOpen = async () => {
        if (!app()) return;
        app().innerHTML = '<p class="fin-note">Loading...</p>';
        try { await load(); } catch (err) { app().innerHTML = `<p class="fin-bad">${esc(err.message || 'It could not be loaded.')}</p>`; return; }
        draw();
    };
})();
