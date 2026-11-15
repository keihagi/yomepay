// Goals and global settings live in DATA/goals.json (a new install starts with none).
//
// A goal has:
//   - looks and helpers you can change any time: title, art, color, image, reminders, what each kind of
//     proof should show (text/photo/video prompt, read by the review), location (changes are told to the
//     wife), GitHub repos to skip. `howto` is the older single description, kept for old goals.
//   - rules, which decide money: what counts as done (requires), how often (period/count/days), the
//     penalty, the memo length. Rules are a dated list; a change only starts with the goal's next period,
//     so nothing can be changed to dodge today's (this week's, this month's) deadline.
//   - a timeline of on/off events (start, pause, resume, delete), also dated from tomorrow at the earliest.
// A window counts when the goal was on at the window's first day and the rule then in force made it.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { businessDate, addDays, parseHM } from './windows.js';
import { onAt, lastEvent } from './periods.js';
import { L, setLang } from './i18n.js';
import { cleanLogins } from './github.js';

export const EVIDENCE = ['text', 'photo', 'video', 'location', 'github'];
export const PERIODS = ['daily', 'weekly', 'monthly'];
export const ARTS = ['gym', 'pushup', 'book', 'code', 'run', 'study', 'meditate', 'water', 'sun', 'clean', 'star'];
export const COLORS = ['red', 'orange', 'yellow', 'green', 'mint', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const DEFAULT_SETTINGS = {
  dayBoundary: '03:00', weekStart: 1, graceMinutes: 65, morning: '09:00', nagTimes: ['12:00', '20:00'],
  wifeDigest: '21:00', exemptionsPerMonth: 3, reminderWindowMinutes: 10, startDate: null, lang: 'ja',
};

const fail = msg => { throw Object.assign(new Error(msg), { status: 400 }); };
const int = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(L(`${what[0]}は ${lo}〜${hi} の整数にしてください`, `${what[1]} must be a whole number from ${lo} to ${hi}`));
  return n;
};
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Checks and cleans the money-deciding part of a goal. */
export function cleanRule(r = {}) {
  const requires = [...new Set(Array.isArray(r.requires) ? r.requires : [])].filter(x => EVIDENCE.includes(x));
  if (!requires.length) fail(L('達成の条件を1つ以上選んでください', 'Pick at least one thing that counts as done'));
  if (requires.includes('github') && requires.length > 1) fail(L('GitHubのpushは自動で確認するので、ほかの条件とは組み合わせられません', 'A GitHub push is checked automatically, so it cannot be combined with anything else'));
  const period = PERIODS.includes(r.period) ? r.period : fail(L('頻度を選んでください', 'Pick how often'));
  const count = period === 'daily' ? 1 : int(r.count ?? 1, 1, period === 'weekly' ? 7 : 31, ['回数', 'The number of times']);
  let days = period === 'daily' ? [...new Set((r.days ?? ALL_DAYS).map(Number))].filter(d => ALL_DAYS.includes(d)).sort() : ALL_DAYS;
  if (!days.length) fail(L('曜日を1つ以上選んでください', 'Pick at least one day of the week'));
  return {
    requires: EVIDENCE.filter(x => requires.includes(x)), period, count, days,
    penaltyYen: int(r.penaltyYen ?? 0, 0, 100000, ['罰金', 'The penalty']),
    minChars: requires.includes('text') ? int(r.minChars ?? 0, 0, 2000, ['最低文字数', 'The minimum length']) : 0,
  };
}
export const sameRule = (a, b) => JSON.stringify(cleanRule(a)) === JSON.stringify(cleanRule(b));

