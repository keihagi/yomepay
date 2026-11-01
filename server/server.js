// yomepay server: serves the app and a small JSON API over plain files, and runs the scheduler.
// Binds to 127.0.0.1; the phone reaches it through `tailscale serve` (scripts/tailscale-serve.sh).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { config, ROOT, readSecrets } from './config.js';
import { now, isFake } from './clock.js';
import { createStore, newId } from './store.js';
import { createGoals, makeGoal, changeRule, changeState, cleanLooks, cleanRule } from './goals.js';
import { ruleAt, withRule, counts, onAt, lastEvent, upcoming, isDeleted, currentWindow, nextCountedWindow, nextPeriodStart, hasStarted, streak } from './periods.js';
import { createNotifier } from './notify.js';
import { createScheduler, fileUptime } from './scheduler.js';
import { createActions } from './actions.js';
import { fetchPushesWithGh } from './github.js';
import { evaluateWindow } from './evaluate.js';
import { windowFor, businessDate, fmt, fmtDate, windowLabel } from './windows.js';
import { ticketTtlMs, instructionFor, atPlace, similarity } from './proof.js';
import { paymentProvider } from './payments/manual-paypay.js';
import { createReviewer } from './reviewer.js';
import { L } from './i18n.js';

const store = await createStore(config.dataDir);
const goalsRepo = createGoals(config.dataDir, { now });
await goalsRepo.load(); // creates goals.json on first run
const notifier = createNotifier({ store, secrets: readSecrets, dryRun: config.dryRun, now });
const actions = createActions({ store, notifier, now });
const reviewer = createReviewer({ root: ROOT, who: config.reviewer });
const scheduler = createScheduler({
  store, notifier, goalsRepo, now, uptime: fileUptime(config.dataDir),
  fetchPushes: fetchPushesWithGh({ ghBin: config.ghBin, user: config.githubUser }),
});

/* ---------- http helpers ---------- */
const PUBLIC = path.join(ROOT, 'public');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg' };
const TYPES = { html: 'text/html; charset=utf-8', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', jpg: 'image/jpeg', webm: 'video/webm', mp4: 'video/mp4' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  // camera, microphone (video only uses the camera) and location are needed on this origin only
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(self)',
};
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', ...SECURITY }); res.end(JSON.stringify(obj)); };
class HttpError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }
const bad = (msg, code = 'bad_request') => new HttpError(400, code, msg);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too_large', L('ファイルが大きすぎます', 'The file is too large'))); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 12e6) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Invalid JSON', 'bad_json'); }
}
const jpegFromDataUrl = s => {
  const m = typeof s === 'string' && s.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) throw bad(L('画像がありません', 'No image was sent'));
  return Buffer.from(m[2], 'base64');
};

// Tailscale serve adds the signed-in tailnet user; when YOMEPAY_ALLOWED_USERS is set, only they get in.
function allowed(req) {
  if (!config.allowedUsers.length) return true;
  return config.allowedUsers.includes(String(req.headers['tailscale-user-login'] || '').toLowerCase());
}
// Only answer to names this server is really reached by (blocks DNS rebinding).
const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', ...config.allowedHosts]);
execFile(config.tailscaleBin, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
  try { const name = JSON.parse(stdout).Self.DNSName.replace(/\.$/, '').toLowerCase(); if (name) HOSTS.add(name); } catch {}
});
const hostOk = req => HOSTS.has(String(req.headers.host || '').toLowerCase().replace(/:\d+$/, ''));

/* ---------- api ---------- */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

