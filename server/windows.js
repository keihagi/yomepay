// Deadline windows, all in Japan time (UTC+9, no daylight saving).
// A "business date" runs from the day boundary (default 03:00) to the same time the next morning,
// so 10/27's goals close at 10/28 03:00. Weekly goals run from Monday 03:00 to the next Monday 03:00.
import { L } from './i18n.js';
const MIN = 60e3, H = 60 * MIN, D = 24 * H, JST = 9 * H;

export const parseHM = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`Bad time "${s}" (use HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const utcOf = date => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };

/** Calendar midnight (00:00 JST) of a YYYY-MM-DD date, as epoch ms. */
export const midnight = date => utcOf(date) - JST;
export const addDays = (date, n) => ymd(utcOf(date) + n * D);
export const weekday = date => new Date(utcOf(date)).getUTCDay(); // 0 = Sunday
export const boundaryMin = settings => parseHM(settings.dayBoundary || '03:00');

/** The business date a moment belongs to. */
export const businessDate = (ms, settings) => ymd(ms + JST - boundaryMin(settings) * MIN);

export const dayStart = (date, settings) => midnight(date) + boundaryMin(settings) * MIN;

/** The window of `goal` that contains moment `ms`. */
export function windowFor(goal, ms, settings) {
  const date = businessDate(ms, settings);
  if (goal.period === 'monthly') {
    const first = `${date.slice(0, 7)}-01`;
    const [y, m] = first.split('-').map(Number);
    const next = ymd(Date.UTC(y, m, 1)); // the 1st of the next month
    return { key: `M${date.slice(0, 7)}`, start: dayStart(first, settings), end: dayStart(next, settings), firstDate: first, lastDate: addDays(next, -1) };
  }
  if (goal.period === 'weekly') {
    const back = (weekday(date) - (settings.weekStart ?? 1) + 7) % 7;
    const first = addDays(date, -back);
    const start = dayStart(first, settings);
    return { key: `W${first}`, start, end: start + 7 * D, firstDate: first, lastDate: addDays(first, 6) };
  }
  const start = dayStart(date, settings);
  return { key: date, start, end: start + D, firstDate: date, lastDate: date };
}

/** The window with this key ("2026-10-27", "W2026-10-26" or "M2026-11"). */
export function windowByKey(goal, key, settings) {
  const date = key.startsWith('M') ? `${key.slice(1)}-01` : key.replace(/^W/, '');
  return windowFor(goal, dayStart(date, settings), settings);
}

/**
 * When an "HH:MM" reminder fires on a business date. Times before the day boundary belong to the
 * next calendar morning, and "24:00" is midnight at the end of the date.
 */
export function fireTime(date, hm, settings) {
  let m = parseHM(hm);
  if (m < boundaryMin(settings)) m += 24 * 60;
  return midnight(date) + m * MIN;
}

/** Windows of `goal` that start on or after `fromDate` and have ended by `toMs`, oldest first. */
export function endedWindows(goal, fromDate, toMs, settings, max = 400) {
  const out = [];
  let w = windowFor(goal, dayStart(fromDate, settings), settings);
  if (w.firstDate < fromDate) w = windowFor(goal, w.end, settings); // a week already under way when the goal started does not count
  while (w.end <= toMs && out.length < max) { out.push(w); w = windowFor(goal, w.end, settings); }
  return out;
}

/** The last `n` windows up to and including the one containing `ms`, oldest first. */
export function recentWindows(goal, ms, settings, n) {
  const out = [windowFor(goal, ms, settings)];
  while (out.length < n) out.unshift(windowFor(goal, out[0].start - 1, settings));
  return out;
}

/** Business dates left in a window, counting `date` itself. */
export const daysLeft = (w, date) => Math.round((utcOf(w.lastDate) - utcOf(date)) / D) + 1;

const pad = n => String(n).padStart(2, '0');
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "10/27 22:00" in Japan time ("Tue 10/27 22:00" in English). */
export function fmt(ms) {
  const d = new Date(ms + JST);
  const s = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return L(s, `${WD_EN[d.getUTCDay()]} ${s}`);
}
/** "10/27" for a business date or window key; "11月" / "November" for a month. */
export const fmtDate = key => {
  if (key.startsWith('M')) { const m = Number(key.slice(6)); return L(`${m}月`, MONTH_EN[m - 1]); }
  const [, m, d] = key.replace(/^W/, '').split('-'); return `${Number(m)}/${Number(d)}`;
};
/** "10/27" for a day, "10/26〜11/1の週" / "week of 10/26" for a week, "11月" / "November" for a month. */
export const windowLabel = w => w.key.startsWith('W') ? L(`${fmtDate(w.firstDate)}〜${fmtDate(w.lastDate)}の週`, `week of ${fmtDate(w.firstDate)}`) : fmtDate(w.key);
/** "あと2時間15分" / "2h 15m left" style countdown. */
export function fmtLeft(ms) {
  if (ms <= 0) return L('締め切り済み', 'past the deadline');
  const h = Math.floor(ms / H), m = Math.floor((ms % H) / MIN);
  if (h >= 48) return L(`あと${Math.floor(h / 24)}日`, `${Math.floor(h / 24)} days left`);
  return h ? L(`あと${h}時間${m ? m + '分' : ''}`, `${h}h${m ? ` ${m}m` : ''} left`) : L(`あと${m}分`, `${m}m left`);
}
