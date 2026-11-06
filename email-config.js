/* ---------- EmailJS settings ----------
   Used to email the administrator after the account is created on the first login,
   and to email the one-time passcode (OTP) for "Login with OTP".
   Fill these in from your free account at https://www.emailjs.com:
     serviceId     - Email Services page, e.g. "service_abc123"
     templateId    - Email Templates page, e.g. "template_xyz789" (the "account created" email)
     otpTemplateId - a second template for the OTP email; leave empty to use templateId for both
     resetTemplateId - a template for the "forgot password" email; leave empty to use templateId
     publicKey     - Account > General, e.g. "AbCdEf123456"
   While serviceId, templateId or publicKey is empty, no email is sent and the login page says so. */
// The college's EmailJS account: an Outlook service ("fewa"), one template for every email ({{message}}),
// replies going to admin@fewa.ac.ke. These three are public by design (they are in every page anyway).
const EMAILJS_CONFIG = {
    serviceId: 'service_7fjcvqo',
    templateId: 'template_l4go4uc',
    otpTemplateId: '',
    resetTemplateId: '',
    publicKey: 'tyVpXI39InZKyqudl'
};

const COLLEGE_NAME = 'FEWA Beauty & Fashion College';

function isEmailConfigured() {
    const { serviceId, templateId, publicKey } = EMAILJS_CONFIG;
    return !!(serviceId && templateId && publicKey);
}

// Sends one email through EmailJS; resolves to true when EmailJS accepted it
async function sendEmail(templateId, params) {
    if (!isEmailConfigured()) return false;
    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: EMAILJS_CONFIG.serviceId,
                template_id: templateId,
                user_id: EMAILJS_CONFIG.publicKey,
                template_params: { college_name: COLLEGE_NAME, login_time: new Date().toLocaleString(), ...params }
            })
        });
        return response.ok;
    } catch {
        return false;
    }
}

// Sent after every successful login, to the username (email) that was used to log in
function sendLoginEmail(email, { firstTime, method }) {
    const when = new Date().toLocaleString();
    return sendEmail(EMAILJS_CONFIG.templateId, {
        to_email: email,
        message: firstTime
            ? `Your FEWA system administrator account was created and you logged in successfully on ${when}.`
            : `You logged in to the FEWA system successfully on ${when} using ${method}. ` +
              'If this was not you, change your password immediately.'
    });
}

// newStaff: the first email a new staff member gets, inviting them to set their password
function sendResetEmail(email, code, link, validMinutes, { newStaff = false, name = '' } = {}) {
    const expiry = validMinutes >= 60 ? `${Math.round(validMinutes / 60)} hours` : `${validMinutes} minutes`;
    return sendEmail(EMAILJS_CONFIG.resetTemplateId || EMAILJS_CONFIG.templateId, {
        to_email: email,
        to_name: name,
        reset_code: code,
        reset_link: link,
        message: newStaff
            ? `Hello ${name}, a FEWA system staff account has been created for you. Your username is ${email}. ` +
              `To set your password, open this link: ${link} or enter the code ${code} on the login page ` +
              `under "Forgot password?". The link and code expire in ${expiry}.`
            : `A password reset was requested for your FEWA system account. ` +
              `Your reset code is ${code}. Open this link to set a new password: ${link} ` +
              `The code and link expire in ${expiry}. If you did not ask for this, ignore this email.`
    });
}

// A student's new temporary password (from "Reset Password" on their record); they choose their own at login
function sendStudentPasswordEmail(email, { name, admNo, password, link }) {
    return sendEmail(EMAILJS_CONFIG.resetTemplateId || EMAILJS_CONFIG.templateId, {
        to_email: email,
        to_name: name,
        reset_code: password,
        reset_link: link,
        message: `Hello ${name}, your FEWA student portal password has been reset. ` +
            `Log in at ${link} with your AdmNo ${admNo} and the temporary password ${password}. ` +
            'You will be asked to choose your own password when you log in.'
    });
}

function sendOtpEmail(email, code, validMinutes) {
    return sendEmail(EMAILJS_CONFIG.otpTemplateId || EMAILJS_CONFIG.templateId, {
        to_email: email,
        otp_code: code,
        message: `Your FEWA system login code is ${code}. It expires in ${validMinutes} minutes. ` +
            'If you did not try to log in, ignore this email.'
    });
}
