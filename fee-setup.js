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
    const DISCOUNT_KINDS = ['Early payment discount', 'Family discount (by number of children)', 'Manual discount'];
    const SETUP_TYPES = ['Family discount (by number of children)', 'Early payment discount', 'Other discount', 'Late payment surcharge', 'Other surcharge'];
    // Short courses (Settings > Courses: Has Short Courses YES, or 6 months or less), as Manage Finance > Payments
    const shortOf = course => (course && state.shortCourses.get(course)) || '';
    const termChoices = course => shortOf(course) ? [['SEMESTER 1', `${shortOf(course)} - whole course`]] : state.terms;
    const CHARGE_TYPES = ['ONCE', 'EVERY TERM', 'EVERY YEAR'];
    const LIST_TYPES = ['CLUB', 'SOCIETY', 'SPORTS', 'TRIP', 'TRANSPORT', 'BOARDING', 'OTHER'];
    // The courses of a school (Settings > Courses: Institute); all courses when no school is chosen
    const coursesOf = school => state.courses.filter(c => !school || !courseSchool(c) || same(courseSchool(c), school));
    const listsOf = school => rows('student_lists').filter(l => !school || same(l.school, school));
    const membersOf = listId => rows('list_members').filter(m => m.listId === listId);
    const shownDate = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
    const isFamily = () => !!box('setupType') && /family/i.test(box('setupType').value);
    const isSurcharge = () => !!box('setupType') && /surcharge/i.test(box('setupType').value);

    const state = { tab: 'feeTypes', data: {}, courses: [], schools: [], terms: [], batches: [], classes: [], years: [], shortCourses: new Map(), courseItems: [], students: [], editing: null, find: '' };
    // Settings > Batches of a school (all schools when none is chosen), newest first; short course batches are not offered
    const batchChoices = school => [...new Set(state.batches.filter(b => !school || !b.school || same(b.school, school)).map(b => b.name))];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const same = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
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
    const bankLabel = r => [r.bankName, r.accountNumber].filter(Boolean).join(' - ');

    const TABS = [
        {
            key: 'feeTypes', title: 'Fee Types', store: 'fee_types', save: 'Save fee type',
            note: 'Define the fees the school charges and how each is billed.',
            fields: [
                { name: 'feeName', label: 'Fee Name', type: 'text', required: true, max: 100, placeholder: 'For example Tuition Fee',
                    list: () => names('fee_types', 'feeName') },
                { name: 'appliesTo', label: 'Applies To', type: 'select', options: () => state.courses, placeholder: '-- all courses --' },
                // Typed, with the names used before as suggestions
                { name: 'incomeClass', label: 'Income Class', type: 'text', max: 100, upper: true, placeholder: 'DEFAULT',
                    list: () => [...new Set([...listItems('INCOME CLASS'), ...names('fee_types', 'incomeClass')])] },
                { name: 'account', label: 'Income/Liability Account', type: 'text', max: 100, upper: true,
                    list: () => [...new Set([...listItems('INCOME / LIABILITY ACCOUNT'), ...names('fee_types', 'account')])] },
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
            note: 'Name the discounts the school offers. Set their amounts on Discount Amounts.',
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true, max: 100, placeholder: 'e.g. Staff child bursary' },
                { name: 'kind', label: 'Kind', type: 'select', options: () => DISCOUNT_KINDS },
                { name: 'code', label: 'Code', type: 'text', max: 20, upper: true },
                { name: 'description', label: 'Description', type: 'text', max: 200 },
                { name: 'status', label: 'Status', type: 'select', options: () => STATUS, placeholder: null }
            ],
            columns: [['Name', r => r.name], ['Kind', r => r.kind], ['Code', r => r.code], ['Description', r => r.description],
                ['Active', r => r.status === 'INACTIVE' ? 'NO' : 'YES']],
            sort: (a, b) => String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.name, b.name),
            label: r => r.name,
            uses: { field: 'name', in: [['discount_amounts', 'discountType']] }
        },
        {
            key: 'discountAmounts', title: 'Discount Amounts', store: 'discount_amounts', save: 'Save discount amount',
            note: 'Set how much each discount type takes off a fee, per term and batch.',
            fields: [
                // Choosing the institution narrows the Batch box to its batches
                { name: 'school', label: 'Institution', type: 'select', options: () => state.schools, refill: true },
                { name: 'discountType', label: 'Discount Type', type: 'select', options: () => names('discount_types', 'name'), required: true },
                { name: 'feeType', label: 'Fee', type: 'select', options: () => names('fee_types', 'feeName'), required: true },
                // A short course has no terms and no batch (owner): Term = the whole course (SEMESTER 1), Batch = Academic Year
                { name: 'period', label: 'Term', type: 'select', required: true, options: () => termChoices(box('course') && box('course').value),
                    lockIf: () => !!shortOf(box('course') && box('course').value) },
                { name: 'batch', label: 'Batch', type: 'select', required: true,
                    labelNow: () => shortOf(box('course') && box('course').value) ? 'Academic Year' : 'Batch',
                    options: () => shortOf(box('course') && box('course').value) ? state.years : batchChoices(box('school') ? box('school').value : '') },
                { name: 'calculatedAs', label: 'Amount Type', type: 'select', options: () => CALCULATED, required: true },
                { name: 'value', label: 'Amount', type: 'number', min: 0, max: 10000000, required: true, placeholder: 'e.g. 10' },
                { name: 'remarks', label: 'Remarks', type: 'textarea', max: 500 },
                { name: 'course', label: 'Course', type: 'select', options: () => state.courses, placeholder: '-- all courses --', refill: true }
            ],
            columns: [['Institution', r => r.school || 'All'], ['Discount type', r => r.discountType], ['Fee', r => r.feeType || 'All fees'],
                ['Term', r => shortOf(r.course) ? `${shortOf(r.course)} - whole course` : r.period || 'Every term'],
                ['Batch / Academic Year', r => r.batch], ['Course', r => r.course || 'All courses'],
                ['Amount', r => value(r), true], ['Remarks', r => r.remarks]],
            sort: (a, b) => String(a.batch).localeCompare(String(b.batch)) || String(a.discountType).localeCompare(String(b.discountType))
                || String(a.period).localeCompare(String(b.period), undefined, { numeric: true }),
            same: (a, b) => same(a.school, b.school) && same(a.discountType, b.discountType) && same(a.feeType, b.feeType) && same(a.period, b.period)
                && same(a.batch, b.batch) && same(a.course, b.course),
            label: r => `${r.discountType} (${r.feeType || 'all fees'}, ${r.period || 'every term'}${r.batch ? ', ' + r.batch : ''})`,
            check: r => r.calculatedAs === 'PERCENT' && Number(r.value) > 100 ? 'A percentage cannot be above 100.' : ''
        },
        {
            key: 'discountsSurcharges', title: 'Discounts & Surcharges', store: 'discounts_surcharges', save: 'Save Discount',
            note: 'Set the discounts and surcharges applied to school fees for a term and batch.',
            fields: [
                // Applies To: the fee it is worked out on (ALL FEES = the whole bill)
                { name: 'appliesTo', label: 'Applies To', type: 'select', required: true, options: () => ['ALL FEES', ...names('fee_types', 'feeName')] },
                { name: 'setupType', label: 'Setup Type', type: 'select', required: true, options: () => SETUP_TYPES, refill: true },
                { name: 'name', label: 'Name', type: 'text', required: true, max: 100 },
                { name: 'calculatedAs', label: 'Value Type', type: 'select', options: () => ['PERCENT', 'AMOUNT'], placeholder: null, refill: true },
                { name: 'period', label: 'Term', type: 'select', options: () => state.terms, placeholder: '-- every term --' },
                { name: 'batch', label: 'Batch', type: 'select', options: () => [...batchChoices(''), ...state.years] },
                // The family discount: from the 2nd to the 10th child of a family, for example
                { name: 'fromChild', label: 'From child no.', type: 'number', min: 1, max: 50, placeholder: 'e.g. 2', starIf: () => isFamily() },
                { name: 'toChild', label: 'To child no.', type: 'number', min: 1, max: 50, placeholder: 'e.g. 10', starIf: () => isFamily() },
                { name: 'value', label: 'Discount (%)', type: 'number', min: 0, max: 10000000, required: true, placeholder: 'e.g. 5',
                    labelNow: () => `${isSurcharge() ? 'Surcharge' : 'Discount'} (${box('calculatedAs') && box('calculatedAs').value === 'AMOUNT' ? 'KES' : '%'})` },
                { name: 'cutOffDate', label: 'Cut-off Date', type: 'date' },
                { name: 'classFrom', label: 'Class From', type: 'select', options: () => state.classes, placeholder: '-- all classes --' },
                { name: 'classTo', label: 'Class To', type: 'select', options: () => state.classes, placeholder: '-- all classes --' }
            ],
            columns: [['Setup type', r => r.setupType || r.kind], ['Name', r => r.name], ['Applies to', r => r.appliesTo || r.feeType || 'ALL FEES'],
                ['Term', r => r.period || 'Every term'], ['Batch', r => r.batch || 'All batches'],
                ['Children', r => r.fromChild || r.toChild ? `${r.fromChild || 1} to ${r.toChild || ''}` : ''], ['Value', r => value(r), true],
                ['Cut-off', r => r.cutOffDate ? String(r.cutOffDate).slice(0, 10).split('-').reverse().join('/') : ''],
                ['Classes', r => r.classFrom || r.classTo ? `${r.classFrom || 'YEAR 1'} to ${r.classTo || 'last'}` : 'All classes']],
            sort: (a, b) => String(a.period).localeCompare(String(b.period), undefined, { numeric: true }) || String(a.setupType).localeCompare(String(b.setupType))
                || Number(a.fromChild || 0) - Number(b.fromChild || 0) || String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.setupType, b.setupType) && same(a.name, b.name) && same(a.appliesTo, b.appliesTo) && same(a.period, b.period)
                && same(a.batch, b.batch) && same(a.fromChild, b.fromChild),
            label: r => r.name + (r.period ? ` (${r.period})` : ''),
            // Discount or surcharge follows from the setup type
            derive: r => { r.kind = /surcharge/i.test(r.setupType) ? 'SURCHARGE' : 'DISCOUNT'; },
            check: r => {
                if (r.calculatedAs === 'PERCENT' && Number(r.value) > 100) return 'A percentage cannot be above 100.';
                if (/family/i.test(r.setupType) && (r.fromChild === '' || r.toChild === '')) return 'Please fill in: From child no., To child no.';
                if (r.fromChild !== '' && r.toChild !== '' && Number(r.fromChild) > Number(r.toChild)) return 'From child no. is above To child no.';
                const at = c => state.classes.indexOf(c);
                if (r.classFrom && r.classTo && at(r.classFrom) > at(r.classTo)) return 'Class From is after Class To.';
                return '';
            },
            // Copy previous term's discounts: the term before the chosen Term (same batch when one is chosen)
            button: { label: "Copy previous term's discounts", run: () => copyPreviousTerm() }
        },
        {
            key: 'paymentMethods', title: 'Payment Methods', store: 'payment_methods', save: 'Add Payment Method',
            note: 'Define the payment methods the school accepts.',
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true, max: 60, upper: true, placeholder: 'e.g. MPESA', list: () => DEFAULT_METHODS }
            ],
            columns: [['Payment method', r => r.name]],
            sort: (a, b) => String(a.name).localeCompare(String(b.name)),
            same: (a, b) => same(a.name, b.name),
            label: r => r.name,
            uses: { field: 'name', in: [['school_payment_methods', 'paymentMethod']] }
        },
        {
            key: 'schoolMethods', title: 'School Payment Methods', store: 'school_payment_methods', save: 'Save Payment Methods',
            note: 'Choose a school and bank, then tick the payment methods it accepts.',
            fields: [
                { name: 'school', label: 'School', type: 'select', options: () => state.schools, required: true, refill: true },
                { name: 'bankAccount', label: 'Bank', type: 'select', refill: true,
                    options: () => rows('bank_accounts').filter(r => r.status !== 'INACTIVE' && (!r.school || !box('school') || !box('school').value
                        || same(r.school, box('school').value))).map(bankLabel) }
            ],
            // One row per school, bank and payment method; the ticks below the boxes add and take off rows
            ticks: { field: 'paymentMethod', options: () => names('payment_methods', 'name') },
            columns: [['School', r => r.school], ['Bank', r => r.bankAccount || 'No bank'], ['Payment method', r => r.paymentMethod]],
            sort: (a, b) => String(a.school).localeCompare(String(b.school)) || String(a.bankAccount).localeCompare(String(b.bankAccount))
                || String(a.paymentMethod).localeCompare(String(b.paymentMethod)),
            same: (a, b) => same(a.school, b.school) && same(a.paymentMethod, b.paymentMethod) && same(a.bankAccount, b.bankAccount),
            label: r => `${r.paymentMethod} (${r.school}${r.bankAccount ? ', ' + r.bankAccount : ''})`
        },
        {
            key: 'bankAccounts', title: 'Bank Accounts', store: 'bank_accounts', save: 'Save Bank Details',
            note: "Define the school's bank accounts.",
            fields: [
                { name: 'bankCode', label: 'Bank Code', type: 'text', required: true, max: 40 },
                { name: 'bankName', label: 'Bank Name', type: 'text', required: true, max: 100 },
                { name: 'accountNumber', label: 'Bank Account No', type: 'text', max: 40 },
                { name: 'source', label: 'Source', type: 'text', max: 60, upper: true, placeholder: 'e.g. MPESA',
                    hint: 'The online payment channel that pays into this account, if any.' }
            ],
            columns: [['Bank name', r => r.bankName], ['Bank code', r => r.bankCode], ['Account no', r => r.accountNumber], ['Source', r => r.source],
                ['Currency', r => r.currency]],
            sort: (a, b) => String(a.bankName).localeCompare(String(b.bankName)),
            same: (a, b) => same(a.bankCode, b.bankCode) && same(a.accountNumber, b.accountNumber),
            label: r => r.bankName + (r.accountNumber ? ' ' + r.accountNumber : ''),
            inUse: r => rows('school_payment_methods').some(s => same(s.bankAccount, bankLabel(r)))
        },
        {
            key: 'lists', title: 'Lists', store: 'student_lists', save: 'Save',
            note: 'Create and manage lists of students. The lists of the chosen batch and period are shown below; click the pencil to change one.',
            optionsLabel: 'Self onboard', needFilter: 'school', members: true,
            fields: [
                { name: 'school', label: 'School', type: 'select', required: true, options: () => state.schools, filter: true, refill: true },
                // The courses of the chosen school (owner); empty = every course of the school
                { name: 'course', label: 'Course', type: 'select', placeholder: '-- all courses --', refill: true,
                    options: () => coursesOf(box('school') && box('school').value) },
                { name: 'parent', label: 'Sub-list of', type: 'select', placeholder: '-- none (main list) --',
                    options: () => listsOf(box('school') && box('school').value).filter(l => !l.parent && l.id !== state.editing).map(l => l.title) },
                { name: 'title', label: 'List title', type: 'text', required: true, max: 100, placeholder: 'For example Music club or Mombasa trip' },
                { name: 'charge', label: 'List charge', type: 'number', min: 0, max: 10000000, start: 0 },
                // (a short course student's "batch" is the academic year)
                { name: 'batch', label: 'Batch', type: 'select', required: true, filter: true,
                    labelNow: () => shortOf(box('course') && box('course').value) ? 'Academic Year' : 'Batch',
                    options: () => shortOf(box('course') && box('course').value) ? state.years
                        : [...batchChoices(box('school') ? box('school').value : ''), ...state.years] },
                { name: 'period', label: 'Period', type: 'select', required: true, filter: true,
                    options: () => termChoices(box('course') && box('course').value), lockIf: () => !!shortOf(box('course') && box('course').value) },
                { name: 'publishDate', label: 'Publish date', type: 'date' },
                { name: 'expiryDate', label: 'Expiry date', type: 'date' },
                { name: 'chargeType', label: 'Charge type', type: 'select', options: () => CHARGE_TYPES },
                { name: 'listType', label: 'List type', type: 'select', required: true, options: () => LIST_TYPES },
                { name: 'dependsOn', label: 'Depends on', type: 'select', placeholder: '-- none (independent list) --',
                    options: () => listsOf(box('school') && box('school').value).filter(l => l.id !== state.editing).map(l => l.title) },
                { name: 'description', label: 'Description', type: 'textarea', max: 500, placeholder: 'Shown to parents on the portal; the title is used when left blank' },
                { name: 'selfOnboard', label: 'Students can join from the portal', type: 'check' }
            ],
            columns: [['List title', r => r.title], ['Course', r => r.course || 'All courses'], ['Sub-list of', r => r.parent], ['List type', r => r.listType],
                ['Charge', r => r.charge === '' || r.charge == null ? '' : `KES ${num(r.charge)}`, true], ['Charge type', r => r.chargeType],
                ['Batch', r => r.batch], ['Period', r => shortOf(r.course) ? `${shortOf(r.course)} - whole course` : r.period], ['Publish', r => shownDate(r.publishDate)], ['Expiry', r => shownDate(r.expiryDate)],
                ['Depends on', r => r.dependsOn], ['Self onboard', r => r.selfOnboard === 'Y' ? 'YES' : 'NO'],
                ['Members', r => String(membersOf(r.id).length), true]],
            sort: (a, b) => String(a.parent || a.title).localeCompare(String(b.parent || b.title)) || (a.parent ? 1 : 0) - (b.parent ? 1 : 0)
                || String(a.title).localeCompare(String(b.title)),
            same: (a, b) => same(a.school, b.school) && same(a.course, b.course) && same(a.title, b.title) && same(a.batch, b.batch) && same(a.period, b.period),
            label: r => r.title + (r.course ? ` (${r.course})` : ''),
            check: r => {
                if (r.parent && same(r.parent, r.title)) return 'A list cannot be a sub-list of itself.';
                if (r.course && r.school && courseSchool(r.course) && !same(courseSchool(r.course), r.school)) return `${r.course} is not a course of ${r.school}.`;
                if (r.dependsOn && same(r.dependsOn, r.title)) return 'A list cannot depend on itself.';
                if (r.publishDate && r.expiryDate && r.expiryDate < r.publishDate) return 'The expiry date is before the publish date.';
                return '';
            },
            uses: { field: 'title', in: [['student_lists', 'parent'], ['student_lists', 'dependsOn']] },
            inUse: r => membersOf(r.id).length > 0 || rows('student_lists').some(x => x.id !== r.id && same(x.school, r.school)
                && (same(x.parent, r.title) || same(x.dependsOn, r.title)))
        }
    ];
    const tab = () => TABS.find(t => t.key === state.tab) || TABS[0];

    /* ---------- Reading ---------- */
    async function load() {
        const stores = [...new Set([...TABS.map(t => t.store), 'list_members', 'finance_lists'])];
        const read = key => fewaDB.getOne('settings', key).catch(() => null);
        const [lists, courses, schools, batches, students] = await Promise.all([
            Promise.all(stores.map(s => fewaDB.getAll(s).catch(() => []))), read('courses'), read('schools'), read('batches'),
            fewaDB.getAll('students').catch(() => [])]);
        state.students = Array.isArray(students) ? students : [];
        state.batches = ((batches && batches.items) || [])
            .filter(b => b.name && b.batchType !== 'SHORT COURSE (3 MONTHS)' && !/^DEFAULT GROUP$/i.test(b.name))
            .sort((a, b) => String(b.dateFrom || b.academicYear || '').localeCompare(String(a.dateFrom || a.academicYear || '')));
        stores.forEach((s, i) => { state.data[s] = Array.isArray(lists[i]) ? lists[i] : []; });
        const courseItems = ((courses && courses.items) || []).filter(c => c.enabled !== 'NO' && c.name);
        state.courseItems = courseItems;
        state.courses = courseItems.map(c => c.labelSuffix ? `${c.name} (${c.labelSuffix})` : c.name);
        const isShort = c => String(c.hasShortCourses || '').toUpperCase() === 'YES' || (() => {
            const n = Number(c.duration) || 0, t = String(c.durationType || '').toUpperCase().replace(/S$/, '');
            return n > 0 && ((t === 'MONTH' && n <= 6) || t === 'WEEK' || t === 'DAY'); })();
        state.shortCourses = new Map(courseItems.filter(isShort).map(c => {
            const n = Number(c.duration) || 3, t = String(c.durationType || 'MONTHS').toUpperCase().replace(/S$/, '');
            return [c.labelSuffix ? `${c.name} (${c.labelSuffix})` : c.name, `${n} ${n === 1 ? t : t + 'S'}`];
        }));
        // Academic years (Settings > Batches), newest first: a short course's "batch"
        state.years = [...new Set(((batches && batches.items) || []).map(b => String(b.academicYear || '')).filter(y => /^\d{4}$/.test(y)))]
            .sort((a, b) => b.localeCompare(a));
        state.schools = ((schools && schools.items) || []).map(s => s.name).filter(Boolean);
        // SEMESTER 1..N (N = the longest course: 3 semesters a year), as Manage Finance > Payments
        const semesters = c => { const n = Number(c.duration) || 0, t = String(c.durationType || '').toUpperCase().replace(/S$/, '');
            return t === 'YEAR' ? n * 3 : t === 'MONTH' ? Math.ceil(n / 4) : 1; };
        const most = Math.max(1, ...courseItems.map(semesters));
        state.terms = Array.from({ length: most }, (_, i) => `SEMESTER ${i + 1}`);
        // Classes YEAR 1..N (N = the longest course in years)
        const years = c => { const n = Number(c.duration) || 0, t = String(c.durationType || '').toUpperCase().replace(/S$/, '');
            return t === 'YEAR' ? n : t === 'MONTH' ? Math.ceil(n / 12) : 1; };
        state.classes = Array.from({ length: Math.max(1, ...courseItems.map(years)) }, (_, i) => `YEAR ${i + 1}`);
    }

    /* ---------- Drawing ---------- */
    function draw() {
        const t = tab();
        const input = f => {
            const id = 'fs_' + f.name;
            if (f.type === 'select') return `<select id="${id}"></select>`;
            if (f.type === 'date') return `<input id="${id}" type="date" autocomplete="off">`;
            if (f.type === 'textarea') return `<textarea id="${id}" rows="2" maxlength="${f.max || 500}" placeholder="${esc(f.placeholder || '')}"></textarea>`;
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
                <div class="fs-grid">${plain.map(f => `<label for="fs_${f.name}" id="fsl_${f.name}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${f.hint
                        ? `<div>${input(f)}<small class="fs-hint">${esc(f.hint)}</small></div>` : input(f)}`).join('')}
                    ${checks.length ? `<span class="fs-options-label">${esc(t.optionsLabel || 'Options')}</span><div class="fs-options${checks.length <= 3 ? ' fs-options-row' : ''}">${checks.map(f =>
                        `<label class="fs-check"><input type="checkbox" id="fs_${f.name}"${f.start ? ' checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>` : ''}
                </div>
                ${t.ticks ? '<div class="fs-ticks" id="fsTicks"></div>' : ''}
                <div class="fs-buttons">
                    ${mayChange() ? `<button type="button" class="btn-submit" id="fsSave" onclick="feeSetupSave()">${esc(t.save)}</button>` : ''}
                    <button type="button" class="btn-secondary" onclick="feeSetupClear()">Clear</button>
                    ${t.button && mayChange() ? `<button type="button" class="btn-secondary" onclick="feeSetupButton()">${esc(t.button.label)}</button>` : ''}
                    ${mayChange() ? '' : '<span class="fs-readonly">You can see this list. Changing it needs the right Edit Fee Setup.</span>'}
                </div>
                <div class="fs-listbar"><span id="fsCount"></span>
                    <input type="search" id="fsFind" placeholder="Search this list..." autocomplete="off" value="${esc(state.find)}" data-no-save-question></div>
                <div class="table-wrap"><table class="data-table">
                    <thead><tr><th class="unit-actions"></th>${t.columns.map(([h, , n]) => `<th${n ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
                    <tbody id="fsRows"></tbody></table></div>
                ${t.members ? membersHtml() : ''}
            </div>`;
        fillChoices();
        box(t.fields[0].name).addEventListener('input', fillChoices);
        for (const f of t.fields.filter(f => f.filter)) box(f.name).addEventListener('change', drawList);
        for (const f of t.fields.filter(f => f.refill)) box(f.name).addEventListener('change', fillChoices);
        if (t.members) wireMembers();
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
                el.innerHTML = blank + opts.map(o => { const [v, text] = Array.isArray(o) ? o : [o, o];
                    return `<option value="${esc(v)}">${esc(text)}</option>`; }).join('');
                if (keep && [...el.options].some(o => o.value === keep)) el.value = keep;
                // A box with one possible value (a short course's whole-course term) is filled in and greyed out
                el.disabled = !!(f.lockIf && f.lockIf());
                if (el.disabled) el.value = el.options[el.options.length - 1].value;
            }
            // Labels that follow the other boxes (Discount (%) / Surcharge (KES); * on the child numbers of a family discount)
            const label = document.getElementById('fsl_' + f.name);
            if (label && (f.labelNow || f.starIf)) {
                label.innerHTML = esc(f.labelNow ? f.labelNow() : f.label) + (f.required || (f.starIf && f.starIf()) ? ' <span class="req">*</span>' : '');
            }
            if (f.list && document.getElementById(`fs_${f.name}_list`)) {
                document.getElementById(`fs_${f.name}_list`).innerHTML = f.list().map(v => `<option value="${esc(v)}"></option>`).join('');
            }
        }
        if (tab().ticks) drawTicks();
    }

    // School Payment Methods: the payment methods to tick for the chosen school and bank (ticked = already accepted).
    // Drawn again only when the school or bank changes, so ticks being changed are kept.
    let ticksFor = null;
    function drawTicks() {
        const t = tab(), area = document.getElementById('fsTicks');
        if (!area) return;
        const school = box('school').value, bank = box('bankAccount').value, key = school + '|' + bank;
        if (area.childElementCount && ticksFor === key) return;
        ticksFor = key;
        const methods = t.ticks.options();
        if (!school) { area.innerHTML = '<p class="fin-note">Choose a school to tick the payment methods it accepts.</p>'; return; }
        if (!methods.length) { area.innerHTML = '<p class="fin-note">Add the payment methods on the Payment Methods tab first.</p>'; return; }
        const has = m => rows(t.store).some(r => same(r.school, school) && same(r.bankAccount, bank) && same(r[t.ticks.field], m));
        area.innerHTML = `<span class="fs-options-label">Payment methods</span><div class="fs-options">${methods.map(m =>
            `<label class="fs-check"><input type="checkbox" data-method="${esc(m)}"${has(m) ? ' checked' : ''}> ${esc(m)}</label>`).join('')}</div>`;
    }

    async function saveTicks(t) {
        const school = box('school').value, bank = box('bankAccount').value;
        if (!school) return alert('Please fill in: School.');
        const chosen = [...document.querySelectorAll('#fsTicks [data-method]')].filter(c => c.checked).map(c => c.dataset.method);
        const existing = rows(t.store).filter(r => same(r.school, school) && same(r.bankAccount, bank));
        const add = chosen.filter(m => !existing.some(r => same(r[t.ticks.field], m)));
        const off = existing.filter(r => !chosen.some(m => same(r[t.ticks.field], m)));
        if (!add.length && !off.length) return alert('Nothing was changed: tick or untick a payment method first.');
        const parts = [add.length ? `${add.length} added` : '', off.length ? `${off.length} taken off` : ''].filter(Boolean).join(', ');
        if (!await fewaConfirm(`Save the payment methods of ${school}${bank ? ' (' + bank + ')' : ''}? ${parts}.`)) return;
        try {
            for (const m of add) await fewaDB.put(t.store, { school, bankAccount: bank, [t.ticks.field]: m, status: 'ACTIVE', id: newId(),
                updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' });
            for (const r of off) await fewaDB.remove(t.store, r.id);
            showToast(`Payment methods of ${school} saved.`);
            ticksFor = null;
            await load();
            drawList();
            drawTicks();
        } catch (err) { alert('It could not be saved: ' + err.message); }
    }

    function drawList() {
        const t = tab();
        const filters = t.fields.filter(f => f.filter).map(f => [f, box(f.name).value]).filter(([, v]) => v);
        if (t.needFilter && !box(t.needFilter).value) {
            document.getElementById('fsCount').textContent = '';
            document.getElementById('fsRows').innerHTML = `<tr class="empty-row"><td colspan="${t.columns.length + 1}">Choose the ${esc(t.needFilter)} to see its lists.</td></tr>`;
            return;
        }
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
        if (t.derive) t.derive(record);
        const problem = t.check ? t.check(record) : '';
        if (problem) throw new Error(problem);
        return record;
    }

    async function save() {
        if (!allowed('finance', 'setup')) return;
        const t = tab();
        if (t.ticks) return saveTicks(t);
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
            const kept = t.fields.filter(f => f.filter || f.refill).map(f => [f.name, box(f.name).value]);
            await load();
            draw();
            if (t.fields.some(f => f.filter)) { for (const [n, v] of kept) { fillChoices(); box(n).value = v; } fillChoices(); drawList(); }
        } catch (err) { alert('It could not be saved: ' + err.message); }
    }

    function edit(id) {
        const t = tab();
        const r = rows(t.store).find(x => x.id === id);
        if (!r) return;
        if (t.ticks) {
            box('school').value = r.school || ''; fillChoices();
            if (r.bankAccount && ![...box('bankAccount').options].some(o => o.value === r.bankAccount)) box('bankAccount').add(new Option(r.bankAccount, r.bankAccount));
            box('bankAccount').value = r.bankAccount || ''; ticksFor = null; fillChoices();
            box('school').scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
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

    // Discounts & Surcharges: copies the entries of the term before the chosen Term to it (of the chosen batch, if any);
    // entries already there are left as they are
    async function copyPreviousTerm() {
        if (!allowed('finance', 'setup')) return;
        const t = tab(), to = box('period').value, batch = box('batch').value;
        if (!to) return alert('Choose the Term to copy the discounts to (the term before it is copied).');
        const at = state.terms.indexOf(to);
        if (at < 1) return alert(`${to} is the first term: there is no term before it to copy from.`);
        const from = state.terms[at - 1];
        const source = rows(t.store).filter(r => same(r.period, from) && (!batch || same(r.batch, batch)));
        if (!source.length) return alert(`There are no discounts or surcharges for ${from}${batch ? ' in ' + batch : ''} to copy.`);
        const copies = source.map(r => ({ ...r, period: to })).filter(c => !rows(t.store).some(r => t.same(r, c)));
        if (!copies.length) return alert(`Every entry of ${from} is already in ${to}.`);
        if (!await fewaConfirm(`Copy ${copies.length} ${copies.length === 1 ? 'entry' : 'entries'} from ${from} to ${to}${batch ? ' (' + batch + ')' : ''}?`, { yes: 'Yes, copy' })) return;
        try {
            for (const c of copies) await fewaDB.put(t.store, { ...c, id: newId(), updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' });
            showToast(`${copies.length} ${copies.length === 1 ? 'entry' : 'entries'} copied to ${to}.`);
            await load();
            draw();
        } catch (err) { alert('Not everything could be copied: ' + err.message); await load(); draw(); }
    }

    /* ---------- Lists > List Members ----------
       Choose the school, batch, period and list, then a class (= a course of that school) and stream (= study session):
       the class's learners are listed with a tick (ticked = on the list). Save List Members saves only the ticks changed.
       Members can also be copied from another list, or uploaded from Excel (one learner per row). A list that "depends on"
       another list only takes learners who are on that list. */
    const lm = name => document.getElementById('lm_' + name);
    const courseSchool = course => { const c = state.courseItems.find(x => (x.labelSuffix ? `${x.name} (${x.labelSuffix})` : x.name) === course);
        return c ? String(c.institute || '') : ''; }; // (institute = the school; institution = the college)
    const studentName = s => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
    const chosenList = () => rows('student_lists').find(l => l.id === (lm('list') ? lm('list').value : ''));
    // A learner may join the chosen list (the list it depends on must have them); '' = yes, otherwise why not
    function joinProblem(list, student) {
        if (!list || !list.dependsOn) return '';
        const parent = rows('student_lists').find(l => same(l.school, list.school) && same(l.title, list.dependsOn)
            && same(l.batch, list.batch) && same(l.period, list.period)) || rows('student_lists').find(l => same(l.school, list.school) && same(l.title, list.dependsOn));
        return parent && membersOf(parent.id).some(m => m.studentId === student.id) ? '' : `Not on ${list.dependsOn}`;
    }

    function membersHtml() {
        const sel = (name, label, req) => `<label for="lm_${name}">${esc(label)}${req ? ' <span class="req">*</span>' : ''}</label><select id="lm_${name}"></select>`;
        return `<div class="fs-members">
            <h3 class="fs-subtitle">List Members</h3>
            <div class="fs-info">Choose the list, then a class; tick the learners on the list and save. Only the learners you change are saved.</div>
            <div class="fs-grid">${sel('school', 'School', true)}${sel('batch', 'Batch', true)}${sel('period', 'Period', true)}${sel('list', 'List', true)}
                ${sel('class', 'Class', true)}${sel('stream', 'Stream')}</div>
            <div class="fs-buttons">
                ${mayChange() ? '<button type="button" class="btn-submit" onclick="feeSetupMembersSave()">Save List Members</button>' : ''}
                <button type="button" class="btn-secondary" onclick="feeSetupMembersView()">View List</button>
            </div>
            ${mayChange() ? `<div class="fs-section"><h3 class="fs-subtitle fs-small">Copy members from another list</h3>
            <div class="fs-copy"><label for="lm_copyFrom">Copy from</label><select id="lm_copyFrom"></select>
                <button type="button" class="btn-secondary" onclick="feeSetupMembersCopy()">Copy Members</button></div>
            <div class="up-box fs-upload">
                <div class="up-template">
                    <svg class="up-excel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 12.5l5 6M13.5 12.5l-5 6"/></svg>
                    <div class="up-template-text"><b>Excel template</b><span>One learner per row: school code, admission number, name, class.</span></div>
                    <div class="up-template-buttons"><button type="button" class="btn-secondary" onclick="feeSetupMembersTemplate()">Download</button></div>
                </div>
                <label class="up-drop" for="lm_file">
                    <svg class="up-cloud" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor"
                        d="M19.4 10.1A7 7 0 0 0 6.1 8.6 5.5 5.5 0 0 0 6.5 19.5h12.3a4.7 4.7 0 0 0 .6-9.4zM13 13v4h-2v-4H8l4-4 4 4z"/></svg>
                    <span class="up-choose" id="lm_chosen">Choose the list members spreadsheet</span>
                    <input type="file" id="lm_file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
                </label>
                <div class="up-limits"><span>Supported formats: XLS, XLSX</span><span>Max size: 10 MB</span></div>
                <div class="up-submit"><span class="fs-hint">The learners are added to the list chosen above.</span>
                    <button type="button" class="btn-submit" onclick="feeSetupMembersUpload()">Upload List Members</button></div>
            </div></div>` : ''}
            <div id="lm_result"></div>
            <div class="fs-section"><h3 class="fs-subtitle fs-small">Learners</h3>
            <div id="lm_learners"><p class="fin-note">Choose the list and the class to tick its learners.</p></div></div>
        </div>`;
    }

    function fillMembers() {
        const put = (name, values, blank) => {
            const el = lm(name); if (!el) return;
            const keep = el.value;
            el.innerHTML = (blank === null ? '' : `<option value="">${esc(blank || '-- select one --')}</option>`) +
                values.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}">${esc(t)}</option>`; }).join('');
            if (keep && [...el.options].some(o => o.value === keep)) el.value = keep;
        };
        const school = lm('school').value;
        put('school', state.schools);
        put('batch', [...batchChoices(school), ...state.years]);
        put('period', state.terms);
        const lists = rows('student_lists').filter(l => (!school || same(l.school, school)) && (!lm('batch').value || same(l.batch, lm('batch').value))
            && (!lm('period').value || same(l.period, lm('period').value)));
        put('list', lists.map(l => [l.id, l.parent ? `${l.parent} > ${l.title}` : l.title]));
        const list = chosenList();
        put('class', list && list.course ? [list.course] : coursesOf(school));
        if (list && list.course) lm('class').value = list.course;
        put('stream', [...new Set(state.students.map(s => s.studySession).filter(Boolean))].sort(), '-- all streams --');
        if (lm('copyFrom')) put('copyFrom', rows('student_lists').filter(l => l.id !== lm('list').value && (!school || same(l.school, school)))
            .map(l => [l.id, `${l.title} (${l.batch}, ${l.period}) - ${membersOf(l.id).length} members`]));
    }

    function wireMembers() {
        state.membersShown = 'learners';
        fillMembers();
        for (const name of ['school', 'batch', 'period', 'list', 'class', 'stream']) lm(name).addEventListener('change', () => { fillMembers(); drawLearners(); });
        if (lm('file')) {
            const drop = lm('file').closest('.up-drop');
            const chosen = () => { const f = lm('file').files[0]; lm('chosen').textContent = f ? f.name : 'Choose the list members spreadsheet'; drop.classList.toggle('has-file', !!f); };
            lm('file').addEventListener('change', chosen);
            // A file can also be dragged onto the box
            drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
            drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragging'); if (e.dataTransfer.files.length) { lm('file').files = e.dataTransfer.files; chosen(); } });
        }
    }

    // The learners of the chosen class, batch and stream, ticked when on the chosen list
    function drawLearners() {
        const area = lm('learners'), list = chosenList(), course = lm('class').value;
        if (!list || !course) { area.innerHTML = '<p class="fin-note">Choose the list and the class to tick its learners.</p>'; return; }
        const stream = lm('stream').value, batch = lm('batch').value;
        const learners = state.students.filter(s => String(s.activeStudent || 'yes').toLowerCase() !== 'no' && s.admissionCourse === course
            && (!batch || same(s.group, batch)) && (!stream || same(s.studySession, stream)))
            .sort((a, b) => String(a.admNo).localeCompare(String(b.admNo), undefined, { numeric: true }));
        if (!learners.length) { area.innerHTML = `<p class="fin-note">No active learners of ${esc(course)}${batch ? ' in ' + esc(batch) : ''}${stream ? ' (' + esc(stream) + ')' : ''}.</p>`; return; }
        const on = new Set(membersOf(list.id).map(m => m.studentId));
        area.innerHTML = `<div class="units-count">${learners.length} learner${learners.length === 1 ? '' : 's'}, ${learners.filter(s => on.has(s.id)).length} on ${esc(list.title)}.
                <button type="button" class="link-button" onclick="feeSetupMembersAll(true)">Tick all</button> <button type="button" class="link-button" onclick="feeSetupMembersAll(false)">Untick all</button></div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th class="unit-actions">On list</th><th>Admission No</th><th>Name</th><th>Class</th><th>Stream</th><th></th></tr></thead>
            <tbody>${learners.map(s => { const why = on.has(s.id) ? '' : joinProblem(list, s);
                return `<tr><td class="unit-actions"><input type="checkbox" data-student="${esc(s.id)}"${on.has(s.id) ? ' checked' : ''}${why || !mayChange() ? ' disabled' : ''}></td>
                <td>${esc(s.admNo)}</td><td>${esc(studentName(s))}</td><td>${esc(s.admissionCourse)}</td><td>${esc(s.studySession || '')}</td><td class="fin-bad">${esc(why)}</td></tr>`; }).join('')}</tbody></table></div>`;
    }

    const memberRecord = (list, s) => ({ id: newId(), listId: list.id, listTitle: list.title, studentId: s.id, admNo: s.admNo || '',
        studentName: studentName(s), course: s.admissionCourse || '', updatedAt: new Date().toISOString(), updatedBy: currentUser() || '' });

    async function saveMembers() {
        if (!allowed('finance', 'setup')) return;
        const list = chosenList();
        if (!list) return alert('Please fill in: School, Batch, Period, List.');
        const boxes = [...document.querySelectorAll('#lm_learners [data-student]')];
        if (!boxes.length) return alert('Choose the class whose learners to tick.');
        const members = membersOf(list.id);
        const add = boxes.filter(b => b.checked && !members.some(m => m.studentId === b.dataset.student)).map(b => state.students.find(s => s.id === b.dataset.student));
        const off = members.filter(m => boxes.some(b => !b.checked && b.dataset.student === m.studentId));
        if (!add.length && !off.length) return alert('Nothing was changed: tick or untick a learner first.');
        const parts = [add.length ? `${add.length} added` : '', off.length ? `${off.length} taken off` : ''].filter(Boolean).join(', ');
        if (!await fewaConfirm(`Save the members of ${list.title}? ${parts}.`)) return;
        try {
            for (const s of add) await fewaDB.put('list_members', memberRecord(list, s));
            for (const m of off) await fewaDB.remove('list_members', m.id);
            showToast(`Members of ${list.title} saved.`);
            await load(); fillMembers(); drawList(); drawLearners();
        } catch (err) { alert('It could not be saved: ' + err.message); await load(); drawLearners(); }
    }

    function viewMembers() {
        const list = chosenList();
        if (!list) return alert('Choose the list to view (School, Batch, Period, List).');
        const members = membersOf(list.id).sort((a, b) => String(a.admNo).localeCompare(String(b.admNo), undefined, { numeric: true }));
        lm('learners').innerHTML = `<div class="units-count">${members.length} member${members.length === 1 ? '' : 's'} on ${esc(list.title)} (${esc(list.batch)}, ${esc(list.period)}).</div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th>Admission No</th><th>Name</th><th>Class</th><th>Added by</th></tr></thead>
            <tbody>${members.map(m => `<tr><td>${esc(m.admNo)}</td><td>${esc(m.studentName)}</td><td>${esc(m.course)}</td><td>${esc(m.updatedBy || '')}</td></tr>`).join('')
                || '<tr class="empty-row"><td colspan="4">Nobody is on this list yet.</td></tr>'}</tbody></table></div>`;
    }

    async function copyMembers() {
        if (!allowed('finance', 'setup')) return;
        const list = chosenList(), from = rows('student_lists').find(l => l.id === lm('copyFrom').value);
        if (!list) return alert('Choose the list to copy the members to (School, Batch, Period, List).');
        if (!from) return alert('Choose the list to copy the members from.');
        const on = new Set(membersOf(list.id).map(m => m.studentId));
        const students = membersOf(from.id).map(m => state.students.find(s => s.id === m.studentId)).filter(Boolean).filter(s => !on.has(s.id));
        const fit = students.filter(s => !joinProblem(list, s)), left = students.length - fit.length;
        if (!fit.length) return alert(students.length ? `None of them can join: they are not on ${list.dependsOn}.` : `Everyone on ${from.title} is already on ${list.title}.`);
        if (!await fewaConfirm(`Copy ${fit.length} member${fit.length === 1 ? '' : 's'} from ${from.title} to ${list.title}?` + (left ? ` (${left} not on ${list.dependsOn} are left out.)` : ''), { yes: 'Yes, copy' })) return;
        try {
            for (const s of fit) await fewaDB.put('list_members', memberRecord(list, s));
            showToast(`${fit.length} member${fit.length === 1 ? '' : 's'} copied to ${list.title}.`);
            await load(); fillMembers(); drawList(); drawLearners();
        } catch (err) { alert('Not every member could be copied: ' + err.message); await load(); drawLearners(); }
    }

    const MEMBERS_FILE = 'list-members-template.xlsx';
    const MEMBER_HEADERS = ['Admission No', 'Name', 'Class'];
    function membersTemplate() {
        FewaExcel.template(MEMBERS_FILE, [
            { title: 'School code', field: 'School code', help: "The school's code (for you only: the admission number decides who is added)" },
            { title: 'Admission No', field: 'Admission No', required: true, help: "The learner's admission number, e.g. HD01/001/2026" },
            { title: 'Name', field: 'Name', help: 'For you only: the admission number decides who is added' },
            { title: 'Class', field: 'Class', help: 'For you only (the course)' }], 'List members').catch(err => alert(err.message));
    }

    async function uploadMembers() {
        if (!allowed('finance', 'setup')) return;
        const list = chosenList(), f = lm('file').files[0];
        if (!list) return alert('Choose the list first (School, Batch, Period, List): the learners are added to it.');
        if (!f) return alert('Choose the filled-in Excel file first.');
        if (f.size > 10 * 1024 * 1024) return alert('The file is larger than 10 MB.');
        let rowsIn;
        try {
            const XLSX = await FewaExcel.loadXlsx();
            const book = XLSX.read(await f.arrayBuffer(), { type: 'array' });
            const wrong = FewaExcel.templateProblem(book, MEMBERS_FILE);
            if (wrong) return alert(wrong);
            rowsIn = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', raw: false }).map(r => r.map(c => String(c).trim()));
        } catch { return alert('The file could not be read. Save it as .xlsx from Excel and try again.'); }
        const header = (rowsIn[0] || []).map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
        const at = header.findIndex(h => h.startsWith('admission'));
        if (at < 0) return alert('The first row must hold the headings. Download the template to see them.');
        const on = new Set(membersOf(list.id).map(m => m.studentId)), seen = new Set();
        const lines = rowsIn.slice(1).filter(r => r.some(Boolean)).map(r => {
            const adm = r[at] || '', s = state.students.find(x => same(x.admNo, adm));
            let note = !adm ? 'No admission number' : !s ? 'No learner with this admission number'
                : list.school && courseSchool(s.admissionCourse) && !same(courseSchool(s.admissionCourse), list.school) ? `Not in ${list.school}`
                : on.has(s.id) ? 'Already on the list' : seen.has(s.id) ? 'The same as a row above' : joinProblem(list, s);
            if (s) seen.add(s.id);
            return { r, s, note, ok: !note };
        });
        if (!lines.length) return alert('The file has no rows under the headings.');
        const good = lines.filter(l => l.ok);
        const show = () => { lm('result').innerHTML = `<div class="units-count">${lines.length} row${lines.length === 1 ? '' : 's'}: ${lines.filter(l => l.done).length} added.</div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th>Row</th><th>Admission No</th><th>Name</th><th>Result</th></tr></thead><tbody>${lines.map((l, i) =>
                `<tr><td>${i + 2}</td><td>${esc(l.r[at])}</td><td>${esc(l.s ? studentName(l.s) : '')}</td><td class="${l.done ? 'units-result-ok' : l.ok ? 'units-result-warn' : 'units-result-bad'}">${esc(l.done ? 'Added' : l.note || 'OK')}</td></tr>`).join('')}</tbody></table></div>`; };
        show();
        const feedback = () => FewaExcel.feedback(f.name, rowsIn[0] || [], lines.map(l => l.r), lines.map(l => l.done ? { ok: true, text: 'Added' } : { ok: false, text: 'NOT added: ' + (l.note || 'cancelled') }), MEMBERS_FILE);
        if (!good.length) { feedback(); return alert('No learner in the file can be added. The table shows why for each row.'); }
        if (!await fewaConfirm(`Add ${good.length} learner${good.length === 1 ? '' : 's'} to ${list.title}?` + (lines.length > good.length ? ` (${lines.length - good.length} row${lines.length - good.length === 1 ? '' : 's'} cannot be added.)` : ''), { yes: 'Yes, add' })) return;
        try {
            for (const l of good) { await fewaDB.put('list_members', memberRecord(list, l.s)); l.done = true; }
            showToast(`${good.length} learner${good.length === 1 ? '' : 's'} added to ${list.title}.`);
        } catch (err) { alert('Not every learner could be added: ' + err.message); }
        feedback(); show();
        lm('file').value = ''; lm('chosen').textContent = 'Choose the list members spreadsheet'; lm('file').closest('.up-drop').classList.remove('has-file');
        await load(); fillMembers(); drawList(); drawLearners();
    }

    const newId = () => 'fs-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    window.feeSetupTab = key => { state.tab = key; state.editing = null; state.find = ''; ticksFor = null; draw(); };
    window.feeSetupSave = save;
    window.feeSetupMembersSave = saveMembers;
    window.feeSetupMembersView = viewMembers;
    window.feeSetupMembersCopy = copyMembers;
    window.feeSetupMembersTemplate = membersTemplate;
    window.feeSetupMembersUpload = uploadMembers;
    window.feeSetupMembersAll = on => document.querySelectorAll('#lm_learners [data-student]:not(:disabled)').forEach(b => { b.checked = on; });
    window.feeSetupButton = () => tab().button && tab().button.run();
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