/** Checks and cleans the parts of a goal that can change any time. Missing fields keep `prev`. */
export function cleanLooks(input = {}, prev = {}) {
  const has = k => input[k] !== undefined;
  const title = has('title') ? str(input.title, 40) : prev.title;
  if (!title) fail(L('目標の名前を入れてください', 'Give the goal a name'));
  const reminders = has('reminders') ? [...new Set((input.reminders || []).map(String))].slice(0, 6) : prev.reminders || [];
  reminders.forEach(parseHM);
  reminders.sort((a, b) => parseHM(a) - parseHM(b));
  let location = prev.location || null;
  if (has('location') && input.location) {
    const l = input.location;
    location = { ...(location || {}), radiusM: int(l.radiusM ?? location?.radiusM ?? 200, 50, 1000, ['半径', 'The radius']) };
    if (Number.isFinite(l.lat) && Number.isFinite(l.lng)) Object.assign(location, { lat: l.lat, lng: l.lng, setAt: l.setAt || null });
    if (l.name !== undefined) location.name = str(l.name, 60);
  }
  const repos = input.github?.excludeRepos;
  return {
    title,
    art: has('art') ? (ARTS.includes(input.art) ? input.art : 'star') : prev.art || 'star',
    color: has('color') ? (COLORS.includes(input.color) ? input.color : 'blue') : prev.color || 'blue',
    howto: has('howto') ? str(input.howto, 500) : prev.howto || '',
    reminders,
    text: { prompt: has('text') ? str(input.text?.prompt, 300) : prev.text?.prompt || '' },
    photo: { prompt: has('photo') ? str(input.photo?.prompt, 300) : prev.photo?.prompt || '' },
    video: { prompt: has('video') ? str(input.video?.prompt, 300) : prev.video?.prompt || '' },
    location,
    github: {
      excludeRepos: has('github')
        ? [...new Set((Array.isArray(repos) ? repos : String(repos ?? '').split(/[\s,]+/)).map(r => String(r).trim().toLowerCase()).filter(r => /^[\w.-]+\/[\w.-]+$/.test(r)))]
        : prev.github?.excludeRepos || [],
      // Whose pushes count. Empty: the default accounts (every account `gh` is signed in to, or YOMEPAY_GITHUB_USER).
      accounts: input.github?.accounts !== undefined ? cleanLogins(input.github.accounts) : prev.github?.accounts || [],
    },
  };
}

// Goals written before rules existed ({ type, period, count, gps, ... }) are read as the new shape.
const LEGACY = {
  photo_gps: { requires: ['photo', 'location'], art: 'gym', color: 'orange' },
  video: { requires: ['video'], art: 'pushup', color: 'pink' },
  reading: { requires: ['text'], art: 'book', color: 'indigo' },
  github: { requires: ['github'], art: 'code', color: 'teal' },
};
// The old single description becomes the photo or video description, whichever the goal asks for.
function fromHowto(g, requires) {
  for (const k of ['photo', 'video']) if (!g[k]?.prompt && requires.includes(k) && g.howto) return { [k]: { prompt: g.howto } };
  return {};
}
function normalize(g) {
  if (Array.isArray(g.rules)) {
    const rules = [...g.rules].sort((a, b) => (a.from || '').localeCompare(b.from || ''));
    return { image: null, howto: '', reminders: [], text: { prompt: '' }, photo: { prompt: '' }, video: { prompt: '' }, location: null, github: { excludeRepos: [], accounts: [] }, timeline: [], ...g,
      ...fromHowto(g, rules.flatMap(r => r.requires || [])), rules };
  }
  const old = LEGACY[g.type] || fail(`goal "${g.id}": unknown type ${g.type}`);
  return {
    id: g.id, title: g.title, art: old.art, color: old.color, image: null, howto: g.howto || '', reminders: g.reminders || [],
    text: { prompt: g.text?.prompt || (g.type === 'reading' ? L('本のタイトル、読んだページ、何が書いてあってどう思ったか', 'Book title, the pages you read, what it said and what you think') : '') },
    photo: { prompt: '' }, video: { prompt: '' }, ...fromHowto(g, old.requires),
    location: g.gps ? { lat: g.gps.lat, lng: g.gps.lng, name: g.gps.name || '', setAt: g.gps.setAt || null, radiusM: g.radiusM || 200 }
      : old.requires.includes('location') ? { radiusM: g.radiusM || 200 } : null,
    github: { excludeRepos: g.excludeRepos || [], accounts: [] },
    rules: [{ from: null, ...cleanRule({ requires: old.requires, period: g.period, count: g.count, penaltyYen: g.penaltyYen, minChars: g.minChars }) }],
    timeline: g.active === false ? [{ date: '0000-01-01', on: false, why: 'pause' }] : [],
  };
}

