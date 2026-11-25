/* ---------- The pages, scripts, styles and pictures (and nothing else from this folder) ---------- */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './config.mjs';
import { send } from './http.mjs';

/* ---------- Static files: only the system's pages, scripts, styles and images ---------- */
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
export async function serveStatic(req, res, file) {
    if (file === '/') file = '/login.html';
    const full = path.join(root, file);
    // Never anything outside this folder, inside node_modules, or of another kind (db-config.json, backups, server code)
    const inside = full.startsWith(root + path.sep) && !full.slice(root.length).toLowerCase().includes('node_modules');
    const type = types[path.extname(full).toLowerCase()];
    if (!inside || !type) return send(res, 404, 'Not found: ' + file, 'text/plain; charset=utf-8');
    try {
        const body = await readFile(full);
        // Always check for a newer file, so changes show with a normal refresh. The file's fingerprint (ETag) lets
        // the browser keep its copy: an unchanged file is answered with "not modified" instead of being sent again.
        const etag = '"' + createHash('sha1').update(body).digest('base64url') + '"';
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'ETag': etag });
        res.end(body);
    } catch {
        send(res, 404, 'Not found: ' + file, 'text/plain; charset=utf-8');
    }
}