/* ---------- state ---------- */
const yen = n => '¥' + Number(n || 0).toLocaleString('ja-JP');
const UNIT = { daily: '日', weekly: '週', monthly: 'か月' }, UNIT_EN = { daily: 'days', weekly: 'weeks', monthly: 'months' };
const WD = '日月火水木金土';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "毎日・写真+場所・¥3,000" ("daily · photo+place · ¥3,000") style summary for messages to the wife. */
function ruleText(r) {
  const freq = r.period === 'weekly' ? L(`週${r.count}回`, `${r.count}× a week`) : r.period === 'monthly' ? L(`月${r.count}回`, `${r.count}× a month`)
    : r.days.length === 7 ? L('毎日', 'daily') : L(r.days.map(d => WD[d]).join(''), r.days.map(d => WD_EN[d]).join('/'));
  const ev = L({ text: '文章', photo: '写真', video: '動画', location: '場所', github: 'GitHubのpush' },
    { text: 'text', photo: 'photo', video: 'video', location: 'place', github: 'GitHub push' });
  return [freq, r.requires.map(x => ev[x]).join('+'), yen(r.penaltyYen)].join(L('・', ' · '));
}
const exemptionMonth = e => e.date || e.windowKey.replace(/^[WM]/, '');

async function buildState() {
  const t = now();
  const { settings, goals } = await goalsRepo.load();
  const graceMs = settings.graceMinutes * 60e3;
  const [subs, settlements, penalties, exemptions, notifications] = await Promise.all(
    ['submissions', 'settlements', 'penalties', 'exemptions', 'notifications'].map(k => store.list(k)));
  const settlementOf = new Map(settlements.map(s => [s.id, s]));
  const exemptionsFor = (g, key) => exemptions.filter(e => e.goalId === g.id && e.windowKey === key);
  const evalAt = (g, w) => evaluateWindow({ goal: g, window: w, submissions: subs, exemptions: exemptionsFor(g, w.key), now: t, graceMs });
  const stateOf = ({ g, w }) => settlementOf.get(`${g.id}--${w.key}`)?.state || evalAt(g, w).state;
  const today = businessDate(t, settings);
  const month = today.slice(0, 7);

  const goalViews = goals.filter(g => !isDeleted(g, today)).map(goal => {
    const cur = currentWindow(goal, settings, t);
    const on = onAt(goal, today);
    const pending = goal.rules.findIndex((r, i) => i > 0 && (r.from || '') > today);
    const shown = pending > 0 ? goal.rules[pending] : cur.rule;
    const next = cur.counts ? null : nextCountedWindow(goal, settings, t);
    const loc = goal.location;
    return {
      id: goal.id, title: goal.title, art: goal.art, color: goal.color, image: goal.image || null, howto: goal.howto,
      reminders: goal.reminders, text: goal.text, photo: goal.photo, video: goal.video, github: goal.github,
      location: loc ? { radiusM: loc.radiusM || 200, set: Number.isFinite(loc.lat), name: loc.name || '', setAt: loc.setAt || null } : null,
      ...cur.rule, rule: shown, pendingFrom: pending > 0 ? goal.rules[pending].from : null,
      status: on ? 'active' : lastEvent(goal, today)?.why === 'pause' ? 'paused' : 'upcoming',
      scheduled: upcoming(goal, today), started: hasStarted(goal, settings, t), changeFrom: nextPeriodStart(goal, settings, t),
      counts: cur.counts, startsOn: next ? next.w.firstDate : null,
      current: { ...evalAt(cur.g, cur.w), deadline: fmt(cur.w.end) },
      streak: { ...streak(goal, settings, t, stateOf), unit: L(UNIT, UNIT_EN)[cur.rule.period] },
    };
  });

  const goalTitle = id => goals.find(g => g.id === id)?.title || (id === '_payment' ? L('罰金の支払い', 'Penalty payment') : id);
  const recent = subs.filter(s => s.kind !== 'github' || t - s.submittedAt < 14 * 864e5)
    .sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 60)
    .map(s => ({ ...s, goalTitle: goalTitle(s.goalId), when: fmt(s.submittedAt || s.receivedAt) }));
  const unpaid = penalties.filter(p => p.status !== 'paid');
  const secrets = readSecrets();
  return {
    now: t, nowLabel: fmt(t), today, fakeClock: isFake(), dryRun: config.dryRun, settings, reviewer: config.reviewer,
    goals: goalViews, submissions: recent,
    pendingCount: subs.filter(s => s.status === 'pending').length,
    penalties: penalties.sort((a, b) => b.createdAt - a.createdAt),
    unpaidTotal: unpaid.reduce((a, p) => a + p.amountYen, 0), paidTotal: penalties.filter(p => p.status === 'paid').reduce((a, p) => a + p.amountYen, 0),
    payment: { provider: paymentProvider.id, label: paymentProvider.label },
    exemptions: { used: exemptions.filter(e => exemptionMonth(e).startsWith(month)).length, limit: settings.exemptionsPerMonth,
      list: exemptions.filter(e => exemptionMonth(e).startsWith(month)).map(e => ({ ...e, goalTitle: goalTitle(e.goalId) })) },
    notifications: notifications.sort((a, b) => b.at - a.at).slice(0, 30),
    ntfy: { server: secrets.ntfyServer || 'https://ntfy.sh', meTopic: secrets.meTopic || null, wifeTopic: secrets.wifeTopic || null },
  };
}