export function validate(doc) {
  const settings = { ...DEFAULT_SETTINGS, ...(doc.settings || {}) };
  if (!['ja', 'en'].includes(settings.lang)) settings.lang = 'ja';
  setLang(settings.lang);
  for (const t of [settings.dayBoundary, settings.morning, settings.wifeDigest, ...settings.nagTimes]) parseHM(t);
  const ids = new Set();
  const goals = (doc.goals || []).map(raw => {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(raw.id || '')) throw new Error(`goal id "${raw.id}" must be lowercase letters, digits and -`);
    if (ids.has(raw.id)) throw new Error(`duplicate goal id "${raw.id}"`);
    ids.add(raw.id);
    const g = normalize(raw);
    if (!g.rules.length) throw new Error(`goal "${g.id}" has no rules`);
    g.rules = g.rules.map(r => ({ from: r.from || null, ...cleanRule(r) }));
    g.reminders.forEach(parseHM);
    return g;
  });
  return { settings, goals };
}

/* ---------- changes (each returns nothing; they edit the raw goal in place) ---------- */

export const newGoalId = () => `g-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

/** A new goal counts from tomorrow (weekly: next week, monthly: next month). */
export function makeGoal(input, today) {
  const start = addDays(today, 1);
  return { id: newGoalId(), ...cleanLooks(input), image: null, createdAt: Date.now(),
    rules: [{ from: start, ...cleanRule(input.rule) }], timeline: [{ date: start, on: true, why: 'start' }] };
}

/**
 * New rules start at `effective` (the goal's next period). If the goal has not counted anything yet,
 * they simply replace the old ones.
 */
export function changeRule(goal, rule, { today, effective, started }) {
  const clean = cleanRule(rule);
  if (!started) { goal.rules = [{ from: goal.rules[0]?.from ?? null, ...clean }]; return 'now'; }
  const kept = goal.rules.filter(r => (r.from || '') <= today);
  if (sameRule(kept[kept.length - 1], clean)) { goal.rules = kept; return 'unchanged'; }
  goal.rules = [...kept, { from: effective, ...clean }];
  return effective;
}

/**
 * Pause, resume or delete, from tomorrow. A goal that never counted anything has nothing at stake,
 * so it is deleted or paused at once (and resumes from tomorrow).
 */
export function changeState(goal, what, { today, started }) {
  const tomorrow = addDays(today, 1);
  const past = (goal.timeline || []).filter(e => e.date <= today);
  // a goal's first start stays: without it the goal would count from the very beginning
  if (what === 'cancel') { goal.timeline = (goal.timeline || []).filter(e => e.date <= today || e.why === 'start'); return null; }
  if (what === 'delete' && !started) { goal.timeline = [...past, { date: today, on: false, why: 'delete' }]; return today; }
  const onNow = onAt(goal, today);
  if (what === 'pause' && !started && lastEvent(goal, today)?.why !== 'pause') { goal.timeline = [...past, { date: today, on: false, why: 'pause' }]; return today; }
  if (what === 'resume' && onNow) { goal.timeline = past; return null; } // only a pause was scheduled: drop it
  if (what === 'pause' && !onNow) fail(L('すでに一時停止中です', 'It is already paused'));
  goal.timeline = [...past, { date: tomorrow, on: what === 'resume', why: what }];
  return tomorrow;
}

export function createGoals(dataDir, { now }) {
  const file = path.join(dataDir, 'goals.json');

  async function save(doc) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
    await fs.rename(tmp, file);
  }

  async function readRaw() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`goals.json is broken: ${e.message}`);
      // A new install starts with no goals: nothing can cost money until you add one in the app.
      return { settings: {}, goals: [] };
    }
  }

  async function load() {
    const raw = await readRaw();
    if (!raw.settings?.startDate) {
      // Counting starts with the next business day, so setting up late at night never costs money.
      raw.settings = { ...raw.settings, startDate: addDays(businessDate(now(), { ...DEFAULT_SETTINGS, ...raw.settings }), 1) };
      await save(raw);
    }
    return validate(raw);
  }

  /** Runs fn on the goals in their current shape (old ones converted), checks the result, saves it. */
  async function update(fn) {
    const raw = await readRaw();
    const doc = { settings: raw.settings, goals: validate(raw).goals };
    const out = await fn(doc);
    validate(doc);
    await save(doc);
    return out;
  }

  return { load, update, file };
}
