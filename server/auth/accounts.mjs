/* ---------- Staff accounts, role rights and reset codes ---------- */
import { inTransaction, pool } from '../core/connection.mjs';
import { T, recordFromRow, rowFromRecord, tableColumns, upsertRow } from '../core/database.mjs';
import { fileIdsIn } from '../files/stored-files.mjs';

/* ---------- Staff accounts, role rights and reset codes ----------
   The pages keep these as text values (as they once were in the browser's localStorage):
   "fewaAccounts" (the list of accounts), "fewaRoleOperations" (rights by role) and
   "fewaPendingReset:<email>" (one reset code). Here each is kept in its own table. */
export const ACCOUNTS_KEY = 'fewaAccounts';
/* The staff's personal & employment details, in the same table (staff.staff) as their account. The accounts
   list ("fewaAccounts") goes to every logged-in staff member's browser, so these are never in it: they are
   read and saved only through /api/staff-details (administrators only), and saving the accounts list keeps
   them as they are in the database. */
export const STAFF_DETAIL_FIELDS = ['idNumber', 'gender', 'dateOfBirth', 'department', 'dateEmployed', 'address',
    'nextOfKinName', 'nextOfKinRelationship', 'nextOfKinPhone',
    // The bio data screen (Nov 2026): biodata, contacts, school access, employment history and payroll details
    'secondName', 'preferredName', 'title', 'maritalStatus', 'passportNo', 'nationality', 'workEmail', 'ethnicity',
    'personalEmail', 'postalCode', 'courseAccess', 'dateLeft', 'profession', 'staffRank', 'bank', 'bankBranch', 'pinNumber',
    'bankAccount', 'shaNumber', 'saccoNo', 'pensionNo', 'nssfNumber', 'staffNumber', 'taxExempt', 'taxExemptReason',
    'supervisor', 'deductHelb', 'examSupervisor'];
// Pictures kept with the details (a reference to the file in files.stored_files): JPG or PNG, up to 10MB
export const STAFF_DETAIL_FILES = ['photo', 'signature'];
export const STAFF_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const STAFF_DETAIL_ONLY = [...STAFF_DETAIL_FIELDS, ...STAFF_DETAIL_FILES, 'detailsUpdatedAt', 'detailsUpdatedBy'];
const withoutDetails = record => Object.fromEntries(Object.entries(record).filter(([field]) => !STAFF_DETAIL_ONLY.includes(field)));
export const onlyDetails = record => Object.fromEntries(Object.entries(record).filter(([field]) => STAFF_DETAIL_ONLY.includes(field)));
export const ROLE_OPERATIONS_KEY = 'fewaRoleOperations';
export const RESET_PREFIX = 'fewaPendingReset:';
export async function getValues() {
    const values = {};
    // The three are read at the same time (each is a trip to the database)
    const [accounts, roles, codes] = await Promise.all([
        pool.query(`SELECT * FROM ${T('staff')} ORDER BY position, id`),
        pool.query(`SELECT role, rights FROM ${T('role_operations')}`),
        pool.query(`SELECT email, data FROM ${T('password_reset_codes')}`)]);
    if (accounts.rowCount) values[ACCOUNTS_KEY] = JSON.stringify(accounts.rows.map(row => withoutDetails(recordFromRow(row))));
    if (roles.rowCount) values[ROLE_OPERATIONS_KEY] = JSON.stringify(Object.fromEntries(roles.rows.map(r => [r.role, r.rights])));
    codes.rows.forEach(r => values[RESET_PREFIX + r.email] = JSON.stringify(r.data));
    return values;
}
export async function setValue(key, value) {
    const parsed = value == null ? null : JSON.parse(value);
    if (key === ACCOUNTS_KEY) {
        if (parsed !== null && !Array.isArray(parsed)) throw Object.assign(new Error('Accounts must be a list.'), { status: 400 });
        await inTransaction(async client => {
            const saved = new Map((await client.query(`SELECT * FROM ${T('staff')}`)).rows
                .map(row => [String(row.id), onlyDetails(recordFromRow(row))]));
            await client.query(`DELETE FROM ${T('staff')}`);
            // The pictures of staff members no longer in the list are deleted with them
            const staying = new Set((parsed || []).map(account => String(account.id || account.username)));
            const goneFiles = [...saved].filter(([id]) => !staying.has(id)).flatMap(([, details]) => [...fileIdsIn(details)]);
            if (goneFiles.length) await client.query(`DELETE FROM ${T('stored_files')} WHERE id = ANY($1)`, [goneFiles]);
            const goneStaff = [...saved.keys()].filter(id => !staying.has(id));
            if (goneStaff.length) await client.query(`DELETE FROM ${T('staff_qualifications')} WHERE staff_id = ANY($1)`, [goneStaff]);
            const columns = await tableColumns(client, 'staff');
            for (const [position, account] of (parsed || []).entries()) {
                const id = String(account.id || account.username);
                const values = rowFromRecord(columns, { ...withoutDetails(account), ...(saved.get(id) || {}), id });
                values.position = position;
                await upsertRow(client, 'staff', 'id', values);
            }
        });
    } else if (key === ROLE_OPERATIONS_KEY) {
        await inTransaction(async client => {
            await client.query(`DELETE FROM ${T('role_operations')}`);
            for (const [role, rights] of Object.entries(parsed || {})) {
                await client.query(`INSERT INTO ${T('role_operations')} (role, rights) VALUES ($1, $2)`, [role, JSON.stringify(rights)]);
            }
        });
    } else if (key.startsWith(RESET_PREFIX)) {
        const email = key.slice(RESET_PREFIX.length);
        if (parsed === null) await pool.query(`DELETE FROM ${T('password_reset_codes')} WHERE email = $1`, [email]);
        else await pool.query(`INSERT INTO ${T('password_reset_codes')} (email, data) VALUES ($1, $2)
            ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`, [email, parsed]);
    } else {
        throw Object.assign(new Error('Unknown value: ' + key), { status: 400 });
    }
}
