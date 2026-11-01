#!/usr/bin/env node
// Try the app on this Mac with sample data and a fake clock. Your real data is not touched and no
// notification leaves the Mac (there are no ntfy topics in demo mode; messages only show up in the app).
//   npm run demo                          http://localhost:4750, clock starts Thu 2026-11-05 21:30
//   npm run demo -- 2026-11-05T23:50      start the clock at another time (Japan time)
// Each run starts over from the same sample data.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.js';
import { validate } from '../server/goals.js';
import { windowFor } from '../server/windows.js';
import { withRule } from '../server/periods.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve((process.env.DEMO_DIR || '~/.yomepay/demo-data').replace(/^~(?=$|\/)/, os.homedir()));
const MARK = path.join(DIR, '.yomepay-demo');
const PORT = process.env.DEMO_PORT || '4750';
const arg = process.argv[2] || '2026-11-05T21:30';
const NOW = /[+-]\d\d:\d\d$|Z$/.test(arg) ? arg : `${arg}:00+09:00`.replace(/(T\d\d:\d\d:\d\d):00\+/, '$1+');
const F = Date.parse(NOW);
if (Number.isNaN(F)) { console.error(`Not a time: ${arg} (example: 2026-11-05T21:30)`); process.exit(1); }

// Start over, but only ever delete a folder this script made.
try {
  await fs.access(DIR);
  try { await fs.access(MARK); } catch { console.error(`${DIR} exists but was not made by the demo. Not touching it.`); process.exit(1); }
  await fs.rm(DIR, { recursive: true });
} catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.mkdir(path.join(DIR, 'bin'), { recursive: true });
await fs.writeFile(MARK, 'Made by `npm run demo`. Safe to delete.\n');

// GitHub: the demo never reads your real pushes. This stand-in for `gh` always answers "no new pushes".
const fakeGh = path.join(DIR, 'bin', 'gh');
await fs.writeFile(fakeGh, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });

