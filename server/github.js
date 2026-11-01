// Checks GitHub for pushes, using the `gh` CLI's sign-in on this Mac.
// It reads your own event feed (private repos included when signed in as you). The event time is set by
// GitHub's servers when the push arrives, so commit dates you set yourself do not count.
import { execFile } from 'node:child_process';
import { windowFor, businessDate } from './windows.js';
import { ruleAt, withRule, counts } from './periods.js';
import { L } from './i18n.js';

// `user` is optional: without it, the account `gh` is signed in as is used.
export function fetchPushesWithGh({ ghBin, user }) {
  const gh = args => new Promise((resolve, reject) => {
    execFile(ghBin, args, { timeout: 20000, maxBuffer: 20e6 },
      (err, stdout, stderr) => (err ? reject(new Error(`gh ${args[1] || ''} failed: ${(stderr || err.message).trim()}`)) : resolve(stdout)));
  });
  let login = user;
  return async () => {
    login ||= (await gh(['api', 'user', '--jq', '.login'])).trim();
    const pushes = [];
    for (let page = 1; page <= 3; page++) {
      const events = JSON.parse(await gh(['api', `/users/${login}/events?per_page=100&page=${page}`]));
      for (const e of events) if (e.type === 'PushEvent') pushes.push({ eventId: String(e.id), repo: e.repo?.name || '?', at: Date.parse(e.created_at) });
      if (events.length < 100) break;
    }
    return pushes;
  };
}

/**
 * Turns pushes into approved submissions: one per goal and business day, so "3 times a week" means pushes
 * on 3 different days. Returns the submissions it created.
 */
export async function syncPushes({ store, goals, settings, pushes, now }) {
  const created = [];
  for (const goal of goals) {
    // Automatic pushes (like encrypted backup repos) are not development.
    const excluded = new Set((goal.github?.excludeRepos || goal.excludeRepos || []).map(r => r.toLowerCase()));
    for (const p of [...pushes].sort((a, b) => a.at - b.at)) {
      if (excluded.has(p.repo.toLowerCase())) continue;
      const date = businessDate(p.at, settings);
      const rule = ruleAt(goal, date);
      if (!rule?.requires.includes('github')) continue;
      const w = windowFor(withRule(goal, rule), p.at, settings);
      if (!counts(goal, rule, w, settings)) continue;
      const id = `gh-${goal.id}-${date}`;
      if (await store.has('submissions', id)) continue;
      const sub = {
        id, goalId: goal.id, kind: 'github', windowKey: w.key, submittedAt: p.at, receivedAt: now(),
        status: 'approved', github: { repo: p.repo, eventId: p.eventId, at: p.at },
        review: { by: 'auto', at: now(), note: L(`${p.repo} へのpush`, `push to ${p.repo}`) },
      };
      await store.put('submissions', sub);
      created.push(sub);
    }
  }
  return created;
}
