// Decides where a goal's window stands, from the evidence submitted for it. Pure: no clock, no disk.
//
// States:
//   open            — still running (or inside the grace period after the deadline)
//   met             — enough approved evidence
//   exempt          — an exception (特例) covers it: a daily window is skipped; for weekly/monthly windows each
//                     exception lowers the required count by one, and when nothing is left it is exempt
//   awaiting_review — closed, and it would be met if the evidence still waiting for review is approved
//   missed          — closed and short; costs penaltyYen for every missing time
export function evaluateWindow({ goal, window, submissions, exemptions, exemption, now, graceMs }) {
  const mine = submissions.filter(s => s.goalId === goal.id && s.windowKey === window.key);
  const approved = mine.filter(s => s.status === 'approved').length;
  const pending = mine.filter(s => s.status === 'pending').length;
  // the latest try was rejected (and nothing newer is waiting): the card says so, with the reason
  const last = [...mine].sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0];
  const rejected = last?.status === 'rejected' ? { id: last.id, note: last.review?.note || '' } : null;
  const ex = exemptions ? exemptions.length : exemption ? 1 : 0;
  const count = goal.count || 1;
  const required = goal.period === 'daily' || !goal.period ? (ex ? 0 : count) : Math.max(0, count - ex);
  const closed = now >= window.end + graceMs;
  let state;
  if (required === 0) state = 'exempt';
  else if (approved >= required) state = 'met';
  else if (!closed) state = 'open';
  else if (approved + pending >= required) state = 'awaiting_review';
  else state = 'missed';
  const missing = Math.max(0, required - approved);
  return {
    key: window.key, start: window.start, end: window.end, firstDate: window.firstDate, lastDate: window.lastDate,
    required, count, exempted: ex, approved, pending, submitted: approved + pending, state, rejected,
    missing: state === 'missed' ? missing : 0,
    penaltyYen: state === 'missed' ? missing * (goal.penaltyYen || 0) : 0,
  };
}
