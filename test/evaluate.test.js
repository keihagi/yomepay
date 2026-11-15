import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWindow } from '../server/evaluate.js';

const goal = { id: 'reading', period: 'daily', count: 1, penaltyYen: 3000 };
const window = { key: '2026-11-05', start: 0, end: 1000 };
const sub = (status, receivedAt, note) => ({ id: `s${receivedAt}`, goalId: 'reading', windowKey: '2026-11-05', status, receivedAt, review: note ? { note } : undefined });

test('the latest rejected try is shown, with its reason', () => {
  const r = evaluateWindow({ goal, window, submissions: [sub('rejected', 10, 'Too generic')], now: 500, graceMs: 0 });
  assert.equal(r.rejected.note, 'Too generic');
  assert.equal(r.rejected.id, 's10');
  assert.equal(r.state, 'open');
});

test('a newer try clears the rejection', () => {
  const r = evaluateWindow({ goal, window, submissions: [sub('rejected', 10, 'Too generic'), sub('pending', 20)], now: 500, graceMs: 0 });
  assert.equal(r.rejected, null);
  assert.equal(r.pending, 1);
});
