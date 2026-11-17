// The clockwork: runs every ~30 seconds and
//   1. sends deadline reminders (each goal's "HH:MM" times on its last day, plus a morning warning for weekly goals;
//      weekly/monthly goals with remindDaily also get them on every day nothing was submitted yet)
//   2. settles windows once their deadline (+ grace) has passed: met / exempt / missed → penalty + messages
//   3. nags about unpaid penalties (you twice a day, the wife once a day)
//   4. reminds you when evidence has been waiting for review too long
// Reminders only fire within a few minutes of their time, so after the Mac was asleep, stale ones are skipped
// while settling still catches up. If the server itself was down during a window's last hours, that window is
// excused (you could not submit), and the wife is told.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fireTime, businessDate, daysLeft, fmt, fmtLeft, windowLabel } from './windows.js';
import { countedWindows, currentWindow } from './periods.js';
import { evaluateWindow } from './evaluate.js';
import { syncPushes } from './github.js';
import { paymentProvider } from './payments/manual-paypay.js';
import { L } from './i18n.js';

const MIN = 60e3, H = 60 * MIN;
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const UP_GAP = 3 * MIN;           // a gap longer than this between ticks counts as "down"
const UP_CHECK = 4 * H;           // the server must have been up for the last 4 hours of a window

export function recordUptime(spans, t) {
  const last = spans[spans.length - 1];
  if (last && t >= last[1] && t - last[1] <= UP_GAP) last[1] = t;
  else spans.push([t, t]);
  while (spans.length && spans[0][1] < t - 60 * 24 * H) spans.shift();
  return spans;
}

/** Whether the server was running for all of [from, to], allowing gaps up to UP_GAP. */
export function wasUp(spans, from, to) {
  let cursor = from;
  for (const [a, b] of spans) {
    if (b < cursor) continue;
    if (a > cursor + UP_GAP) return false;
    cursor = Math.max(cursor, b);
    if (cursor >= to - UP_GAP) return true;
  }
  return cursor >= to - UP_GAP;
}

export function fileUptime(dataDir) {
  const file = path.join(dataDir, 'uptime.json');
  return {
    async load() { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; } },
    async save(spans) { await fs.writeFile(file, JSON.stringify(spans)); },
  };
}

const usesGithub = g => g.rules.some(r => r.requires.includes('github'));

