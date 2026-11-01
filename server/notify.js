// Sends push notifications through ntfy (https://ntfy.sh or your own server).
// Each message with a `key` is sent once: the key is written to notifications/ after delivery.
// While dryRun is on, messages for the wife go to your own topic, marked as a trial.
import { L } from './i18n.js';

const idFor = key => ('n-' + key.replace(/[^A-Za-z0-9-]/g, '-')).slice(0, 96);

export function createNotifier({ store, secrets, dryRun, now, fetchImpl = globalThis.fetch, log = console }) {
  async function send({ to = 'me', key, title, message, priority = 3, tags = [] }) {
    const id = key ? idFor(key) : null;
    if (id && await store.has('notifications', id)) return { skipped: true };
    const s = secrets();
    let topic = to === 'wife' ? s.wifeTopic : s.meTopic;
    let shownTitle = title;
    if (to === 'wife' && dryRun) { topic = s.meTopic; shownTitle = `${L('[お試し・嫁宛]', '[Trial · to wife]')} ${title}`; }
    const record = { id, key, to, title: shownTitle, message, priority, at: now(), delivered: false, dryRun: to === 'wife' && dryRun };
    if (!topic) {
      log.log(`[notify:${to}] ${shownTitle} — ${message} (no ntfy topic set; run npm run setup-ntfy)`);
    } else {
      try {
        const res = await fetchImpl(s.ntfyServer || 'https://ntfy.sh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, title: shownTitle, message, priority, tags }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
        record.delivered = true;
      } catch (e) {
        log.warn(`[notify:${to}] failed: ${e.message}`);
        return { failed: true }; // not recorded, so it is retried on the next tick
      }
    }
    if (id) await store.put('notifications', record);
    return { sent: true, record };
  }
  return { send };
}
