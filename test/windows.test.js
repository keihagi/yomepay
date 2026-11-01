import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, windowFor, windowByKey, fireTime, endedWindows, recentWindows, daysLeft, fmt } from '../server/windows.js';
import { evaluateWindow } from '../server/evaluate.js';

const S = { dayBoundary: '03:00', weekStart: 1 };
const jst = s => Date.parse(`${s}+09:00`);
const daily = { id: 'pushup', period: 'daily', count: 1, penaltyYen: 3000 };
const weekly = { id: 'gym', period: 'weekly', count: 2, penaltyYen: 3000 };

test('the business day runs 03:00 to 03:00', () => {
  assert.equal(businessDate(jst('2026-10-27T02:59:59'), S), '2026-10-26');
  assert.equal(businessDate(jst('2026-10-27T03:00:00'), S), '2026-10-27');
  assert.equal(businessDate(jst('2026-10-27T23:59:00'), S), '2026-10-27');
  assert.equal(businessDate(jst('2026-10-28T01:30:00'), S), '2026-10-27');
});

test('daily window for 10/27 closes 10/28 03:00', () => {
  const w = windowFor(daily, jst('2026-10-28T01:00:00'), S);
  assert.equal(w.key, '2026-10-27');
  assert.equal(w.start, jst('2026-10-27T03:00:00'));
  assert.equal(w.end, jst('2026-10-28T03:00:00'));
  assert.deepEqual(windowByKey(daily, '2026-10-27', S), w);
});

test('weekly window runs Monday 03:00 to next Monday 03:00', () => {
  // 2026-10-26 is a Monday
  const w = windowFor(weekly, jst('2026-10-29T12:00:00'), S);
  assert.equal(w.key, 'W2026-10-26');
  assert.equal(w.start, jst('2026-10-26T03:00:00'));
  assert.equal(w.end, jst('2026-11-02T03:00:00'));
  assert.equal(w.lastDate, '2026-11-01');
  // Monday 02:00 still belongs to the previous week
  assert.equal(windowFor(weekly, jst('2026-11-02T02:00:00'), S).key, 'W2026-10-26');
  assert.equal(windowFor(weekly, jst('2026-11-02T03:00:00'), S).key, 'W2026-11-02');
  assert.equal(daysLeft(w, '2026-10-31'), 2);
  assert.equal(windowByKey(weekly, 'W2026-10-26', S).key, 'W2026-10-26');
});

test('reminder times: 20:00, 22:00, 24:00 and after-midnight times', () => {
  assert.equal(fireTime('2026-10-27', '20:00', S), jst('2026-10-27T20:00:00'));
  assert.equal(fireTime('2026-10-27', '24:00', S), jst('2026-10-28T00:00:00'));
  assert.equal(fireTime('2026-10-27', '02:30', S), jst('2026-10-28T02:30:00'));
  assert.equal(fmt(fireTime('2026-10-27', '22:00', S)), '10/27 22:00');
});

test('endedWindows starts at startDate and skips a week already under way', () => {
  const ds = endedWindows(daily, '2026-10-27', jst('2026-10-30T03:00:00'), S).map(w => w.key);
  assert.deepEqual(ds, ['2026-10-27', '2026-10-28', '2026-10-29']);
  // starting on Wednesday: the first weekly window counted is the next Monday's
  const ws = endedWindows(weekly, '2026-10-28', jst('2026-11-16T03:00:00'), S).map(w => w.key);
  assert.deepEqual(ws, ['W2026-11-02', 'W2026-11-09']);
  assert.equal(recentWindows(daily, jst('2026-10-27T12:00:00'), S, 3).map(w => w.key).join(), '2026-10-25,2026-10-26,2026-10-27');
});

test('evaluateWindow states', () => {
  const w = windowFor(weekly, jst('2026-10-27T12:00:00'), S);
  const sub = status => ({ goalId: 'gym', windowKey: w.key, status });
  const ev = (subs, now, exemption) => evaluateWindow({ goal: weekly, window: w, submissions: subs, exemption, now, graceMs: 65 * 60e3 });
  const during = jst('2026-10-30T12:00:00'), inGrace = w.end + 30 * 60e3, after = w.end + 66 * 60e3;
  assert.equal(ev([sub('approved')], during).state, 'open');
  assert.equal(ev([sub('approved'), sub('approved')], during).state, 'met');
  assert.equal(ev([sub('approved')], inGrace).state, 'open');
  assert.equal(ev([sub('approved'), sub('pending')], after).state, 'awaiting_review');
  const missed = ev([sub('approved'), sub('rejected')], after);
  assert.equal(missed.state, 'missed');
  assert.equal(missed.penaltyYen, 3000);
  assert.equal(ev([], after).penaltyYen, 6000); // two missing times
  // an exception (特例) on a weekly goal takes one time off; two take both
  assert.equal(evaluateWindow({ goal: weekly, window: w, submissions: [sub('approved')], exemptions: [{ id: 'x' }], now: after, graceMs: 0 }).state, 'met');
  assert.equal(evaluateWindow({ goal: weekly, window: w, submissions: [], exemptions: [{ id: 'x' }], now: after, graceMs: 0 }).penaltyYen, 3000);
  assert.equal(evaluateWindow({ goal: weekly, window: w, submissions: [], exemptions: [{ id: 'x' }, { id: 'y' }], now: after, graceMs: 0 }).state, 'exempt');
  assert.equal(evaluateWindow({ goal: daily, window: windowFor(daily, jst('2026-10-27T12:00:00'), S), submissions: [], exemptions: [{ id: 'x' }], now: after, graceMs: 0 }).state, 'exempt');
});
