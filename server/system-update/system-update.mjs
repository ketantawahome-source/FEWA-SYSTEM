/* ---------- System Update ("running the rocket") ---------- */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { updateBackupTables } from '../../backups.mjs';
import { forgetSessions } from '../auth/sessions.mjs';
import { root } from '../core/config.mjs';
import { pool, setUpTables } from '../core/connection.mjs';
import { T, columnCache } from '../core/database.mjs';
import { SYNC_ORDER, mirrorChanged, mirrorPool, mirrorQueue, setMirrorQueue } from '../sync/mirror.mjs';

/* ---------- System Update (Settings > System Update): "running the rocket" ----------
   After changes are pushed to GitHub, an administrator presses Update. On the office computer the server then:
   checks GitHub for new changes (git fetch), downloads them (git merge --ff-only), installs new packages when
   package.json changed, updates the tables of every database (the database/*.sql files, on Supabase, the local
   PostgreSQL copy and the backups database) and restarts itself with the new code (exit code 3: start-server.bat
   starts it again). Online (Render) the new code is installed by Render itself from GitHub, so the rocket only
   checks the version and updates the database tables. Every step is shown on the page, written in this window
   ("[System update] ...") and kept in settings.system_updates. */
const UPDATE_REPO = 'ketantawahome-source/FEWA-SYSTEM';
const RESTART_EXIT_CODE = 3;
const onlineHost = !!process.env.RENDER;
const updatePlace = onlineHost ? 'online (Render)' : 'office computer';
export let updateRun = null; // the run in progress (or the last one since the server started)
function runCommand(command, args, timeout = 120000) {
    return new Promise((resolve, reject) => {
        // npm is a .cmd file on Windows, which needs a shell
        const shell = process.platform === 'win32' && command === 'npm';
        execFile(command, args, { cwd: root, timeout, windowsHide: true, shell }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { output: String(stderr || stdout || '').trim() }));
            resolve(String(stdout).trim());
        });
    });
}
async function currentVersion() {
    if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
    return runCommand('git', ['rev-parse', 'HEAD'], 15000).catch(() => null);
}
/* The changes on GitHub (newest first), each { sha, date, author, title, notes }.
   GitHub's API allows only 60 questions an hour from one internet address without signing in, and online
   (Render) that address is shared with many other websites, so GitHub often answers 403. Then the public
   change feed (the newest 20 changes) is read instead; if that fails too, the last list read is kept. */