/* ---------- goals ---------- */
async function goalById(id) {
  const { settings, goals } = await goalsRepo.load();
  const goal = goals.find(g => g.id === id && !isDeleted(g, businessDate(now(), settings)));
  if (!goal) throw new HttpError(404, 'not_found', L('その目標はありません', 'No such goal'));
  return { goal, settings };
}

// GPS sent from the goal editor when "register this place" was pressed.
function placeFrom(input) {
  const l = input?.location;
  if (!l || !Number.isFinite(l.lat)) return input;
  if (Number(l.accuracy) > 150) throw bad(L(`GPSの精度が低すぎます（±${Math.round(l.accuracy)}m）。外に近い場所でもう一度`, `The GPS is too rough (±${Math.round(l.accuracy)} m). Try again closer to a window or outside`));
  return { ...input, location: { ...l, setAt: now() } };
}

route('POST', '/api/goals', async req => {
  const input = placeFrom(await readJson(req, 50_000));
  const { settings } = await goalsRepo.load();
  const today = businessDate(now(), settings);
  const goal = await goalsRepo.update(doc => { const g = makeGoal(input, today); doc.goals.push(g); return g; });
  const next = nextCountedWindow(goal, settings, now());
  await notifier.send({ to: 'wife', key: `goal-new-${goal.id}`, title: L(`目標を追加: ${goal.title}`, `New goal: ${goal.title}`),
    message: L(`${ruleText(goal.rules[0])}。${next ? `${fmtDate(next.w.firstDate)}から数えます。` : ''}`, `${ruleText(goal.rules[0])}.${next ? ` Counts from ${fmtDate(next.w.firstDate)}.` : ''}`), priority: 2 });
  return { goal };
});

route('PUT', '/api/goals/([a-z0-9-]+)', async (req, [id]) => {
  const input = placeFrom(await readJson(req, 50_000));
  const t = now();
  const { goal: before, settings } = await goalById(id);
  const today = businessDate(t, settings);
  const ctx = { today, effective: nextPeriodStart(before, settings, t), started: hasStarted(before, settings, t) };
  let ruleChange = 'unchanged';
  await goalsRepo.update(doc => {
    const g = doc.goals.find(x => x.id === id);
    Object.assign(g, cleanLooks(input, g));
    if (input.rule) ruleChange = changeRule(g, input.rule, ctx);
  });
  const placeMoved = Number.isFinite(input.location?.lat);
  if (placeMoved) await notifier.send({ to: 'wife', key: `place-${id}-${t}`, title: L(`${before.title} の場所が${before.location?.lat ? '変更' : '登録'}されました`, `${before.title}: place ${before.location?.lat ? 'changed' : 'set'}`),
    message: `${input.location.name || L('（名前なし）', '(no name)')} ${fmt(t)}`, priority: 2 });
  if (ruleChange !== 'unchanged' && ruleChange !== 'now') await notifier.send({ to: 'wife', key: `rule-${id}-${t}`, title: L(`ルール変更: ${before.title}`, `Rules changed: ${before.title}`),
    message: L(`${fmtDate(ruleChange)}から ${ruleText(cleanRule(input.rule))}（今までは ${ruleText(before.rules[before.rules.length - 1])}）`,
      `From ${fmtDate(ruleChange)}: ${ruleText(cleanRule(input.rule))} (was ${ruleText(before.rules[before.rules.length - 1])})`), priority: 2 });
  return { ok: true, ruleFrom: ruleChange };
});

