/* ---------- The database connection: started, set up, retried; the pool every module uses ---------- */
import pg from 'pg';
import { connectBackups } from '../../backups.mjs';
import { columnCache, ensureDatabase, loadConfig, moveTablesOutOfPublic, rowFromRecord, tableColumns, tableDefinitions, takeOldLayoutRows, upsertRow } from './database.mjs';
import { startErrorMonitoring } from '../monitoring/sentry.mjs';
import { moveSettingsIntoTables } from '../settings/settings.mjs';
import { startMirror } from '../sync/mirror.mjs';

export let pool = null;
export let databaseError = null;
// On the office computer a restart means logging in again: logins from before it no longer count here. (They stay in
// the database, so people using the online system are not affected. Online, Render restarts whenever it has slept,
// so this is off there.)
export let sessionsValidFrom = null;
export async function inTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}
// Changing the tables can collide with something else using them at that moment (the online server, or a page
// saving): PostgreSQL then cancels one side with "deadlock detected". Nothing was changed, so it simply tries again.
const TABLE_UPDATE_TRIES = 5;
export async function setUpTables(client) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await setUpTablesOnce(client);
        } catch (err) {
            if (attempt >= TABLE_UPDATE_TRIES || !['40P01', '40001'].includes(err.code)) throw err;
            console.log(new Date().toLocaleString(), `Updating the tables collided with other work (${err.message}): trying again.`);
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
    }
}
async function setUpTablesOnce(client) {
    const definitions = await tableDefinitions();
    await client.query('BEGIN');
    try {
        await moveTablesOutOfPublic(client);
        const old = await takeOldLayoutRows(client);
        for (const sql of definitions) await client.query(sql);
        columnCache.clear();
        for (const [table, records] of Object.entries(old)) {
            for (const [position, record] of records.entries()) {
                const values = rowFromRecord(await tableColumns(client, table), record);
                if (table === 'staff') {
                    values.id = String(record.id || record.username);
                    values.position = position;
                }
                await upsertRow(client, table, 'id', values);
            }
        }
        await moveSettingsIntoTables(client);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    }
}
/* Staying connected: the pool opens connections as they are needed, so after the internet drops or Supabase
   closes an idle connection, the next request simply opens a new one. A connection lost while idle is only
   reported in this window; it never stops the server. */
async function startDatabase() {
    const config = await loadConfig(); // read again on every try, so a corrected password is picked up
    await ensureDatabase(config);
    const newPool = new pg.Pool({
        ...config,
        max: 10,
        connectionTimeoutMillis: 15000, // give up on a connection attempt after 15 seconds
        idleTimeoutMillis: 30000, // close unused connections before the pooler drops them
        keepAlive: true
    });
    newPool.on('error', err => console.log(new Date().toLocaleString(), 'A database connection was lost (a new one opens when needed):', err.message));
    try {
        const client = await newPool.connect();
        try {
            await setUpTables(client);
        } finally {
            client.release();
        }
    } catch (err) {
        await newPool.end().catch(() => { });
        throw err;
    }
    const firstConnection = !pool;
    if (firstConnection && !process.env.PORT) sessionsValidFrom = (await newPool.query('SELECT now() AS at')).rows[0].at;
    pool = newPool;
    databaseError = null;
    console.log(`Connected to PostgreSQL: database "${config.database}" on ${config.host}:${config.port}.`);
    if (firstConnection) {
        startMirror();
        connectBackups();
        startErrorMonitoring();
    }
}
// Keeps trying every 15 seconds until the database answers (e.g. no internet yet, or the Supabase project
// was paused and is waking up); pages show the reason meanwhile
const RETRY_SECONDS = 15;
export async function connectDatabase() {
    try {
        await startDatabase();
    } catch (err) {
        databaseError = 'The FEWA server could not connect to the database: ' + err.message +
            ` It tries again every ${RETRY_SECONDS} seconds.`;
        console.log(new Date().toLocaleString(), '*** ' + databaseError);
        console.log('*** Check the internet connection, the password in db-config.json, and that the Supabase project is not paused.');
        setTimeout(connectDatabase, RETRY_SECONDS * 1000);
    }
}