let githubCache = { at: 0, commits: null };
const decodeEntities = text => String(text).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (whole, code) => {
    const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
});
async function githubApiCommits() {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits?per_page=100`, {
        headers: {
            'User-Agent': 'FEWA-College-System', Accept: 'application/vnd.github+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {})
        }
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()).map(c => splitMessage(c.sha, c.commit.author.date, c.commit.author.name, c.commit.message));
}
async function githubFeedCommits() {
    const response = await fetch(`https://github.com/${UPDATE_REPO}/commits/main.atom`, { headers: { 'User-Agent': 'FEWA-College-System' } });
    if (!response.ok) throw new Error(`GitHub's change feed answered ${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
        const pick = tag => (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
        const sha = (pick('id').match(/Commit\/([0-9a-f]{40})/) || [])[1] || '';
        // The full message is HTML (<pre>...</pre>) inside the XML: decoded twice
        const message = decodeEntities(decodeEntities(pick('content')).replace(/<\/?pre[^>]*>/g, '')).trim();
        return splitMessage(sha, pick('updated').trim(), decodeEntities(pick('name').trim()), message || decodeEntities(pick('title').trim()));
    }).filter(c => c.sha);
}
async function githubCommits() {
    if (githubCache.commits && Date.now() - githubCache.at < 5 * 60000) return githubCache.commits;
    let commits;
    try {
        commits = await githubApiCommits();
    } catch (apiError) {
        try {
            commits = await githubFeedCommits();
        } catch {
            if (githubCache.commits) return githubCache.commits;
            throw apiError;
        }
    }
    githubCache = { at: Date.now(), commits };
    return commits;
}
function splitMessage(sha, date, author, message) {
    const lines = String(message).split(/\r?\n/).filter(l => !/^Co-Authored-By:/i.test(l.trim()));
    return { sha, date, author, title: lines[0] || '', notes: lines.slice(1).join('\n').trim() };
}
// The changes kept in this computer's copy (git), newest first
async function localCommits(range = 'HEAD', count = 150) {
    const out = await runCommand('git', ['log', range, '-n', String(count), '--format=%H%x1f%aI%x1f%an%x1f%B%x1e'], 30000);
    return out.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
        const [sha, date, author, message] = r.split('\x1f');
        return splitMessage(sha, date, author, message);
    });
}
// Release notes: every change, marked installed or not yet; check = also ask GitHub for new ones
export async function updateInfo(check) {
    const version = await currentVersion();
    let notes = [];
    let problem = '';
    try {
        if (onlineHost || !existsSync(path.join(root, '.git'))) {
            const commits = await githubCommits();
            const at = commits.findIndex(c => c.sha === version);
            notes = commits.map((c, i) => ({ ...c, installed: at >= 0 && i >= at }));
        } else {
            if (check) await runCommand('git', ['fetch', '--quiet', 'origin', 'main'], 60000).catch(err => { problem = 'GitHub could not be reached: ' + (err.output || err.message); });
            const pending = await localCommits('HEAD..origin/main', 100).catch(() => []);
            notes = [...pending.map(c => ({ ...c, installed: false })), ...(await localCommits()).map(c => ({ ...c, installed: true }))];
        }
    } catch (err) {
        problem = 'The release notes could not be read: ' + err.message;
    }
    const { rows } = await pool.query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", started_by AS "startedBy",
        place, from_version AS "fromVersion", to_version AS "toVersion", changes, databases, status
        FROM ${T('system_updates')} ORDER BY started_at DESC LIMIT 10`);
    return { place: updatePlace, online: onlineHost, version, waiting: problem ? null : notes.filter(n => !n.installed).length, notes, problem, history: rows, run: updateRun };
}
// When the last update that worked finished (shown at the bottom of every page)
export async function lastSystemUpdate() {
    const { rows } = await pool.query(`SELECT finished_at AS "finishedAt" FROM ${T('system_updates')}
        WHERE status <> 'Failed' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
    return rows.length ? rows[0].finishedAt : null;
}
// After an update everyone logs in again, so every page opens with the new code
export async function logOutEveryone() {
    // (whoever is in Global Settings stays there)
    await pool.query(`DELETE FROM ${T('sessions')} WHERE kind <> 'global'`);
    forgetSessions();
}
// The log's times are in the time zone of the person who pressed Update (the online server runs on UTC)
export function validTimeZone(zone) {
    try {
        return zone && new Intl.DateTimeFormat('en-GB', { timeZone: String(zone) }) && String(zone);
    } catch {
        return undefined;
    }
}
export async function runSystemUpdate(by, timeZone) {
    if (updateRun && ['Running', 'Restarting'].includes(updateRun.status)) return updateRun;
    const id = 'upd-' + Date.now().toString(36) + randomBytes(3).toString('hex');
    const run = updateRun = { id, status: 'Running', percent: 0, step: '', log: [], by, startedAt: new Date().toISOString(), place: updatePlace };
    const say = (percent, text) => {
        run.percent = percent;
        run.step = text;
        run.log.push(`${new Date().toLocaleTimeString('en-GB', { timeZone })}  ${text}`);
        console.log(new Date().toLocaleString(), '[System update]', text);
    };
    const save = (fields = {}) => pool.query(`INSERT INTO ${T('system_updates')} (id, started_at, started_by, place, from_version, to_version,
            changes, databases, status, log, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET to_version = EXCLUDED.to_version, changes = EXCLUDED.changes, databases = EXCLUDED.databases,
            status = EXCLUDED.status, log = EXCLUDED.log, finished_at = EXCLUDED.finished_at`,
        [id, run.startedAt, by, updatePlace, run.from || null, fields.to || null, fields.changes ?? null, fields.databases ?? null,
            fields.status || 'Running', run.log.join('\n'), fields.finished ? new Date().toISOString() : null]).catch(() => { });

    (async () => {
        let changes = 0;
        let databases = 0;
        try {
            say(3, `Rocket on the launch pad: update started by ${by} on the ${updatePlace}.`);
            run.from = await currentVersion();
            await save();
            say(8, 'Checking GitHub for new changes...');
            if (!onlineHost) {
                await runCommand('git', ['fetch', '--quiet', 'origin', 'main'], 60000);
                changes = Number(await runCommand('git', ['rev-list', '--count', 'HEAD..origin/main'], 15000)) || 0;
                say(20, changes ? `${changes} new change(s) found on GitHub.` : 'No new changes on GitHub: the code here is up to date.');
                if (changes) {
                    const changedFiles = await runCommand('git', ['diff', '--name-only', 'HEAD', 'origin/main'], 15000);
                    say(30, 'Downloading the changes from GitHub...');
                    await runCommand('git', ['merge', '--ff-only', 'origin/main'], 60000);
                    say(45, `Changes downloaded (now at version ${(await currentVersion() || '').slice(0, 7)}).`);
                    if (/(^|\n)package(-lock)?\.json/.test(changedFiles)) {
                        say(50, 'Installing new packages...');
                        await runCommand('npm', ['install', '--no-fund', '--no-audit', '--omit=dev'], 300000);
                        say(58, 'Packages installed.');
                    }
                }
            } else {
                // Only to tell the person: Render installs new code by itself, so GitHub not answering is no failure
                const latest = await githubCommits().then(list => list[0]).catch(err => {
                    say(20, `GitHub could not be asked for new changes (${err.message}); carrying on with the database tables.`);
                    return null;
                });
                changes = latest && latest.sha !== run.from ? 1 : 0;
                if (latest) say(30, changes ? 'GitHub has newer code: Render installs it by itself within a few minutes (watch the Render dashboard).'
                    : 'The online system already runs the newest code on GitHub.');
            }

            say(62, 'Updating the database tables (database/*.sql)...');
            // In the sync's queue, so the sync waits and cannot collide with these table changes
            const tablesUpdated = mirrorQueue.then(async () => {
                const client = await pool.connect();
                try { await setUpTables(client); } finally { client.release(); }
                databases++;
                say(72, 'Main database (Supabase) updated.');
                if (mirrorPool) {
                    const mirrorClient = await mirrorPool.connect();
                    try { await setUpTables(mirrorClient); } finally { mirrorClient.release(); columnCache.clear(); }
                    databases++;
                    say(80, 'Local PostgreSQL copy (fewa_college) updated.');
                    mirrorChanged(SYNC_ORDER);
                }
            });
            setMirrorQueue(tablesUpdated.catch(() => { }));
            await tablesUpdated;
            if (await updateBackupTables()) {
                databases++;
                say(86, 'Backups database (fewa_backups) updated.');
            }

            const restart = !onlineHost && changes > 0;
            const to = await currentVersion();
            run.status = restart ? 'Restarting' : changes ? 'Done' : 'Up to date';
            say(restart ? 95 : 100, `${databases} database(s) updated - no script failures.` +
                (restart ? ' Restarting the system with the new code...' : ' Rocket landed: the update is complete.') +
                ' Everyone is logged out and logs in again.');
            await save({ to, changes, databases, status: changes ? 'Done' : 'Up to date', finished: true });
            await logOutEveryone().catch(err => console.log(new Date().toLocaleString(), '[System update] Could not log everyone out:', err.message));
            if (restart) {
                setTimeout(() => {
                    console.log(new Date().toLocaleString(), '[System update] Restarting now (start-server.bat starts the server again).');
                    process.exit(RESTART_EXIT_CODE);
                }, 1500);
            }
        } catch (err) {
            run.status = 'Failed';
            say(run.percent, 'FAILED: ' + (err.output || err.message) +
                (/not possible to fast-forward|diverg/i.test(err.output || '') ? ' (this computer has its own changes that are not on GitHub)' : ''));
            await save({ to: await currentVersion(), changes, databases, status: 'Failed', finished: true });
        }
    })();
    return run;
}
