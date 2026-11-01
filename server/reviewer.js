// Starts scripts/auto-review.sh (the Mac's own Claude Code or Codex reviews the evidence) shortly after a
// submission, and again every 30 minutes while something is still waiting. One run at a time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createReviewer({ root, who, log = console }) {
  let running = false, timer = null, lastRun = 0;
  const logFile = path.join(os.homedir(), 'Library', 'Logs', 'yomepay-review.log');

  function run() {
    if (running || who === 'off') return;
    running = true; lastRun = Date.now();
    let out = 'ignore';
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); out = fs.openSync(logFile, 'a'); } catch {}
    const child = spawn('bash', [path.join(root, 'scripts', 'auto-review.sh')], { cwd: root, stdio: ['ignore', out, out] });
    child.on('error', e => { running = false; log.error('[reviewer]', e.message); });
    child.on('exit', () => { running = false; if (typeof out === 'number') fs.closeSync(out); });
  }

  return {
    enabled: who !== 'off', who,
    /** After a submission: wait a little, so a video's contact sheets can arrive first. */
    soon(ms = 20000) { if (who === 'off') return; clearTimeout(timer); timer = setTimeout(run, ms); },
    /** From the scheduler: something has been waiting and nothing ran for 30 minutes. */
    maybe(pending) { if (pending && Date.now() - lastRun > 30 * 60e3) run(); },
  };
}
