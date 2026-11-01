import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { createNotifier } from '../server/notify.js';
import { createScheduler, wasUp, recordUptime } from '../server/scheduler.js';
import { createActions } from '../server/actions.js';
import { validate } from '../server/goals.js';

const jst = s => Date.parse(`${s}+09:00`);
const MIN = 60e3;

async function setup({ goals, startDate = '2026-10-27', pushes = [], dryRun = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yomepay-test-'));
  const store = await createStore(dir);
  let t = 0;
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; };
  const notifier = createNotifier({ store, secrets: () => ({ meTopic: 'me', wifeTopic: 'wife' }), dryRun, now: () => t, fetchImpl, log: { log() {}, warn() {} } });
  const doc = validate({ settings: { startDate }, goals: goals || [
    { id: 'pushup', title: '腕立て', type: 'video', period: 'daily', count: 1, penaltyYen: 3000, reminders: ['20:00', '22:00', '24:00'] },
  ] });
  let spans = [];
  const scheduler = createScheduler({
    store, notifier, now: () => t, goalsRepo: { load: async () => doc },
    fetchPushes: async () => pushes, uptime: { load: async () => spans, save: async s => { spans = s; } }, log: { warn() {}, error: e => { throw e; } },
  });
  const at = async iso => { t = jst(iso); await scheduler.tickOnce(t); };
  // keeps the uptime record continuous between two times, as if the server ticked all along
  const runFrom = async (from, to) => { for (let x = jst(from); x <= jst(to); x += 2 * MIN) recordUptime(spans, x); };
  return { dir, store, sent, at, runFrom, notifier, setNow: v => { t = v; }, now: () => t };
}

test('reminders fire at 20:00 / 22:00 / 24:00 once each, and stop after submitting', async () => {
  const { sent, at, store } = await setup();
  await at('2026-10-27T19:59:00');
  assert.equal(sent.length, 0);
  await at('2026-10-27T20:00:30');
  await at('2026-10-27T20:01:00'); // same reminder again: not re-sent
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'me');
  assert.match(sent[0].title, /腕立て がまだです/);
  await at('2026-10-27T22:00:00');
  assert.equal(sent.length, 2);
  await store.put('submissions', { id: 'sub-1', goalId: 'pushup', windowKey: '2026-10-27', status: 'pending', receivedAt: jst('2026-10-27T23:00:00') });
  await at('2026-10-28T00:00:00');
  assert.equal(sent.length, 2, 'a pending submission stops the reminders');
});

test('stale reminders are skipped after the Mac wakes up', async () => {
  const { sent, at } = await setup();
  await at('2026-10-27T20:30:00');
  assert.equal(sent.length, 0);
});

test('a missed day becomes a ¥3,000 penalty, the wife is told, and it is only settled once', async () => {
  const { sent, at, runFrom, store } = await setup();
  await runFrom('2026-10-27T20:00:00', '2026-10-28T04:10:00');
  await at('2026-10-28T03:30:00'); // inside the grace period: nothing yet
  assert.equal((await store.list('penalties')).length, 0);
  await at('2026-10-28T04:10:00');
  const pens = await store.list('penalties');
  assert.equal(pens.length, 1);
  assert.equal(pens[0].amountYen, 3000);
  assert.equal(pens[0].status, 'unpaid');
  assert.ok(sent.some(m => m.topic === 'wife' && /罰金 ¥3,000/.test(m.title)));
  const before = sent.length;
  await at('2026-10-28T04:12:00');
  assert.equal(sent.length, before);
  assert.equal((await store.list('penalties')).length, 1);
});

test('dry run sends the wife\'s messages to my topic instead', async () => {
  const { sent, at, runFrom } = await setup({ dryRun: true });
  await runFrom('2026-10-27T20:00:00', '2026-10-28T04:10:00');
  await at('2026-10-28T04:10:00');
  assert.ok(sent.every(m => m.topic === 'me'));
  assert.ok(sent.some(m => m.title.startsWith('[お試し・嫁宛]')));
});

