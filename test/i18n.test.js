import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang, getLang } from '../server/i18n.js';
import { fmt, fmtDate, fmtLeft, windowLabel } from '../server/windows.js';
import { instructionFor } from '../server/proof.js';
import { validate, cleanRule } from '../server/goals.js';

const jst = s => Date.parse(`${s}+09:00`);

test('English: dates, countdowns and window labels', () => {
  setLang('en');
  try {
    assert.equal(fmt(jst('2026-11-05T21:30:00')), 'Thu 11/5 21:30');
    assert.equal(fmtDate('M2026-11'), 'November');
    assert.equal(fmtLeft(2 * 36e5 + 15 * 6e4), '2h 15m left');
    assert.equal(windowLabel({ key: 'W2026-11-02', firstDate: '2026-11-02', lastDate: '2026-11-08' }), 'week of 11/2');
    for (let i = 0; i < 30; i++) assert.match(instructionFor(['video']), /^At the start of the recording, hold up \d fingers?( \(open hand\))? on your (right|left) hand to the camera, then begin$/);
    assert.match(instructionFor(['photo', 'location']), /^Hold up .* the place in the same shot$/);
    assert.throws(() => cleanRule({ requires: [], period: 'daily' }), /Pick at least one/);
  } finally { setLang('ja'); }
});

test('Japanese is the default, and loading goals sets the language', () => {
  assert.equal(getLang(), 'ja');
  assert.equal(fmtDate('M2026-11'), '11月');
  validate({ settings: { lang: 'en' }, goals: [] });
  assert.equal(getLang(), 'en');
  validate({ settings: { lang: 'xx' }, goals: [] });
  assert.equal(getLang(), 'ja');
});
