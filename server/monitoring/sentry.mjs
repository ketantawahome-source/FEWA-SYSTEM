/* ---------- Error monitoring (Sentry) ---------- */
import { pool } from '../core/connection.mjs';
import { loadConfig } from '../core/database.mjs';
import { readServerKey } from '../core/server-keys.mjs';

/* ---------- Error monitoring (Sentry) ----------
   Off until a Sentry DSN is saved: first private_settings.server_keys row "sentry_dsn" (Supabase), then Render's
   SENTRY_DSN setting, then "sentryDsn" in db-config.json. Only the error itself goes to Sentry (its message, where in
   the code, the page address without ?...): no request contents, cookies, headers, people or console lines, so no
   college data leaves the system. The pages get the same DSN from /sentry-config.js (sentry.js). */
export let Sentry = null, sentryDsn = '';
export const SENTRY_ENVIRONMENT = process.env.PORT ? 'online' : 'office';
const noQuery = url => String(url || '').split('?')[0];
function scrubSentryEvent(event) {
    if (event.request) event.request = { method: event.request.method, url: noQuery(event.request.url) };
    delete event.user;
    delete event.extra;
    delete event.contexts?.runtime?.args;
    if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter(b => b.category !== 'console')
        .map(b => ({ ...b, data: b.data && b.data.url ? { method: b.data.method, url: noQuery(b.data.url), status_code: b.data.status_code } : undefined }));
    return event;
}
export async function startErrorMonitoring() {
    if (Sentry) return;
    const saved = pool ? await readServerKey('sentry_dsn').catch(() => null) : null;
    sentryDsn = String(saved || process.env.SENTRY_DSN || (await loadConfig().catch(() => ({}))).sentryDsn || '').trim();
    if (!/^https:\/\/[^\s@]+@[^\s/]+\/\d+$/.test(sentryDsn) && !/^http:\/\/[^\s@]+@localhost:\d+\/\d+$/.test(sentryDsn)) { sentryDsn = ''; return; }
    try {
        Sentry = await import('@sentry/node');
        Sentry.init({ dsn: sentryDsn, environment: SENTRY_ENVIRONMENT, sendDefaultPii: false, tracesSampleRate: 0,
            beforeSend: scrubSentryEvent, beforeBreadcrumb: b => b.category === 'console' ? null : b });
        console.log(new Date().toLocaleString(), `Error monitoring (Sentry) is on (${SENTRY_ENVIRONMENT}).`);
    } catch (err) {
        Sentry = null;
        console.log(new Date().toLocaleString(), 'Error monitoring (Sentry) could not start: ' + err.message);
    }
}
export function reportError(err, where) {
    if (!Sentry) return;
    try { Sentry.captureException(err, where ? { tags: { where: noQuery(where).slice(0, 190) } } : undefined); } catch { }
}
// Anything unexpected is written in this window instead of closing the server (and sent to Sentry when it is on)
process.on('uncaughtException', err => { console.log(new Date().toLocaleString(), 'Unexpected error (the server keeps running):', err); reportError(err, 'uncaught'); });
process.on('unhandledRejection', err => { console.log(new Date().toLocaleString(), 'Unexpected error (the server keeps running):', err); reportError(err, 'unhandled promise'); });