test('pending evidence holds the settlement until reviewed; approval means no penalty', async () => {
  const { at, runFrom, store, notifier, now } = await setup();
  await store.put('submissions', { id: 'sub-1', goalId: 'pushup', windowKey: '2026-10-27', status: 'pending', receivedAt: jst('2026-10-27T23:00:00') });
  await runFrom('2026-10-27T20:00:00', '2026-10-28T09:00:00');
  await at('2026-10-28T04:10:00');
  assert.equal((await store.list('settlements')).length, 0);
  await createActions({ store, notifier, now }).review('sub-1', 'approve', 'ok');
  await at('2026-10-28T09:00:00');
  const [s] = await store.list('settlements');
  assert.equal(s.state, 'met');
  assert.equal((await store.list('penalties')).length, 0);
});

test('if the server was down before the deadline, the day is excused and the wife is told', async () => {
  const { sent, at, store } = await setup();
  await at('2026-10-27T12:00:00');
  await at('2026-10-28T04:10:00'); // nothing ran in between
  const [s] = await store.list('settlements');
  assert.equal(s.state, 'excused_down');
  assert.equal((await store.list('penalties')).length, 0);
  assert.ok(sent.some(m => m.topic === 'wife' && /サーバー停止/.test(m.title)));
});

test('a GitHub push inside the window counts automatically', async () => {
  const goals = [{ id: 'dev', title: '開発', type: 'github', period: 'daily', count: 1, penaltyYen: 3000, reminders: ['20:00'] }];
  const { at, runFrom, store } = await setup({ goals, pushes: [{ eventId: '1', repo: 'you/x', at: jst('2026-10-28T02:30:00') }] });
  await runFrom('2026-10-27T20:00:00', '2026-10-28T04:10:00');
  await at('2026-10-28T04:10:00');
  const [s] = await store.list('settlements');
  assert.equal(s.windowKey, '2026-10-27');
  assert.equal(s.state, 'met');
});

test('pushes to excluded repos (automatic backups) do not count', async () => {
  const goals = [{ id: 'dev', title: '開発', type: 'github', period: 'daily', count: 1, penaltyYen: 3000, reminders: [], excludeRepos: ['you/x-data'] }];
  const { at, runFrom, store } = await setup({ goals, pushes: [{ eventId: '1', repo: 'you/x-data', at: jst('2026-10-27T22:00:00') }] });
  await runFrom('2026-10-27T20:00:00', '2026-10-28T04:10:00');
  await at('2026-10-28T04:10:00');
  const [s] = await store.list('settlements');
  assert.equal(s.state, 'missed');
});

test('approving a payment screenshot marks penalties paid and tells the wife', async () => {
  const { store, notifier, sent, now } = await setup();
  await store.put('penalties', { id: 'pen-pushup--2026-10-27', amountYen: 3000, status: 'unpaid' });
  await store.put('submissions', { id: 'sub-pay', kind: 'payment', goalId: '_payment', penaltyIds: ['pen-pushup--2026-10-27'], status: 'pending', receivedAt: 0 });
  await createActions({ store, notifier, now }).review('sub-pay', 'approve', 'PayPay ¥3,000 確認');
  assert.equal((await store.get('penalties', 'pen-pushup--2026-10-27')).status, 'paid');
  assert.ok(sent.some(m => m.topic === 'wife' && /支払いを確認/.test(m.title)));
});

test('uptime coverage', () => {
  const spans = [[0, 100 * MIN], [102 * MIN, 300 * MIN]];
  assert.equal(wasUp(spans, 50 * MIN, 250 * MIN), true);
  assert.equal(wasUp([[0, 100 * MIN], [110 * MIN, 300 * MIN]], 50 * MIN, 250 * MIN), false);
  assert.equal(wasUp([], 0, 10 * MIN), false);
});
