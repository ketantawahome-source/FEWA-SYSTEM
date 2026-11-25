/* ---------- Where the system lives and how much a request may send (shared by every module) ---------- */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The system's folder (two levels up from server/core)
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const port = Number(process.env.PORT || process.argv[2] || 5600);
// On a hosting service (PORT is set) the server must accept connections from outside; on this computer only from itself
export const listenAddress = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
export const MAX_BODY_BYTES = 60 * 1024 * 1024; // a record with a large document, sent as base64 (logged-in staff only)
export const SMALL_BODY_BYTES = 64 * 1024; // logging in and password resets: only a few words
export const APPLY_BODY_BYTES = 30 * 1024 * 1024; // the online form: four files of up to 5MB each, sent as base64
