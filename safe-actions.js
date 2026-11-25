/* =====================================================================================================
   Safe actions (user's wish): nothing is saved, edited or deleted by pressing a key on the keyboard. Only a
   click (or a tap on a phone) on the system's own Save / Edit / Delete buttons does it, and every save and
   every delete is asked first in the system's own box, whose Yes button also has to be clicked.

   - Enter in a box of a form does not send the form (except the search / report boxes in ENTER_OK).
   - Enter or Space on a Save, Edit, Delete (and similar) button does nothing.
   - A form that saves asks "Save ...?" before it is sent (except the forms in NO_SAVE_QUESTION, which only
     search, download or already ask their own question).
   - The buttons in ASK_BEFORE (saves that are not forms) ask too.
   - fewaConfirm(message) is the question box: Yes only by a click, Cancel by a click or the Esc key. It replaces
     the browser's own confirm() box, where pressing Enter means Yes.
   ===================================================================================================== */
(function () {
    // Forms that do not save anything, or that already ask their own question before saving
    const NO_SAVE_QUESTION = [
        '[data-no-save-question]',
        '#studentOptionsForm',        // Student Hub: picks the student to open
        '.excel-form',                // Excel reports: downloads a report
        '.backup-download',           // downloads a backup (password-protected zip)
        '.sp-search',                 // Student Portal search
        '#gateForm',                  // Global Settings password
        '.reset-backdrop form',       // the Activate / Deactivate box is itself the question
        '[data-form="pay"]',          // Manage Finance: a payment asks its own question
        '[data-form="post"]',         // Manage Finance: shows what would be posted first
        '[data-form="payments"]',     // Manage Finance: a list filter
        '.fewa-ask form'
    ].join(',');

    // Forms where Enter still works, because they only search or download
    const ENTER_OK = '.sp-search, #gateForm, .excel-form, [data-form="payments"]';

    // Buttons that save without a form, and whose page does not ask first
    const ASK_BEFORE = /^\s*(addOffer|saveRegistration|saveUnitHours|saveSchedule|saveRegister|saveExamRecord|saveInlineRow|uploadBulkPhotos|enquiryUploadDocument)\(/;

    // Words that make a button a "doing" button (kept from the keyboard)
    const ACTION_WORDS = /\b(save|saving|delete|remove|edit|update|upload|post|register|restore|reset|activate|deactivate|reactivate|replace|import|create|apply|approve|submit|add|allocate|record|take off|mark)\b/i;

    let openAsk = null;

    function fewaConfirm(message, options = {}) {
        if (openAsk) openAsk.close(false);
        const danger = options.danger ?? /\b(delete|remove|take .* off|deactivate|restore|reset)\b/i.test(message);
        const yesText = options.yes || (danger
            ? (/\bremove\b/i.test(message) ? 'Yes, remove' : /\bdeactivate\b/i.test(message) ? 'Yes, deactivate'
                : /\brestore\b/i.test(message) ? 'Yes, restore' : /\breset\b/i.test(message) ? 'Yes, reset'
                : /\btake .* off\b/i.test(message) ? 'Yes, take it off' : 'Yes, delete')
            : (/^\s*save\b/i.test(message) ? 'Yes, save' : 'Yes'));
        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'fewa-ask';
            back.innerHTML = `
                <div class="fewa-ask-box${danger ? ' is-danger' : ''}" role="alertdialog" aria-modal="true" tabindex="-1">
                    <div class="fewa-ask-icon" aria-hidden="true">${danger
                        ? '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>'
                        : '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/></svg>'}</div>
                    <div class="fewa-ask-text"></div>
                    <div class="fewa-ask-hint">Click a button to answer (the keyboard cannot answer this).</div>
                    <div class="fewa-ask-buttons">
                        <button type="button" class="fewa-ask-no">Cancel</button>
                        <button type="button" class="fewa-ask-yes"></button>
                    </div>
                </div>`;
            back.querySelector('.fewa-ask-text').textContent = message;
            back.querySelector('.fewa-ask-yes').textContent = yesText;
            const close = answer => {
                if (!back.isConnected) return;
                back.remove();
                openAsk = null;
                resolve(answer);
            };
            // Yes only by a real click or tap (a key press on a button gives a click with detail 0)
            back.querySelector('.fewa-ask-yes').addEventListener('click', event => { if (event.detail > 0) close(true); });
            back.querySelector('.fewa-ask-no').addEventListener('click', () => close(false));
            document.body.appendChild(back);
            openAsk = { close };
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            back.querySelector('.fewa-ask-box').focus();
        });
    }
    window.fewaConfirm = fewaConfirm;

    const isActionButton = el => {
        if (!el) return false;
        if (el.matches('button[type="submit"], input[type="submit"]') || (el.matches('button:not([type])') && el.form)) {
            return !el.form || !el.form.matches(ENTER_OK);
        }
        if (!el.matches('button, input[type="button"], a[onclick], [role="button"], [data-act]')) return false;
        const words = [el.textContent, el.value, el.title, el.getAttribute('aria-label'), el.getAttribute('onclick'),
            el.dataset.act, el.className].filter(Boolean).join(' ');
        return ACTION_WORDS.test(words.replace(/([a-z])([A-Z])/g, '$1 $2'));
    };

    // The keyboard: while the question box is open only Esc works (Cancel); Enter in a form box does not send it;
    // Enter / Space on a doing button does nothing
    const onKey = event => {
        if (openAsk) {
            if (event.key === 'Escape' && event.type === 'keydown') openAsk.close(false);
            if (event.key !== 'Tab') { event.preventDefault(); event.stopPropagation(); }
            return;
        }
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        const el = event.target;
        if (!(el instanceof Element)) return;
        if (event.key === 'Enter' && el.matches('input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select')
            && el.form && !el.form.matches(ENTER_OK)) {
            event.preventDefault(); // stops the form being sent; the box's own Enter search (if any) still runs
            return;
        }
        if (isActionButton(el.closest('button, input, a, [role="button"], [data-act]'))) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);

    // A save form asks first; Yes sends it again (once) exactly as clicked
    document.addEventListener('submit', event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || form.matches(NO_SAVE_QUESTION)) return;
        if (form.dataset.fewaAsked === 'yes') { delete form.dataset.fewaAsked; return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        const submitter = event.submitter;
        const label = (submitter && (submitter.textContent || submitter.value) || '').trim();
        const question = /^(save|update)\b/i.test(label) ? `${label.replace(/\s+/g, ' ')}?` : 'Save these details?';
        fewaConfirm(/^save/i.test(question) ? question : 'Save: ' + question).then(yes => {
            if (!yes) return;
            form.dataset.fewaAsked = 'yes';
            if (submitter && submitter.isConnected && form.requestSubmit) form.requestSubmit(submitter);
            else if (form.requestSubmit) form.requestSubmit();
            else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            setTimeout(() => { delete form.dataset.fewaAsked; }, 0);
        });
    }, true);

    // Save buttons that are not in a form ask first too
    document.addEventListener('click', event => {
        const button = event.target instanceof Element && event.target.closest('[onclick]');
        if (!button || !ASK_BEFORE.test(button.getAttribute('onclick') || '')) return;
        if (button.dataset.fewaAsked === 'yes') { delete button.dataset.fewaAsked; return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        const label = (button.textContent || '').trim().replace(/\s+/g, ' ') || 'Save';
        fewaConfirm(/^save/i.test(label) ? `${label}?` : `Save: ${label}?`).then(yes => {
            if (!yes || !button.isConnected) return;
            button.dataset.fewaAsked = 'yes';
            button.click();
        });
    }, true);
})();