const at = (d, hm) => Date.parse(`${d}T${hm}:00+09:00`);
const day = (base, n) => new Date(Date.parse(`${base}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const today = new Date(F + 9 * 36e5 - 3 * 36e5).toISOString().slice(0, 10); // business day (03:00 boundary)
const start = day(today, -6);
const d = n => day(start, n); // d(0) = first counted day … d(6) = today

const doc = JSON.parse(await fs.readFile(path.join(ROOT, 'goals.example.json'), 'utf8'));
doc.settings = { ...doc.settings, startDate: start };
// Two more, to show a monthly goal and a paused one.
doc.goals.push(
  { id: 'clean', title: '部屋の掃除', art: 'clean', color: 'mint', photo: { prompt: '片付けたあとの部屋全体が写っている。' }, reminders: ['20:00'],
    rules: [{ from: null, requires: ['photo'], period: 'monthly', count: 2, penaltyYen: 2000 }] },
  { id: 'cafe', title: '朝カフェで勉強', art: 'study', color: 'brown', reminders: ['08:00'],
    location: { lat: 35.6595, lng: 139.7005, name: 'いつものカフェ', radiusM: 150 },
    rules: [{ from: null, requires: ['location'], period: 'daily', days: [1, 2, 3, 4, 5], penaltyYen: 1000 }],
    timeline: [{ date: d(4), on: false, why: 'pause' }] },
);
await fs.writeFile(path.join(DIR, 'goals.json'), JSON.stringify(doc, null, 2) + '\n');
const { settings, goals } = validate(doc);
const goal = id => { const g = goals.find(x => x.id === id); return withRule(g, g.rules[0]); };

const store = await createStore(DIR);
let n = 0;
async function sub(goalId, ms, kind, status, extra = {}) {
  const g = goal(goalId);
  const s = {
    id: `demo-${goalId}-${++n}`, goalId, goalTitle: g.title, kind, windowKey: windowFor(g, ms, settings).key,
    submittedAt: ms, receivedAt: ms + 40_000, status, flags: [], ...extra,
  };
  if (status === 'approved') s.review = { by: 'claude', at: ms + 3 * 36e5, note: extra.note || '確認済み（サンプル）' };
  await store.put('submissions', s);
}

const books = [
  ['サピエンス全史 上', 'p.40-62', '認知革命の話。虚構を信じる力で大人数が協力できる、という説明がわかりやすかった。会社もお金も同じ仕組みだと思った。'],
  ['サピエンス全史 上', 'p.62-85', '狩猟採集民のほうが栄養も余暇も多かったという話は意外。便利になることと幸せになることは別、というのは自分の働き方にも当てはまる。'],
  ['サピエンス全史 上', 'p.85-110', '農業革命は「小麦が人間を家畜化した」という見方。贅沢品がすぐ必需品になる、という部分で自分のサブスクを思い出した。'],
  ['サピエンス全史 上', 'p.110-131', '書記体系は税の記録から始まったという話。数字の記録は最初から管理のための道具だった。このアプリも同じだなと思った。'],
];

// Push-ups: missed d(3) → penalty. Reading: d(5) is waiting for review. Development: missed d(2) → penalty.
for (const i of [0, 1, 2, 4, 5]) await sub('pushup', at(d(i), '21:15'), 'video', 'approved', { requires: ['video'], durationSec: 34, instruction: '右手で指を3本見せる' });
for (const [i, b] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 3]]) await sub('reading', at(d(i), '23:05'), 'text', 'approved', { requires: ['text'], text: `${books[b][0]} ${books[b][1]}\n${books[b][2]}` });
await sub('reading', at(d(5), '23:40'), 'text', 'pending', { requires: ['text'], text: 'サピエンス全史 下 p.1-24\n帝国の話。征服された側の文化が混ざって新しい文化になっていく。善悪だけで歴史を見ると見落とすものがある、という主張に納得した。明日は貨幣の章。' });
// The café check-ins on the weekdays before it was paused (location only: checked by the server).
for (let i = 0; i < 4; i++) {
  const wd = new Date(`${d(i)}T12:00:00Z`).getUTCDay();
  if (wd >= 1 && wd <= 5) await sub('cafe', at(d(i), '08:20'), 'location', 'approved', { requires: ['location'], gps: { lat: 35.6596, lng: 139.7004, accuracy: 12, distanceM: 14 }, note: '14m 以内で確認' });
}
// Cleaning: once so far this month.
const cleanDay = [`${today.slice(0, 7)}-01`, d(1)].sort().pop();
await sub('clean', at(cleanDay, '11:00'), 'photo', 'approved', { requires: ['photo'], instruction: '右手の指を2本立てる。その手とやったことの様子が一緒に写るように撮る' });

for (const i of [0, 1, 3, 4, 5]) {
  const ms = at(d(i), '22:30');
  await store.put('submissions', {
    id: `gh-dev-${d(i)}`, goalId: 'dev', kind: 'github', windowKey: windowFor(goal('dev'), ms, settings).key,
    submittedAt: ms, receivedAt: ms, status: 'approved', github: { repo: 'you/yomepay', eventId: `demo${i}`, at: ms },
    review: { by: 'auto', at: ms, note: 'you/yomepay へのpush（サンプル）' },
  });
}
// Gym: one of two done this week (the week the start day falls in is not counted).
const gymWeek = windowFor(goal('gym'), at(today, '12:00'), settings);
const gymDay = day(today, -2);
if (gymWeek.firstDate >= start && gymDay >= gymWeek.firstDate) await sub('gym', at(gymDay, '19:10'), 'photo+location', 'approved', { requires: ['photo', 'location'], gps: { lat: 35.6595, lng: 139.7005, accuracy: 18, distanceM: 20 }, instruction: '左手の指を2本立てる' });

// The server was up the whole time, so missed days become real penalties (not "server was down").
await fs.writeFile(path.join(DIR, 'uptime.json'), JSON.stringify([[at(start, '03:00'), F]]));

console.log(`
yomepay demo
  open:   http://localhost:${PORT}
  clock:  ${NOW} (moves forward from here)
  data:   ${DIR} (sample data, made fresh each run)
  no notification is sent anywhere; they only show up in the app.
  review the sample evidence:  YOMEPAY_DATA_DIR=${DIR} npm run review
  stop:   Ctrl+C
`);

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT, stdio: 'inherit',
  env: {
    ...process.env, PORT, HOST: '127.0.0.1', YOMEPAY_DATA_DIR: DIR, YOMEPAY_NOW: NOW, YOMEPAY_DRY_RUN: 'true',
    YOMEPAY_SECRETS: path.join(DIR, 'no-secrets.json'), YOMEPAY_GH_BIN: fakeGh, YOMEPAY_ALLOWED_HOSTS: '', YOMEPAY_REVIEWER: 'off', YOMEPAY_GITHUB_USER: 'you',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exit(code ?? 0));