route('POST', '/api/goals/([a-z0-9-]+)/state', async (req, [id]) => {
  const { what } = await readJson(req, 1000);
  if (!['pause', 'resume', 'delete', 'cancel'].includes(what)) throw bad(L('不明な操作です', 'Unknown action'));
  const t = now();
  const { goal, settings } = await goalById(id);
  const today = businessDate(t, settings);
  const started = hasStarted(goal, settings, t);
  const scheduled = upcoming(goal, today);
  const date = await goalsRepo.update(doc => changeState(doc.goals.find(x => x.id === id), what, { today, started }));
  const word = L({ pause: '一時停止', resume: '再開', delete: '削除' }, { pause: 'paused', resume: 'resumed', delete: 'deleted' });
  const verb = { pause: 'Pausing', resume: 'Resuming', delete: 'Deleting' };
  if (what === 'cancel' && scheduled) await notifier.send({ to: 'wife', key: `state-${id}-${t}`,
    title: L(`${goal.title}: ${word[scheduled.why] || '変更'}を取り消しました`, `${goal.title}: no longer ${word[scheduled.why] || 'changing'}`), message: L('今までどおり続けます。', 'It goes on as before.'), priority: 2 });
  else if (date) await notifier.send({ to: 'wife', key: `state-${id}-${t}`, title: L(`目標を${word[what]}: ${goal.title}`, `Goal ${word[what]}: ${goal.title}`),
    message: date === today
      ? L(`まだ数え始める前だったので、すぐに${word[what]}しました。`, `It had not started counting yet, so it was ${word[what]} right away.`)
      : L(`${fmtDate(date)}から${word[what]}します。${what === 'resume' ? '' : '今日（今週・今月）の分は数えます。'}`,
        `${verb[what]} from ${fmtDate(date)}.${what === 'resume' ? '' : ' Today (this week, this month) still counts.'}`), priority: 2 });
  return { ok: true, date };
});

route('POST', '/api/goals/([a-z0-9-]+)/image', async (req, [id]) => {
  const { image } = await readJson(req, 12e6);
  await goalById(id);
  let name = null;
  if (image) { name = `art-${id}-${Date.now().toString(36)}.jpg`; await store.putMedia(name, jpegFromDataUrl(image)); }
  await goalsRepo.update(doc => { doc.goals.find(x => x.id === id).image = name; });
  return { image: name };
});

/* ---------- tickets and submissions ---------- */

// The rule and window a ticket belongs to. A ticket is issued when the capture screen opens, and its time
// decides the window, so a recording started at 02:58 still counts for "today" even if it is sent later.
function ticketWindow(goal, settings, at) {
  const rule = ruleAt(goal, businessDate(at, settings));
  const g = rule && withRule(goal, rule);
  const w = g && windowFor(g, at, settings);
  if (!w || !counts(goal, rule, w, settings)) throw bad(L('今はこの目標の提出期間ではありません', 'This goal is not taking submissions right now'));
  return { rule, g, w };
}

// Signs that a position was faked (a mock-location app, or a copied position). The server already checked
// the distance; these go to the reviewer, who decides.
async function placeFlags(goal, gps, issuedAt) {
  const flags = [];
  if (!gps.accuracy) flags.push(L('位置の精度が 0m（本物のGPSではまず出ない値。位置偽装アプリの可能性）', 'Location accuracy is 0 m (real GPS almost never says this; maybe a fake-location app)'));
  if (gps.accuracy > 100) flags.push(L(`位置の精度が低い（±${gps.accuracy}m）`, `Rough location (±${gps.accuracy} m)`));
  if (gps.at && issuedAt - gps.at > 5 * 60e3) flags.push(L(`位置が提出より ${Math.round((issuedAt - gps.at) / 60e3)} 分前のもの`, `The location is ${Math.round((issuedAt - gps.at) / 60e3)} minutes older than the submission`));
  const same = (await store.list('submissions')).find(s => s.goalId === goal.id && s.gps && s.gps.lat === gps.lat && s.gps.lng === gps.lng);
  if (same) flags.push(L(`過去の提出 ${same.id}（${fmt(same.submittedAt)}）と座標が完全に同じ（本物のGPSは毎回少しずれる）`, `Exactly the same coordinates as ${same.id} (${fmt(same.submittedAt)}); real GPS moves a little every time`));
  if (gps.lat === goal.location.lat && gps.lng === goal.location.lng) flags.push(L('登録した地点と座標が完全に同じ', 'Exactly the same coordinates as the registered place'));
  return flags;
}

