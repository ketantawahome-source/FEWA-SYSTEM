/* ---------- WhatsApp messages sent by the server ---------- */
import { randomBytes } from 'node:crypto';
import { endOtherSessions, newPasswordDetails, passwordAcceptable, passwordMatches } from '../auth/sessions.mjs';
import { pool } from '../core/connection.mjs';
import { T } from '../core/database.mjs';
import { readServerKey } from '../core/server-keys.mjs';

/* ---------- WhatsApp: messages sent by the server itself (Meta's WhatsApp Business Cloud API) ----------
   Set up once in Meta (business.facebook.com > WhatsApp Manager): a WhatsApp business phone number, a permanent
   access token, and an approved message template whose body has four places, e.g.
     "Hello {{1}}, your FEWA staff password has been reset. Username: {{2}} Temporary password: {{3}}
      Sign in at {{4}}. You will be asked to choose your own password when you sign in."
   The details are rows of private_settings.server_keys (Supabase only: no page, backup or office copy has them):
     whatsapp_access_token, whatsapp_phone_number_id, whatsapp_template (its name), whatsapp_template_language (e.g. en)
   or Render's WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TEMPLATE / WHATSAPP_TEMPLATE_LANGUAGE.
   Not set up: nothing is sent and the page says so (its Send on WhatsApp button still opens WhatsApp by hand). */
const WHATSAPP_API = (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
async function whatsappSettings() {
    const key = async (name, env) => (await readServerKey(name).catch(() => null)) || process.env[env] || '';
    return {
        token: await key('whatsapp_access_token', 'WHATSAPP_ACCESS_TOKEN'),
        phoneNumberId: await key('whatsapp_phone_number_id', 'WHATSAPP_PHONE_NUMBER_ID'),
        template: await key('whatsapp_template', 'WHATSAPP_TEMPLATE'),
        language: (await key('whatsapp_template_language', 'WHATSAPP_TEMPLATE_LANGUAGE')) || 'en'
    };
}
// { sent: true } or { sent: false, reason } (never throws: a failed WhatsApp must not undo the reset)
export async function sendWhatsAppTemplate(phone, values) {
    const settings = await whatsappSettings();
    if (!settings.token || !settings.phoneNumberId || !settings.template) return { sent: false, reason: 'not-set-up' };
    const to = String(phone || '').replace(/\D/g, '').replace(/^0(?=7|1)/, '254');
    if (!/^\d{10,15}$/.test(to)) return { sent: false, reason: 'no-phone' };
    try {
        const response = await fetch(`${WHATSAPP_API}/${encodeURIComponent(settings.phoneNumberId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.token}` },
            body: JSON.stringify({
                messaging_product: 'whatsapp', to, type: 'template',
                template: { name: settings.template, language: { code: settings.language },
                    components: [{ type: 'body', parameters: values.map(text => ({ type: 'text', text: String(text) })) }] }
            }),
            signal: AbortSignal.timeout(20000)
        });
        const answer = await response.json().catch(() => ({}));
        if (response.ok && answer.messages && answer.messages.length) return { sent: true, to: '+' + to };
        const reason = (answer.error && (answer.error.error_user_msg || answer.error.message)) || `WhatsApp answered ${response.status}`;
        console.log(new Date().toLocaleString(), 'WhatsApp not sent:', reason.slice(0, 200));
        return { sent: false, reason: reason.slice(0, 200) };
    } catch (err) {
        console.log(new Date().toLocaleString(), 'WhatsApp not sent:', err.message);
        return { sent: false, reason: 'WhatsApp could not be reached (' + err.message + ')' };
    }
}
// A temporary password nobody can guess, made here (no letters or numbers that look alike, e.g. O and 0)
export function temporaryPassword() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...randomBytes(10)].map(byte => characters[byte % characters.length]).join('');
}
// A student's Student Portal password: staff (Reset Password, or admitting them) get a new temporary one made here,
// which they must change at their next login; the student themselves chooses their own
export async function setStudentPasswordOnServer(session, { studentId, password, mustChange } = {}) {
    if (session.kind === 'student') {
        if (studentId !== session.studentId) throw Object.assign(new Error('Not allowed.'), { status: 403 });
        mustChange = false;
        if (!passwordAcceptable(password)) return { result: 'weak' };
    } else {
        password = temporaryPassword();
        mustChange = true;
    }
    const { rows } = await pool.query(`SELECT login_salt, login_hash FROM ${T('students')} WHERE id = $1`, [String(studentId)]);
    if (!rows.length) return { result: 'none' };
    if (session.kind === 'student' && rows[0].login_hash && await passwordMatches(password, rows[0].login_salt, rows[0].login_hash)) {
        return { result: 'same' };
    }
    const { salt, hash } = await newPasswordDetails(String(password));
    await pool.query(`UPDATE ${T('students')} SET login_salt = $1, login_hash = $2, must_change_password = $3,
        admin_reset_required = false, password_set_at = now(), updated_at = now() WHERE id = $4`,
        [salt, hash, !!mustChange, String(studentId)]);
    await endOtherSessions('student', studentId, session.kind === 'student' ? session.tokenHash : '');
    return session.kind === 'student' ? { result: 'ok' } : { result: 'ok', password };
}
