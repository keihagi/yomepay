import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, makeGoal, changeRule, changeState, cleanRule, cleanLooks } from '../server/goals.js';
import { countedWindows, currentWindow, nextCountedWindow, nextPeriodStart, hasStarted, streak, onAt } from '../server/periods.js';
import { windowFor, businessDate } from '../server/windows.js';

const S = { dayBoundary: '03:00', weekStart: 1, startDate: '2026-11-01' };
const jst = s => Date.parse(`${s}+09:00`);
const rule = (r = {}) => ({ requires: ['video'], period: 'daily', penaltyYen: 3000, ...r });
const keys = (g, to, opts) => countedWindows(g, S, jst(to), opts).map(x => x.w.key);

test('monthly windows run from the 1st 03:00 to the next 1st 03:00', () => {
  const w = windowFor({ period: 'monthly' }, jst('2026-11-30T23:00:00'), S);
  assert.equal(w.key, 'M2026-11');
  assert.equal(w.start, jst('2026-11-01T03:00:00'));
  assert.equal(w.end, jst('2026-12-01T03:00:00'));
  assert.equal(w.lastDate, '2026-11-30');
  assert.equal(windowFor({ period: 'monthly' }, jst('2026-12-01T02:00:00'), S).key, 'M2026-11');
});

test('old goals ({ type, period, gps }) are read as rules', () => {
  const { goals } = validate({ goals: [{ id: 'gym', title: 'ジム', type: 'photo_gps', period: 'weekly', count: 2, penaltyYen: 3000, gps: { lat: 1, lng: 2 }, radiusM: 150 }] });
  const [g] = goals;
  assert.deepEqual(g.rules[0].requires, ['photo', 'location']);
  assert.equal(g.rules[0].count, 2);
  assert.equal(g.location.radiusM, 150);
  assert.equal(onAt(g, '2026-11-05'), true);
});

test('rules: github stands alone, at least one condition, sane numbers', () => {
  assert.throws(() => cleanRule(rule({ requires: [] })), /1つ以上/);
  assert.throws(() => cleanRule(rule({ requires: ['github', 'text'] })), /組み合わせ/);
  assert.throws(() => cleanRule(rule({ period: 'weekly', count: 8 })), /回数/);
  assert.deepEqual(cleanRule(rule({ requires: ['location', 'photo'] })).requires, ['photo', 'location']);
});

