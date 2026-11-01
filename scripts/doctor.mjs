#!/usr/bin/env node
// Checks that everything yomepay needs is in place and running. Prints ✓ / ✗ per item and exits 1 if
// something required is missing. Run it at the end of setup, and whenever something seems off.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ROOT, readSecrets } from '../server/config.js';

let failed = 0;
const line = (good, what, fix = '') => { console.log(`${good ? '✓' : '✗'} ${what}${!good && fix ? `\n    → ${fix}` : ''}`); if (!good) failed++; };
const note = (what, fix = '') => console.log(`· ${what}${fix ? `\n    → ${fix}` : ''}`);
const run = (bin, a) => { try { return execFileSync(bin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); } catch { return null; } };
const which = bin => run('/bin/sh', ['-c', `command -v ${bin}`]);

console.log(`yomepay doctor (${ROOT})\n`);
line(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.version}`, 'Node 20+ (brew install node)');
line(fs.existsSync(path.join(ROOT, '.env')), '.env', 'npm run setup');

const goalsFile = path.join(config.dataDir, 'goals.json');
let goals = null;
try { goals = JSON.parse(fs.readFileSync(goalsFile, 'utf8')); } catch {}
line(!!goals, `data: ${config.dataDir}`, 'npm run setup');
if (goals) note(`goals: ${goals.goals?.length || 0}, language: ${goals.settings?.lang || 'ja'}, counting from: ${goals.settings?.startDate || '(first start)'}`,
  goals.goals?.length ? '' : 'add goals in the app (Goals tab)');

const s = readSecrets();
line(!!(s.meTopic && s.wifeTopic), `ntfy topics: ${config.secretsFile}`, 'npm run setup');
note(`mode: ${config.dryRun ? "trial (messages for your wife come to you)" : 'live (your wife gets messages)'}`, config.dryRun ? 'when ready: npm run go-live -- --yes' : '');

// the server
let state = null;
try { const r = await fetch(`http://127.0.0.1:${config.port}/api/state`, { signal: AbortSignal.timeout(4000) }); state = r.ok ? await r.json() : null; } catch {}
line(!!state, `server on 127.0.0.1:${config.port}`, 'bash scripts/install-service.sh  (logs: ~/Library/Logs/yomepay.log)');
const agent = run('launchctl', ['print', `gui/${os.userInfo().uid}/com.yomepay.server`]);
line(!!agent, 'starts at login (launchd com.yomepay.server)', 'bash scripts/install-service.sh');

// the phone's way in
const tsBin = which('tailscale') || (fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : null);
const ts = tsBin && JSON.parse(run(tsBin, ['status', '--json']) || '{}');
const dns = ts?.Self?.DNSName?.replace(/\.$/, '');
line(!!dns, `Tailscale${dns ? `: ${dns}` : ''}`, 'install Tailscale and sign in: https://tailscale.com/download');
if (dns) {
  const serve = run(tsBin, ['serve', 'status']) || '';
  const port = process.env.YOMEPAY_HTTPS_PORT || '443';
  const served = serve.includes(`127.0.0.1:${config.port}`);
  line(served, `phone address: https://${dns}${port === '443' ? '' : `:${port}`}`, 'bash scripts/tailscale-serve.sh');
  if (/funnel on/i.test(serve)) line(false, 'Tailscale Funnel is on (the app would be on the public internet)', 'tailscale funnel reset');
}

// reviewing
if (config.reviewer === 'off') note('reviewer: off (run /yome-review in Claude Code yourself)', 'to automate: npm run setup -- --reviewer claude   (or codex)');
else {
  const bin = process.env.YOMEPAY_REVIEWER_BIN || which(config.reviewer);
  line(!!(bin && run(bin, ['--version'])), `reviewer: ${config.reviewer}${bin ? ` (${bin})` : ''}`, `install ${config.reviewer === 'claude' ? 'Claude Code' : 'Codex'} and sign in, then npm run setup`);
}
const gh = which(config.ghBin);
const ghUser = gh && run(gh, ['api', 'user', '--jq', '.login']);
const usesGithub = (goals?.goals || []).some(g => JSON.stringify(g).includes('"github"'));
(usesGithub ? line : (ok, w, f) => note(w, ok ? '' : f))(!!ghUser, `GitHub (gh)${ghUser ? `: ${config.githubUser || ghUser}` : ''}`, 'brew install gh && gh auth login');
note(`ffmpeg: ${which(config.ffmpegBin) ? 'yes' : 'no (optional; the phone makes video frames)'}`);

console.log(failed ? `\n${failed} thing(s) to fix.` : '\nAll set.');
process.exit(failed ? 1 : 0);
