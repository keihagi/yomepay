// Settings come from environment variables, optionally loaded from a .env file in the repo root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));

const expandHome = p => p.replace(/^~(?=$|\/)/, os.homedir());
const env = (k, d) => process.env[k] ?? d;
const list = v => v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  port: Number(env('PORT', 4749)),
  host: env('HOST', '127.0.0.1'),
  dataDir: path.resolve(expandHome(env('YOMEPAY_DATA_DIR', '~/.yomepay/data'))),
  // ntfy topics live here, outside the repo: { "ntfyServer": "...", "meTopic": "...", "wifeTopic": "..." }
  secretsFile: path.resolve(expandHome(env('YOMEPAY_SECRETS', '~/.yomepay/secrets.json'))),
  // While true, messages meant for the wife go to your own topic instead. Turn off after the trial week.
  dryRun: env('YOMEPAY_DRY_RUN', 'true') === 'true',
  // Whose pushes count by default, comma-separated. Empty: every account `gh` is signed in to on this Mac.
  githubUsers: list(env('YOMEPAY_GITHUB_USER', '')),
  ghBin: env('YOMEPAY_GH_BIN', 'gh'),
  ffmpegBin: env('YOMEPAY_FFMPEG_BIN', 'ffmpeg'),
  // Who reviews photos, videos, texts and check-ins: the Mac's own Claude Code or Codex (no API key), or off.
  reviewer: ['claude', 'codex'].includes(env('YOMEPAY_REVIEWER', 'off')) ? env('YOMEPAY_REVIEWER', 'off') : 'off',
  // For testing only: pretend the clock started at this time (ISO string). Time still moves forward.
  fakeNow: env('YOMEPAY_NOW', ''),
  tickMs: Number(env('YOMEPAY_TICK_MS', 30000)),
  allowedUsers: list(env('YOMEPAY_ALLOWED_USERS', '')),
  allowedHosts: list(env('YOMEPAY_ALLOWED_HOSTS', '')).map(h => h.replace(/:\d+$/, '')),
  tailscaleBin: env('YOMEPAY_TAILSCALE_BIN', fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale'),
};

// Personal data must never live inside the (public) code repo.
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
for (const [name, p] of [['YOMEPAY_DATA_DIR', config.dataDir], ['YOMEPAY_SECRETS', config.secretsFile]]) {
  if (inside(p, ROOT)) {
    console.error(`${name} (${p}) is inside the code repo. Point it somewhere else.`);
    process.exit(1);
  }
}

export function readSecrets() {
  try { return JSON.parse(fs.readFileSync(config.secretsFile, 'utf8')); } catch { return {}; }
}