async function ticketFor(goal, ticketId) {
  const tk = ticketId && await store.get('challenges', String(ticketId)).catch(() => null);
  if (!tk || tk.goalId !== goal.id) throw bad(L('チケットが無効です。提出画面を開き直してください。', 'This submission has expired. Open it again.'), 'bad_ticket');
  if (tk.usedAt) throw bad(L('このチケットは使用済みです。提出画面を開き直してください。', 'This was already submitted. Open it again for a new one.'), 'bad_ticket');
  if (now() > tk.expiresAt) throw bad(L('時間切れです。提出画面を開き直してください（指示も変わります）。', 'Time is up. Open it again (you will get a new instruction).'), 'bad_ticket');
  return tk;
}

route('GET', '/api/state', async () => buildState());

route('POST', '/api/tickets', async req => {
  const { goalId } = await readJson(req, 10_000);
  const { goal, settings } = await goalById(goalId);
  const t = now();
  const { rule } = ticketWindow(goal, settings, t);
  if (rule.requires.includes('github')) throw bad(L('この目標は自動で確認します', 'This goal is checked automatically'));
  const tk = { id: newId('tk'), goalId: goal.id, requires: rule.requires, instruction: instructionFor(rule.requires), issuedAt: t, expiresAt: t + ticketTtlMs(rule.requires) };
  await store.put('challenges', tk);
  return { ticket: tk };
});

// A recorded video goes up first (it is large and binary), then /api/submit sends the rest.
route('POST', '/api/upload', async req => {
  const q = new URL(req.url, 'http://x').searchParams;
  const { goal } = await goalById(q.get('goalId'));
  const tk = await ticketFor(goal, q.get('ticketId'));
  if (!tk.requires.includes('video')) throw bad(L('この目標に動画はいりません', 'This goal does not take a video'));
  const ext = String(req.headers['content-type'] || '').startsWith('video/mp4') ? 'mp4' : 'webm';
  const buf = await readBody(req, 80e6);
  if (buf.length < 20_000) throw bad(L('動画が短すぎるか、録画に失敗しています', 'The video is too short, or the recording failed'));
  const name = `${tk.id}.${ext}`;
  await store.putMedia(name, buf);
  Object.assign(tk, { upload: name, durationSec: Number(q.get('duration')) || null });
  await store.put('challenges', tk);
  return { ok: true };
});

