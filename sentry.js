/* Error monitoring of the pages (Sentry). /sentry-config.js, from the server, says whether it is on and its DSN;
   when it is, Sentry's browser script (vendor/sentry.bundle.min.js, kept here, not loaded from another website)
   reports the pages' errors. Only the error goes: its message, where in the code, and the page address without
   ?... - no names typed, no console lines, no data the page reads or sends, nothing about the person. */
(function () {
    var config = window.FEWA_SENTRY;
    if (!config || !config.dsn) return;
    var noQuery = function (url) { return String(url || '').split('?')[0].split('#')[0]; };
    var script = document.createElement('script');
    script.src = 'vendor/sentry.bundle.min.js';
    script.onload = function () {
        if (!window.Sentry) return;
        window.Sentry.init({
            dsn: config.dsn,
            environment: config.environment,
            sendDefaultPii: false,
            tracesSampleRate: 0,
            // Errors from browser add-ons are not the system's
            denyUrls: [/^chrome-extension:\/\//, /^moz-extension:\/\//, /^safari-extension:\/\//, /^edge:\/\//],
            beforeBreadcrumb: function (b) {
                // Clicks are kept (which button, not what is typed); console lines and typed text are not
                if (b.category === 'console' || b.category === 'ui.input') return null;
                if (b.data && b.data.url) b.data = { method: b.data.method, url: noQuery(b.data.url), status_code: b.data.status_code };
                if (b.data && (b.data.from || b.data.to)) b.data = { from: noQuery(b.data.from), to: noQuery(b.data.to) };
                return b;
            },
            beforeSend: function (event) {
                if (event.request) event.request = { url: noQuery(event.request.url) };
                delete event.user;
                delete event.extra;
                return event;
            }
        });
        window.Sentry.setTag('page', location.pathname.replace(/^\//, '') || 'index.html');
    };
    document.head.appendChild(script);
})();
