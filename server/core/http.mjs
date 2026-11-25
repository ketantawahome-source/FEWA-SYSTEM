/* ---------- Answering requests and reading what they send ---------- */
import { MAX_BODY_BYTES } from './config.mjs';

export function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
/* ---------- The API ---------- */
export function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('The file is too large to save.'), { status: 413 }));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
            } catch {
                reject(Object.assign(new Error('The request was not valid JSON.'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}