route('POST', '/api/submit', async req => {
  const body = await readJson(req, 12e6);
  const { goal, settings } = await goalById(body.goalId);
  const tk = await ticketFor(goal, body.ticketId);
  const { rule, w } = ticketWindow(goal, settings, tk.issuedAt);
  const need = x => rule.requires.includes(x);
  const sub = { id: newId('sub'), goalId: goal.id, goalTitle: goal.title, kind: rule.requires.join('+'), requires: rule.requires, windowKey: w.key,
    submittedAt: tk.issuedAt, receivedAt: now(), status: 'pending', ticketId: tk.id, instruction: tk.instruction, flags: [] };

  if (need('text')) {
    const text = String(body.text || '').trim().slice(0, 5000), n = text.replace(/\s/g, '').length;
    if (!text) throw bad(L('文章を書いてください', 'Write something first'));
    if (n < rule.minChars) throw bad(L(`${rule.minChars}文字以上にしてください（今 ${n}文字）`, `Write at least ${rule.minChars} characters (now ${n})`));
    sub.text = text;
    for (const e of await store.list('submissions')) {
      const old = e.goalId === goal.id && (e.text || e.reading?.memo);
      const sim = old ? similarity(text, old) : 0;
      if (sim >= 0.5) sub.flags.push(L(`過去の提出 ${e.id}（${fmt(e.submittedAt)}）と ${Math.round(sim * 100)}% 一致`, `${Math.round(sim * 100)}% the same as ${e.id} (${fmt(e.submittedAt)})`));
    }
  }
  let image = null;
  if (need('photo')) image = jpegFromDataUrl(body.image);
  if (need('video')) {
    if (!tk.upload) throw bad(L('動画が届いていません。もう一度送ってください', 'The video did not arrive. Send it again'));
    Object.assign(sub, { video: tk.upload, durationSec: tk.durationSec });
  }
  if (need('location')) {
    if (!Number.isFinite(goal.location?.lat)) throw bad(L('先に目標の編集画面で場所を登録してください', 'Set the place in the goal editor first'), 'no_place');
    const pos = body.gps || {};
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) throw bad(L('位置情報が取れていません。位置情報を許可してください', 'No location yet. Allow location access'), 'no_gps');
    const radius = goal.location.radiusM || 200;
    const where = atPlace(goal.location, pos, radius);
    if (!where.inside) throw bad(L(`${goal.location.name || '登録した場所'}から ${where.distanceM}m 離れています（許容 ${radius}m）。着いてからもう一度`,
      `You are ${where.distanceM} m from ${goal.location.name || 'the place'} (within ${radius} m is OK). Try again when you are there`), 'too_far');
    sub.gps = { lat: pos.lat, lng: pos.lng, accuracy: Math.round(pos.accuracy || 0), distanceM: where.distanceM, at: pos.at || null };
    sub.flags.push(...await placeFlags(goal, sub.gps, tk.issuedAt));
  }

  tk.usedAt = now();
  await store.put('challenges', tk);
  if (image) { sub.media = `${sub.id}.jpg`; await store.putMedia(sub.media, image); }
  await store.put('submissions', sub);
  reviewer.soon();
  return { submission: sub };
});

// Contact sheets made on the phone while recording (1 frame per second). Only for a video just sent.
route('POST', '/api/submissions/([A-Za-z0-9-]+)/sheets', async (req, [id]) => {
  const { sheets = [] } = await readJson(req, 12e6);
  const sub = await store.get('submissions', id);
  if (!sub || !(sub.video || sub.kind === 'video') || sub.status !== 'pending' || sub.sheets?.length) throw bad(L('この提出にはコマ画像を付けられません', 'Frames cannot be added to this submission'));
  if (now() - sub.receivedAt > 10 * 60e3) throw bad(L('時間切れです', 'Time is up'));
  sub.sheets = [];
  for (const [i, s] of sheets.slice(0, 6).entries()) {
    const name = `${id}-s${String(i + 1).padStart(2, '0')}.jpg`;
    await store.putMedia(name, jpegFromDataUrl(s));
    sub.sheets.push(name);
  }
  await store.put('submissions', sub);
  return { ok: true, sheets: sub.sheets.length };
});

route('POST', '/api/submit/payment', async req => {
  const body = await readJson(req, 12e6);
  const unpaid = (await store.list('penalties')).filter(p => p.status !== 'paid');
  if (!unpaid.length) throw bad(L('未払いの罰金はありません', 'Nothing is unpaid'));
  const image = jpegFromDataUrl(body.image);
  const id = newId('sub');
  await store.putMedia(`${id}.jpg`, image);
  const sub = { id, goalId: '_payment', goalTitle: L('罰金の支払い', 'Penalty payment'), kind: 'payment', media: `${id}.jpg`, submittedAt: now(), receivedAt: now(), status: 'pending',
    penaltyIds: unpaid.map(p => p.id), amountYen: unpaid.reduce((a, p) => a + p.amountYen, 0), flags: [] };
  await store.put('submissions', sub);
  return { submission: sub };
});

