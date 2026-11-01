// Approving and rejecting evidence. Shared by the server and the review CLI (scripts/review.mjs).
import { L } from './i18n.js';

const yen = n => '¥' + Number(n).toLocaleString('ja-JP');

export function createActions({ store, notifier, now }) {
  async function review(id, decision, note = '', by = 'claude-code') {
    if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
    const s = await store.get('submissions', id);
    if (!s) throw new Error(`No submission ${id}`);
    if (s.status !== 'pending') throw new Error(`${id} is already ${s.status}`);
    s.status = decision === 'approve' ? 'approved' : 'rejected';
    s.review = { by, at: now(), note: String(note).slice(0, 500) };
    await store.put('submissions', s);

    if (s.kind === 'payment' && s.status === 'approved') {
      let total = 0;
      for (const pid of s.penaltyIds || []) {
        const p = await store.get('penalties', pid);
        if (!p || p.status === 'paid') continue;
        Object.assign(p, { status: 'paid', paidAt: now(), proofSubmissionId: s.id });
        await store.put('penalties', p);
        total += p.amountYen;
      }
      const left = (await store.list('penalties')).filter(p => p.status !== 'paid').reduce((a, p) => a + p.amountYen, 0);
      await notifier.send({ to: 'wife', key: `paid-wife-${s.id}`, title: L(`罰金 ${yen(total)} の支払いを確認しました`, `Penalty payment of ${yen(total)} confirmed`),
        message: left ? L(`まだ未払いが ${yen(left)} あります。`, `${yen(left)} is still unpaid.`) : L('未払いはありません。', 'Nothing is unpaid.'), priority: 3, tags: ['white_check_mark'] });
      await notifier.send({ to: 'me', key: `paid-me-${s.id}`, title: L(`支払い確認: ${yen(total)}`, `Payment confirmed: ${yen(total)}`), message: left ? L(`残りの未払い ${yen(left)}`, `Still unpaid: ${yen(left)}`) : L('未払いはゼロになりました。', 'Nothing is unpaid now.'), priority: 3 });
    }
    if (s.status === 'rejected') {
      await notifier.send({ to: 'me', key: `rejected-${s.id}`, title: L(`却下されました: ${s.goalTitle || s.goalId}`, `Rejected: ${s.goalTitle || s.goalId}`),
        message: `${note || L('証拠として認められませんでした。', 'This was not accepted as proof.')} ${L('締め切り前なら撮り直して再提出できます。', 'Before the deadline you can redo it and submit again.')}`, priority: 4, tags: ['x'] });
    }
    return s;
  }
  return { review };
}