test('picked weekdays only: other days do not count', () => {
  const [g] = validate({ goals: [{ id: 'gx', title: 'x', rules: [{ from: null, ...rule({ days: [1, 2, 3, 4, 5] }) }] }] }).goals;
  // 11/1 is a Sunday, 11/7 a Saturday
  assert.deepEqual(keys(g, '2026-11-08T03:00:00'), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
});

test('a new goal counts from tomorrow; a weekly one from next Monday; a monthly one from the 1st', () => {
  const t = jst('2026-11-04T21:00:00'); // Wednesday
  const today = businessDate(t, S);
  const daily = makeGoal({ title: 'a', rule: rule() }, today);
  const weekly = makeGoal({ title: 'b', rule: rule({ period: 'weekly', count: 3 }) }, today);
  const monthly = makeGoal({ title: 'c', rule: rule({ period: 'monthly', count: 1 }) }, today);
  assert.equal(currentWindow(daily, S, t).counts, false);
  assert.equal(nextCountedWindow(daily, S, t).w.key, '2026-11-05');
  assert.equal(nextCountedWindow(weekly, S, t).w.key, 'W2026-11-09');
  assert.equal(nextCountedWindow(monthly, S, t).w.key, 'M2026-12');
});

test('pausing or deleting starts tomorrow: today still counts', () => {
  const t = jst('2026-11-04T21:00:00');
  const [g] = validate({ goals: [{ id: 'gx', title: 'x', rules: [{ from: null, ...rule() }] }] }).goals;
  changeState(g, 'pause', { today: '2026-11-04', started: true });
  assert.equal(currentWindow(g, S, t).counts, true);
  assert.deepEqual(keys(g, '2026-11-10T03:00:00'), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  // resuming on 11/7 starts again on 11/8
  changeState(g, 'resume', { today: '2026-11-07', started: true });
  assert.deepEqual(keys(g, '2026-11-10T03:00:00').slice(4), ['2026-11-08', '2026-11-09']);
  // a pause that has not started yet can simply be called off
  const [h] = validate({ goals: [{ id: 'gy', title: 'y', rules: [{ from: null, ...rule() }] }] }).goals;
  changeState(h, 'pause', { today: '2026-11-04', started: true });
  changeState(h, 'resume', { today: '2026-11-04', started: true });
  assert.equal(h.timeline.length, 0);
  // a weekly goal paused mid-week still owes this week
  const [w] = validate({ goals: [{ id: 'gz', title: 'z', rules: [{ from: null, ...rule({ period: 'weekly', count: 2 }) }] }] }).goals;
  changeState(w, 'delete', { today: '2026-11-04', started: true });
  assert.deepEqual(keys(w, '2026-11-30T03:00:00'), ['W2026-11-02']);
});

test('a goal that never counted anything is deleted at once', () => {
  const g = makeGoal({ title: 'a', rule: rule() }, '2026-11-04');
  assert.equal(hasStarted(g, S, jst('2026-11-04T21:00:00')), false);
  assert.equal(changeState(g, 'delete', { today: '2026-11-04', started: false }), '2026-11-04');
  assert.equal(nextCountedWindow(g, S, jst('2026-11-04T21:00:00')), null);
});

test('rule changes wait for the next period; the old windows keep their own rule', () => {
  const t = jst('2026-11-04T21:00:00'); // Wednesday
  const [g] = validate({ goals: [{ id: 'gx', title: 'x', rules: [{ from: null, ...rule({ period: 'weekly', count: 2 }) }] }] }).goals;
  const effective = nextPeriodStart(g, S, t);
  assert.equal(effective, '2026-11-09');
  changeRule(g, rule({ period: 'daily', penaltyYen: 1000 }), { today: '2026-11-04', effective, started: true });
  assert.equal(currentWindow(g, S, t).g.period, 'weekly', 'this week keeps the old rule');
  const ws = countedWindows(g, S, jst('2026-11-11T03:00:00'));
  assert.deepEqual(ws.map(x => x.w.key), ['W2026-11-02', '2026-11-09', '2026-11-10']);
  assert.equal(ws[1].g.penaltyYen, 1000);
  // changing it back before it starts drops the scheduled change
  changeRule(g, rule({ period: 'weekly', count: 2 }), { today: '2026-11-05', effective, started: true });
  assert.equal(g.rules.length, 1);
});

test('streak: met in a row; an exception or a running window does not break it, a miss does', () => {
  const [g] = validate({ goals: [{ id: 'gx', title: 'x', rules: [{ from: null, ...rule() }] }] }).goals;
  const states = { '2026-11-01': 'met', '2026-11-02': 'met', '2026-11-03': 'missed', '2026-11-04': 'met', '2026-11-05': 'exempt', '2026-11-06': 'met', '2026-11-07': 'open' };
  const s = streak(g, S, jst('2026-11-07T21:00:00'), ({ w }) => states[w.key]);
  assert.deepEqual(s, { current: 2, best: 2, total: 4 });
});

test('a new goal cannot lose its start; pausing it before it starts is immediate', () => {
  const g = makeGoal({ title: 'a', rule: rule() }, '2026-11-04');
  changeState(g, 'cancel', { today: '2026-11-04', started: false });
  assert.equal(g.timeline.length, 1);
  assert.equal(nextCountedWindow(g, S, jst('2026-11-04T21:00:00')).w.key, '2026-11-05');
  assert.equal(changeState(g, 'pause', { today: '2026-11-04', started: false }), '2026-11-04');
  assert.equal(onAt(g, '2026-11-04'), false);
  assert.equal(nextCountedWindow(g, S, jst('2026-11-04T21:00:00')), null);
  assert.throws(() => changeState(g, 'pause', { today: '2026-11-04', started: false }), /すでに/);
  // resuming counts from tomorrow
  assert.equal(changeState(g, 'resume', { today: '2026-11-06', started: false }), '2026-11-07');
  assert.deepEqual(keys(g, '2026-11-09T12:00:00'), ['2026-11-07', '2026-11-08']);
});

test('an old goal that has not started yet (real data before 11/1) pauses at once too', () => {
  const { goals: [g] } = validate({ settings: S, goals: [{ id: 'pushup', title: '腕立て', type: 'video', period: 'daily', penaltyYen: 3000 }] });
  assert.equal(changeState(g, 'pause', { today: '2026-10-31', started: false }), '2026-10-31');
  assert.deepEqual(keys(g, '2026-11-05T12:00:00'), []);
  changeState(g, 'resume', { today: '2026-11-02', started: false });
  assert.deepEqual(keys(g, '2026-11-05T12:00:00'), ['2026-11-03', '2026-11-04']);
});

test('github goals keep a cleaned list of accounts; editing other things keeps it', () => {
  const g = makeGoal({ title: 'dev', rule: rule({ requires: ['github'] }), github: { accounts: ' Me-Main, @work-acct bad_name! me-main', excludeRepos: 'me-main/backup' } }, '2026-11-01');
  assert.deepEqual(g.github.accounts, ['me-main', 'work-acct']);
  assert.deepEqual(g.github.excludeRepos, ['me-main/backup']);
  assert.deepEqual(cleanLooks({ title: 'dev2' }, g).github.accounts, ['me-main', 'work-acct']);
  assert.deepEqual(cleanLooks({ github: { excludeRepos: '' } }, g).github.accounts, ['me-main', 'work-acct']); // older page
  assert.deepEqual(cleanLooks({ github: { excludeRepos: '', accounts: '' } }, g).github.accounts, []);
});