// Ticking a penalty as paid (after sending it in PayPay). The wife is told either way, so she can check.
route('POST', '/api/penalties/([A-Za-z0-9-]+)/paid', async (req, [id]) => {
  const { paid } = await readJson(req, 1000);
  const p = await store.get('penalties', id);
  if (!p) throw new HttpError(404, 'not_found', L('その罰金はありません', 'No such penalty'));
  const t = now();
  if (paid && p.status !== 'paid') Object.assign(p, { status: 'paid', paidAt: t, paidBy: 'self' });
  else if (!paid && p.status === 'paid') { p.status = 'unpaid'; delete p.paidAt; delete p.paidBy; delete p.proofSubmissionId; }
  else return { penalty: p };
  await store.put('penalties', p);
  const left = (await store.list('penalties')).filter(x => x.status !== 'paid').reduce((a, x) => a + x.amountYen, 0);
  await notifier.send(paid
    ? { to: 'wife', key: `paid-wife-${id}-${t}`, title: L(`罰金 ${yen(p.amountYen)} を支払い済みにしました`, `Penalty of ${yen(p.amountYen)} marked as paid`),
        message: L(`${p.goalTitle}（${p.label}）。PayPayに届いていなければ本人に伝えてください。${left ? `残りの未払い ${yen(left)}` : '未払いはゼロです。'}`,
          `${p.goalTitle} (${p.label}). If it did not reach your PayPay, tell them. ${left ? `Still unpaid: ${yen(left)}` : 'Nothing is unpaid now.'}`), priority: 3, tags: ['white_check_mark'] }
    : { to: 'wife', key: `unpaid-wife-${id}-${t}`, title: L(`支払い済みを取り消しました: ${yen(p.amountYen)}`, `Marked unpaid again: ${yen(p.amountYen)}`), message: L(`${p.goalTitle}（${p.label}）。未払い合計 ${yen(left)}`, `${p.goalTitle} (${p.label}). Unpaid in total: ${yen(left)}`), priority: 2 });
  return { penalty: p };
});

// 特例: a few times a month (all goals together), filed before the deadline. A daily goal skips that day;
// a weekly or monthly goal needs one time fewer.
route('POST', '/api/exemptions', async req => {
  const { goalId, reason = '' } = await readJson(req, 10_000);
  const { goal, settings } = await goalById(goalId);
  const t = now();
  const { g, w } = ticketWindow(goal, settings, t);
  if (!String(reason).trim()) throw bad(L('理由を書いてください', 'Give a reason'));
  const exemptions = await store.list('exemptions');
  const mine = exemptions.filter(e => e.goalId === goal.id && e.windowKey === w.key);
  const ev = evaluateWindow({ goal: g, window: w, submissions: await store.list('submissions'), exemptions: mine, now: t, graceMs: 0 });
  if (ev.state === 'met') throw bad(L('もう達成しています', 'It is already done'));
  if (ev.state === 'exempt') throw bad(L('すでに特例を使っています', 'An exception is already in use for this'));
  if (ev.state !== 'open') throw bad(L('締め切りを過ぎています', 'The deadline has passed'));
  const today = businessDate(t, settings);
  const used = exemptions.filter(e => exemptionMonth(e).startsWith(today.slice(0, 7))).length;
  if (used >= settings.exemptionsPerMonth) throw bad(L(`今月の特例（${settings.exemptionsPerMonth}回）は使い切りました`, `All ${settings.exemptionsPerMonth} exceptions for this month are used`));
  const ex = { id: `ex-${goal.id}--${w.key}--${mine.length + 1}`, goalId: goal.id, windowKey: w.key, date: today, reason: String(reason).slice(0, 300), at: t };
  await store.put('exemptions', ex);
  const what = g.period === 'daily' ? L(`${windowLabel(w)}は休み`, `${windowLabel(w)} off`) : L(`${windowLabel(w)}は ${ev.count - mine.length - 1}回でOK`, `${windowLabel(w)}: ${ev.count - mine.length - 1} is enough`);
  await notifier.send({ to: 'wife', key: `ex-wife-${ex.id}`, title: L(`特例: ${goal.title}（${what}）`, `Exception: ${goal.title} (${what})`),
    message: L(`理由: ${ex.reason}\n今月 ${used + 1}/${settings.exemptionsPerMonth} 回目`, `Reason: ${ex.reason}\n${used + 1} of ${settings.exemptionsPerMonth} this month`), priority: 3 });
  return { exemption: ex };
});