export function createScheduler({ store, notifier, goalsRepo, fetchPushes, now, uptime, log = console }) {
  let lastGithubAt = 0, githubOk = false, running = false, spans = null, timer = null;

  async function githubSync(goals, settings, force = false) {
    if (!fetchPushes || !goals.some(usesGithub)) return { ok: true, created: [] };
    const t = now();
    if (!force && t - lastGithubAt < 15 * MIN) return { ok: githubOk, created: [] };
    lastGithubAt = t;
    try {
      const named = goals.filter(usesGithub).flatMap(g => g.github?.accounts || []); // accounts a goal names itself
      const created = await syncPushes({ store, goals, settings, pushes: await fetchPushes(named), now });
      githubOk = true;
      return { ok: true, created };
    } catch (e) {
      log.warn('[github]', e.message);
      githubOk = false;
      return { ok: false, created: [] };
    }
  }

  async function tickOnce(t) {
    const { settings, goals } = await goalsRepo.load();
    const graceMs = settings.graceMinutes * MIN;
    const near = at => t >= at && t < at + settings.reminderWindowMinutes * MIN;
    const today = businessDate(t, settings);
    const send = notifier.send;

    spans ??= await uptime.load();
    recordUptime(spans, t);
    await uptime.save(spans);

    await githubSync(goals, settings);
    let subs = await store.list('submissions');
    const exemptions = await store.list('exemptions');
    const exemptionsFor = (g, key) => exemptions.filter(e => e.goalId === g.id && e.windowKey === key);

    // 1. reminders
    for (const goal of goals) {
      const { g, w, counts } = currentWindow(goal, settings, t);
      if (!counts) continue;
      const ev = evaluateWindow({ goal: g, window: w, submissions: subs, exemptions: exemptionsFor(g, w.key), now: t, graceMs });
      if (ev.state !== 'open' || ev.submitted >= ev.required) continue;
      const remaining = ev.required - ev.submitted;
      const doneToday = subs.some(s => s.goalId === g.id && s.windowKey === w.key && s.status !== 'rejected'
        && businessDate(s.submittedAt ?? s.receivedAt, settings) === today);
      if (today !== w.lastDate && g.period !== 'daily' && g.remindDaily && !doneToday) {
        const left = daysLeft(w, today);
        for (const hm of g.reminders) {
          if (!near(fireTime(today, hm, settings))) continue;
          await send({
            to: 'me', key: `rem-${g.id}-${w.key}-${today}-${hm}`,
            title: L(`${g.title}: 今日はまだです`, `${g.title}: not done today`),
            message: L(`${g.period === 'weekly' ? '今週' : '今月'}あと${remaining}回（残り${left}日）。締め切り ${fmt(w.end)}。`,
              `${remaining} more ${g.period === 'weekly' ? 'this week' : 'this month'} (${left} day${left > 1 ? 's' : ''} left). Deadline ${fmt(w.end)}.`),
            priority: 3, tags: ['alarm_clock'],
          });
        }
      }
      if (today === w.lastDate) {
        for (const [i, hm] of g.reminders.entries()) {
          if (!near(fireTime(today, hm, settings))) continue;
          const last = i === g.reminders.length - 1;
          await send({
            to: 'me', key: `rem-${g.id}-${w.key}-${hm}`,
            title: L(`${last ? '【ラスト】' : ''}${g.title} がまだです`, `${last ? '[LAST] ' : ''}${g.title} is not done yet`),
            message: L(`${remaining > 1 ? `あと${remaining}回。` : ''}締め切り ${fmt(w.end)}（${fmtLeft(w.end - t)}）。未達なら嫁に ${yen(remaining * g.penaltyYen)}。`,
              `${remaining > 1 ? `${remaining} more to go. ` : ''}Deadline ${fmt(w.end)} (${fmtLeft(w.end - t)}). If missed, ${yen(remaining * g.penaltyYen)} goes to your wife.`),
            priority: last ? 5 : i === g.reminders.length - 2 ? 4 : 3, tags: ['alarm_clock'],
          });
        }
      }
      if (g.period !== 'daily' && near(fireTime(today, settings.morning, settings))) {
        const left = daysLeft(w, today);
        if (remaining >= left) await send({
          to: 'me', key: `tight-${g.id}-${today}`, title: L(`${g.title}: ${g.period === 'weekly' ? '今週' : '今月'}あと${remaining}回`, `${g.title}: ${remaining} more ${g.period === 'weekly' ? 'this week' : 'this month'}`),
          message: L(`残り${left}日で${remaining}回必要です。締め切り ${fmt(w.end)}。`, `${remaining} needed in the ${left} day${left > 1 ? 's' : ''} left. Deadline ${fmt(w.end)}.`), priority: 4, tags: ['warning'],
        });
      }
    }

    // 2. settle windows whose deadline + grace has passed
    const settled = new Set((await store.list('settlements')).map(s => s.id));
    let awaiting = 0;
    for (const goal of goals) {
      const due = countedWindows(goal, settings, t - graceMs).filter(({ w }) => !settled.has(`${goal.id}--${w.key}`));
      if (!due.length) continue;
      if (due.some(({ rule }) => rule.requires.includes('github'))) {
        const r = await githubSync(goals, settings, true);
        if (!r.ok) continue; // never fine anyone because GitHub could not be reached
        subs = await store.list('submissions');
      }
      for (const { w, g } of due) {
        const ev = evaluateWindow({ goal: g, window: w, submissions: subs, exemptions: exemptionsFor(g, w.key), now: t, graceMs });
        if (ev.state === 'awaiting_review') { awaiting++; continue; }
        const label = windowLabel(w);
        let state = ev.state;
        if (state === 'missed' && !wasUp(spans, w.end - UP_CHECK, w.end)) state = 'excused_down';
        await store.put('settlements', {
          id: `${g.id}--${w.key}`, goalId: g.id, windowKey: w.key, state, approved: ev.approved, required: ev.required,
          penaltyYen: state === 'missed' ? ev.penaltyYen : 0, settledAt: t,
        });
        if (state === 'excused_down') {
          await send({ to: 'wife', key: `down-wife-${g.id}-${w.key}`, title: L(`免除（サーバー停止）: ${g.title} ${label}`, `Excused (server was down): ${g.title} ${label}`),
            message: L('締め切り前にアプリのサーバーが止まっていて提出できなかったため、今回は罰金なしです。', 'The app\'s server was down before the deadline, so nothing could be submitted. No penalty this time.'), priority: 3 });
          await send({ to: 'me', key: `down-me-${g.id}-${w.key}`, title: L(`サーバー停止のため免除: ${g.title} ${label}`, `Excused, server was down: ${g.title} ${label}`),
            message: L('Mac がスリープ・停止していないか確認してください。嫁にも通知済みです。', 'Check that the Mac is not asleep or off. Your wife has been told.'), priority: 4 });
          continue;
        }
        if (state !== 'missed' || ev.penaltyYen <= 0) continue;
        const pen = {
          id: `pen-${g.id}--${w.key}`, goalId: g.id, goalTitle: g.title, windowKey: w.key, label,
          missing: ev.missing, amountYen: ev.penaltyYen, status: 'unpaid', createdAt: t, provider: paymentProvider.id,
        };
        await store.put('penalties', pen);
        const total = (await store.list('penalties')).filter(p => p.status !== 'paid').reduce((a, p) => a + p.amountYen, 0);
        await send({ to: 'wife', key: `pen-wife-${pen.id}`, title: L(`罰金 ${yen(pen.amountYen)} が発生しました`, `Penalty of ${yen(pen.amountYen)}`),
          message: L(`${g.title}（${label}）が未達でした。未払い合計 ${yen(total)}。`, `${g.title} (${label}) was missed. Unpaid in total: ${yen(total)}.`), priority: 4, tags: ['money_with_wings'] });
        await send({ to: 'me', key: `pen-me-${pen.id}`, title: L(`罰金確定 ${yen(pen.amountYen)}: ${g.title}（${label}）`, `Penalty ${yen(pen.amountYen)}: ${g.title} (${label})`),
          message: paymentProvider.howToPay(total), priority: 5, tags: ['rotating_light'] });
      }
    }

    // 3. unpaid penalties
    const penalties = await store.list('penalties');
    const unpaid = penalties.filter(p => p.status !== 'paid');
    if (unpaid.length) {
      const total = unpaid.reduce((a, p) => a + p.amountYen, 0);
      const proofWaiting = subs.some(s => s.kind === 'payment' && s.status === 'pending');
      for (const hm of settings.nagTimes) {
        if (!proofWaiting && near(fireTime(today, hm, settings))) await send({
          to: 'me', key: `nag-${today}-${hm}`, title: L(`未払いの罰金 ${yen(total)}（${unpaid.length}件）`, `Unpaid penalties: ${yen(total)} (${unpaid.length})`),
          message: paymentProvider.howToPay(total), priority: 4, tags: ['money_with_wings'],
        });
      }
      if (near(fireTime(today, settings.wifeDigest, settings))) await send({
        to: 'wife', key: `digest-${today}`, title: L(`未払いの罰金 ${yen(total)}`, `Unpaid penalties: ${yen(total)}`),
        message: unpaid.map(p => `・${p.goalTitle} ${p.label} ${yen(p.amountYen)}`).join('\n'), priority: 3,
      });
    }

    // 4. evidence waiting too long for review
    const stale = subs.filter(s => s.status === 'pending' && t - s.receivedAt > 12 * H).length;
    if ((stale || awaiting) && near(fireTime(today, settings.morning, settings))) await send({
      to: 'me', key: `stale-${today}`, title: L(`審査待ちが ${Math.max(stale, awaiting)} 件あります`, `${Math.max(stale, awaiting)} waiting for review`),
      message: L('Mac の Claude Code で /yome-review を実行してください（Codex なら「yomepay の審査をして」）。審査が終わるまで締め切りの判定が止まっています。',
        'Run /yome-review in Claude Code on the Mac (or ask Codex to "review yomepay"). Deadlines are on hold until it is done.'), priority: 3,
    });
  }

  async function tick() {
    if (running) return;
    running = true;
    try { await tickOnce(now()); }
    catch (e) { log.error('[scheduler]', e); }
    finally { running = false; }
  }

  return {
    tick, tickOnce,
    githubSync: async force => { const { settings, goals } = await goalsRepo.load(); return githubSync(goals, settings, force); },
    start(ms) { tick(); timer = setInterval(tick, ms); },
    stop() { clearInterval(timer); },
  };
}
