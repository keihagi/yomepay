// Checks GitHub for pushes, using the `gh` CLI's sign-ins on this Mac.
// It reads each account's own event feed, so a push to any repository under that account counts (private ones
// too, when `gh` is signed in as that account). Several accounts can count for one goal: a push from any of them
// is enough. The event time is set by GitHub's servers when the push arrives, so commit dates you set yourself
// do not count.
import { execFile } from 'node:child_process';
import { windowFor, businessDate } from './windows.js';
import { ruleAt, withRule, counts } from './periods.js';
import { L } from './i18n.js';

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

/** GitHub logins from a list or a "a, b" string: trimmed, lowercased, without "@", invalid ones dropped. */
export function cleanLogins(v) {
  const items = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  return [...new Set(items.map(s => String(s).trim().replace(/^@/, '').toLowerCase()).filter(s => LOGIN.test(s)))];
}

function ghRunner(ghBin) {
  return (args, extraEnv) => new Promise((resolve, reject) => {
    execFile(ghBin, args, { timeout: 20000, maxBuffer: 20e6, env: extraEnv ? { ...process.env, ...extraEnv } : process.env },
      (err, stdout, stderr) => (err ? reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message).trim()}`)) : resolve(stdout)));
  });
}

/** The github.com accounts `gh` is signed in to on this Mac. */
async function signedInWith(gh) {
  try {
    const out = await gh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts', '--jq', '[.hosts["github.com"][]? | select(.state == "success") | .login]']);
    return cleanLogins(JSON.parse(out.trim() || '[]'));
  } catch { return []; }
}
export const ghAccounts = ghBin => signedInWith(ghRunner(ghBin));

/**
 * Returns fetchPushes(goalAccounts): every push of the accounts that count.
 * - `users` (YOMEPAY_GITHUB_USER) are the default accounts. Without them, every account `gh` is signed in to.
 * - `goalAccounts` are accounts that a goal names itself; they are read too.
 * Each push says which account made it and whether that account is a default one (goals without their own
 * account list only count default accounts). An account `gh` is not signed in to is read through the public
 * feed, so only its public pushes are seen.
 */
export function fetchPushesWithGh({ ghBin, users = [] }) {
  const gh = ghRunner(ghBin);
  return async (goalAccounts = []) => {
    const signedIn = await signedInWith(gh);
    let defaults = cleanLogins(users);
    if (!defaults.length) defaults = signedIn;
    if (!defaults.length) defaults = cleanLogins([(await gh(['api', 'user', '--jq', '.login'])).trim()]);
    const pushes = [];
    for (const login of new Set([...defaults, ...cleanLogins(goalAccounts)])) {
      // Its own token shows private repos; otherwise the active account reads the public feed.
      const env = signedIn.includes(login) ? { GH_TOKEN: (await gh(['auth', 'token', '--hostname', 'github.com', '--user', login])).trim() } : undefined;
      for (let page = 1; page <= 3; page++) {
        const events = JSON.parse(await gh(['api', `/users/${login}/events?per_page=100&page=${page}`], env));
        for (const e of events) {
          if (e.type === 'PushEvent') pushes.push({ eventId: String(e.id), repo: e.repo?.name || '?', at: Date.parse(e.created_at), account: login, isDefault: defaults.includes(login) });
        }
        if (events.length < 100) break;
      }
    }
    return pushes;
  };
}

/** Does this push count for this goal? Goals that name accounts take only those; others take the default accounts. */
function fromCountedAccount(goal, p) {
  const accounts = cleanLogins(goal.github?.accounts);
  if (accounts.length) return accounts.includes(String(p.account || '').toLowerCase());
  return p.isDefault !== false;
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
      if (excluded.has(p.repo.toLowerCase()) || !fromCountedAccount(goal, p)) continue;
      const date = businessDate(p.at, settings);
      const rule = ruleAt(goal, date);
      if (!rule?.requires.includes('github')) continue;
      const w = windowFor(withRule(goal, rule), p.at, settings);
      if (!counts(goal, rule, w, settings)) continue;
      const id = `gh-${goal.id}-${date}`;
      if (await store.has('submissions', id)) continue;
      const sub = {
        id, goalId: goal.id, kind: 'github', windowKey: w.key, submittedAt: p.at, receivedAt: now(),
        status: 'approved', github: { repo: p.repo, account: p.account || null, eventId: p.eventId, at: p.at },
        review: { by: 'auto', at: now(), note: L(`${p.repo} へのpush`, `push to ${p.repo}`) },
      };
      await store.put('submissions', sub);
      created.push(sub);
    }
  }
  return created;
}