// The app's language (also used for notifications and the review CLI). Nothing else is editable here.
route('PUT', '/api/settings', async req => {
  const { lang } = await readJson(req, 1000);
  if (!['ja', 'en'].includes(lang)) throw bad(L('言語は ja か en です', 'The language must be ja or en'));
  await goalsRepo.update(doc => { doc.settings = { ...doc.settings, lang }; });
  return { ok: true };
});

route('POST', '/api/github/check', async () => {
  const r = await scheduler.githubSync(true);
  if (!r.ok) throw new HttpError(502, 'github_failed', L('GitHub を確認できませんでした（gh のログイン状態を確認）', 'Could not check GitHub (is the gh CLI signed in?)'));
  return { created: r.created.length };
});

route('POST', '/api/notify/test', async req => {
  const { to = 'me' } = await readJson(req, 1000);
  const r = await notifier.send({ to: to === 'wife' ? 'wife' : 'me', title: L('yomepay テスト通知', 'yomepay test'), message: L(`${fmt(now())} に送信しました。`, `Sent ${fmt(now())}.`), priority: 3 });
  if (r.failed) throw new HttpError(502, 'ntfy_failed', L('ntfy に送れませんでした', 'Could not send to ntfy'));
  return { ok: true };
});

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 421, { code: 'bad_host', error: 'Unknown host name. Add it to YOMEPAY_ALLOWED_HOSTS.' });
    if (!allowed(req)) return send(res, 403, { code: 'forbidden', error: 'Not allowed' });
    const { pathname } = new URL(req.url, 'http://x');
    const media = req.method === 'GET' && pathname.match(/^\/media\/([A-Za-z0-9][A-Za-z0-9-]{2,95}\.(jpg|webm|mp4))$/);
    if (media) {
      const body = await fs.readFile(store.mediaPath(media[1])).catch(() => null);
      if (!body) return send(res, 404, { code: 'not_found', error: 'No media' });
      res.writeHead(200, { 'Content-Type': TYPES[media[2]], ...SECURITY, 'Cache-Control': 'private, max-age=86400' });
      return res.end(body);
    }
    if (req.method === 'GET' && STATIC[pathname]) {
      const file = STATIC[pathname];
      const body = await fs.readFile(path.join(PUBLIC, file));
      res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()], ...SECURITY });
      return res.end(body);
    }
    if (!pathname.startsWith('/api/')) return send(res, 404, { code: 'not_found', error: 'Not found' });
    // A custom header blocks cross-site requests (they would need a CORS preflight, which is never granted).
    if (req.method !== 'GET' && req.headers['x-yome'] !== '1') return send(res, 403, { code: 'forbidden', error: 'Missing X-Yome header' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (m) return send(res, 200, await r.fn(req, m.slice(1)));
    }
    send(res, 404, { code: 'not_found', error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError || e.status) return send(res, e.status, { code: e.code || 'bad_request', error: e.message });
    console.error(e);
    send(res, 500, { code: 'server_error', error: L('サーバーでエラーが起きました', 'Something went wrong on the server') });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`yomepay on http://${config.host}:${config.port}${isFake() ? `  (fake clock: ${fmt(now())})` : ''}`);
  console.log(`Data: ${config.dataDir} · ${config.dryRun ? 'DRY RUN (wife messages go to you)' : 'LIVE'}`);
  scheduler.start(config.tickMs);
  // the reviewer: check every 5 minutes whether evidence has been waiting
  setInterval(async () => reviewer.maybe((await store.list('submissions')).some(s => s.status === 'pending')), 5 * 60e3);
});
