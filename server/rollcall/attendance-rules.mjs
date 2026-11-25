/* ---------- Roll Call: which days a register may be taken or changed (Global Settings backdating) ---------- */
import { DEFAULT_CONTROLS, globalControls } from '../global-settings/global-settings.mjs';

/* Roll Call Management: a register may be taken (or changed or removed) for today only, or, when Global Settings allows
   backdating, for up to that many days back. Days are counted in Kenya time. */
const kenyaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
export async function attendanceBackDays() {
    const controls = await globalControls().catch(() => DEFAULT_CONTROLS);
    return controls.attendanceBackdating ? Math.max(0, Math.min(365, parseInt(controls.attendanceBackdateDays, 10) || 0)) : 0;
}
export async function attendanceDayProblem(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return 'The register has no valid date.';
    const today = kenyaToday(), back = await attendanceBackDays();
    const earliest = new Date(Date.parse(today + 'T12:00:00Z') - back * 86400000).toISOString().slice(0, 10);
    if (day > today) return 'A register cannot be taken for a day still to come.';
    if (day < earliest) return back
        ? `Registers can only be taken or changed for today and the ${back} day${back === 1 ? '' : 's'} before it (Global Settings).`
        : 'Registers can only be taken or changed for today: backdating of attendance is switched off (Global Settings).';
    return '';
}
