/* ---------- Email settings ----------
   The college's EmailJS account: an Outlook service ("fewa"), one template for every email ({{message}}), replies
   going to admin@fewa.ac.ke. Every email is written and sent by the server (server.mjs reads these three values from
   this file); a page can only ask for one of the system's own emails. The account is protected by its private key,
   which is never in this file (see "Emails" in server.mjs).
   While serviceId, templateId or publicKey is empty, no email is sent and the pages say so. */
const EMAILJS_CONFIG = {
    serviceId: 'service_7fjcvqo',
    templateId: 'template_l4go4uc',
    publicKey: 'tyVpXI39InZKyqudl'
};

function isEmailConfigured() {
    const { serviceId, templateId, publicKey } = EMAILJS_CONFIG;
    return !!(serviceId && templateId && publicKey);
}

// Sent after a staff member logs in, to the email they logged in with; resolves to true when it was accepted
async function sendLoginEmail(firstTime) {
    try {
        return (await api('POST', '/login-notice', { firstTime })).sent;
    } catch {
        return false;
    }
}

// A student's login details: kind 'welcome' (newly admitted) or 'reset' (Reset Password). Goes to the email on their
// record; resolves to true when it was accepted
async function sendStudentLoginEmail(studentId, kind, password) {
    try {
        return (await api('POST', '/student-email', { studentId, kind, password })).result === 'sent';
    } catch {
        return false;
    }
}

// The address students open the Student Portal from: the online system (a localhost link only works on the
// office computer itself)
function studentLoginLink() {
    return /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
        ? 'https://fewa-system.onrender.com/login.html'
        : new URL('login.html', location.href).href.split(/[?#]/)[0];
}
