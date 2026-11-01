// Which windows of a goal count, given its dated rules and on/off timeline. Pure: no clock, no disk.
import { windowFor, businessDate, addDays, weekday, dayStart } from './windows.js';

const FIRST = '0000-01-01', LAST = '9999-12-31';

/** The rule in force on a business date (null before the first one starts). */
export function ruleAt(goal, date) {
  let rule = null;
  for (const r of goal.rules) if ((r.from || FIRST) <= date) rule = r;
  return rule;
}
/** The goal with a rule's fields on top, ready for windowFor / evaluateWindow. */
export const withRule = (goal, rule) => ({ ...goal, ...rule });

/** Whether the goal is switched on at a business date. Goals without a timeline are always on. */
export function onAt(goal, date) {
  const tl = goal.timeline || [];
  if (!tl.length) return true;
  let on = !tl[0].on; // before its first event, a goal is in the opposite state
  for (const e of tl) if (e.date <= date) on = e.on;
  return on;
}
/** The last on/off event that has happened by `date`. */
export const lastEvent = (goal, date) => (goal.timeline || []).filter(e => e.date <= date).pop() || null;
export const isDeleted = (goal, date) => lastEvent(goal, date)?.why === 'delete';
/** Events dated after `date` (a pause, resume or delete waiting to start). */
export const upcoming = (goal, date) => (goal.timeline || []).find(e => e.date > date) || null;

/** Whether window `w`, made by `rule`, counts. */
export function counts(goal, rule, w, settings) {
  if (!rule || w.firstDate < (settings.startDate || FIRST)) return false;
  if (ruleAt(goal, w.firstDate) !== rule || !onAt(goal, w.firstDate)) return false;
  if (rule.period === 'daily' && rule.days?.length < 7 && !rule.days.includes(weekday(w.firstDate))) return false;
  return true;
}

/**
 * Counted windows, oldest first, that have ended by `toMs` (plus the one running at `toMs` when
 * `current` is set). Each item is { w, rule, g } where g is the goal with that rule applied.
 */
export function countedWindows(goal, settings, toMs, { current = false, max = 2000 } = {}) {
  const out = [];
  const first = (goal.timeline || [])[0];
  const firstOn = first?.on ? first.date : null; // a goal that begins with a start event counts from then
  goal.rules.forEach((rule, i) => {
    let from = [rule.from || FIRST, settings.startDate || FIRST, firstOn || FIRST].sort().pop();
    if (from === FIRST) return; // no start date known yet
    const until = goal.rules[i + 1]?.from || LAST;
    const g = withRule(goal, rule);
    for (let w = windowFor(g, dayStart(from, settings), settings); w.firstDate < until && out.length < max; w = windowFor(g, w.end, settings)) {
      if (w.end > toMs && !(current && w.start <= toMs)) break;
      if (counts(goal, rule, w, settings)) out.push({ w, rule, g });
    }
  });
  return out;
}

/** The window running at `t` under today's rule, and whether it counts. */
export function currentWindow(goal, settings, t) {
  const today = businessDate(t, settings);
  const rule = ruleAt(goal, today) || goal.rules[0];
  const g = withRule(goal, rule);
  const w = windowFor(g, t, settings);
  return { rule, g, w, counts: counts(goal, rule, w, settings) };
}

/** The first business date a rule change would start on: the day after the current window ends. */
export function nextPeriodStart(goal, settings, t) {
  const { w } = currentWindow(goal, settings, t);
  return addDays(w.lastDate, 1);
}

/** The running or next window that counts, looking up to about a year ahead (null if none). */
export function nextCountedWindow(goal, settings, t) {
  let ms = t;
  for (let i = 0; i < 400; i++) {
    const date = businessDate(ms, settings);
    const rule = ruleAt(goal, date);
    if (rule) {
      const g = withRule(goal, rule);
      const w = windowFor(g, ms, settings);
      if (counts(goal, rule, w, settings)) return { w, rule, g };
      ms = w.end;
    } else ms = dayStart(addDays(date, 1), settings);
    if (isDeleted(goal, businessDate(ms, settings))) return null;
  }
  return null;
}

/** Whether any counted window has started by `t` (after that, rule changes wait for the next period). */
export const hasStarted = (goal, settings, t) => countedWindows(goal, settings, t, { current: true, max: 1 }).length > 0;

/**
 * Streak: counted windows met in a row. Exceptions, server downtime and windows still waiting for review
 * neither break nor add to it; a running window adds once it is met. `stateOf({ w, g })` gives a state.
 */
export function streak(goal, settings, t, stateOf) {
  let current = 0, best = 0, total = 0;
  for (const item of countedWindows(goal, settings, t, { current: true })) {
    const state = stateOf(item);
    if (state === 'met') { current++; total++; best = Math.max(best, current); }
    else if (state === 'missed') current = 0;
  }
  return { current, best, total };
}
