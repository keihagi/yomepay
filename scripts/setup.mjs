#!/usr/bin/env node
// One-time setup on the Mac that will run yomepay. Safe to run again: it only fills in what is missing
// and changes what you pass.
//
//   npm run setup                                   # asks what it needs
//   npm run setup -- --lang en --reviewer claude --yes   # no questions (for Claude Code / Codex doing the setup)
//
// Options: --lang ja|en  --reviewer claude|codex|off  --https-port <n>  --github-user <login[,login]>  --yes
// What it does: writes .env, makes the data folder (outside this repo), makes your and your wife's ntfy
// topics, sets the app language, turns on the git hook that blocks committing personal data, and finds
// the tools it uses (gh, Claude Code / Codex, ffmpeg, Tailscale). It does not start anything; see docs/SETUP.md.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const yes = args.includes('--yes') || !process.stdin.isTTY;
const expandHome = p => p.replace(/^~(?=$|\/)/, os.homedir());
const ok = s => console.log(`  ✓ ${s}`), warn = s => console.log(`  ! ${s}`);

if (Number(process.versions.node.split('.')[0]) < 20) { console.error(`Node 20 or newer is needed (this is ${process.version}).`); process.exit(1); }

const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
async function ask(q, def, allowed) {
  if (!rl) return def;
  for (;;) {
    const a = (await rl.question(`${q} [${def}] `)).trim() || def;
    if (!allowed || allowed.includes(a)) return a;
    console.log(`  → ${allowed.join(' / ')}`);
  }
}
const which = bin => { try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const run = (bin, a) => { try { return execFileSync(bin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); } catch { return null; } };

/* ---------- .env ---------- */
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) fs.copyFileSync(path.join(ROOT, '.env.example'), envFile);
let envText = fs.readFileSync(envFile, 'utf8');
const getEnv = k => (envText.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() ?? '';
const setEnv = (k, v) => {
  envText = new RegExp(`^${k}=`, 'm').test(envText) ? envText.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${envText.trimEnd()}\n${k}=${v}\n`;
};

console.log('\nyomepay setup\n');
const lang = opt('lang') || await ask('Language / 言語 (ja, en)', Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ja') ? 'ja' : 'en', ['ja', 'en']);
const J = lang === 'ja';
const T = (ja, en) => (J ? ja : en);

// reviewer: the Mac's own Claude Code or Codex reads the photos, videos and texts (no API key)
const claudeBin = which('claude'), codexBin = which('codex');
const found = claudeBin ? 'claude' : codexBin ? 'codex' : 'off';
const reviewer = opt('reviewer') || await ask(T('証拠を審査するのは (claude, codex, off)', 'Who reviews evidence (claude, codex, off)'), getEnv('YOMEPAY_REVIEWER') && getEnv('YOMEPAY_REVIEWER') !== 'off' ? getEnv('YOMEPAY_REVIEWER') : found, ['claude', 'codex', 'off']);
setEnv('YOMEPAY_REVIEWER', reviewer);
const reviewerBin = reviewer === 'claude' ? claudeBin : reviewer === 'codex' ? codexBin : '';
if (reviewer !== 'off' && !reviewerBin) warn(T(`${reviewer} が見つかりません。インストールしてから、もう一度 npm run setup`, `${reviewer} was not found. Install it, then run npm run setup again`));
setEnv('YOMEPAY_REVIEWER_BIN', reviewerBin);

const httpsPort = opt('https-port') || getEnv('YOMEPAY_HTTPS_PORT') || '443';
setEnv('YOMEPAY_HTTPS_PORT', httpsPort);
if (opt('github-user')) setEnv('YOMEPAY_GITHUB_USER', opt('github-user'));
fs.writeFileSync(envFile, envText);
ok(`.env (${T('審査', 'reviewer')}: ${reviewer}, HTTPS ${httpsPort})`);

/* ---------- data folder (outside the repo) ---------- */
const dataDir = path.resolve(expandHome(getEnv('YOMEPAY_DATA_DIR') || '~/.yomepay/data'));
if (dataDir === ROOT || dataDir.startsWith(ROOT + path.sep)) { console.error(T('データフォルダがリポジトリの中です。.env の YOMEPAY_DATA_DIR を変えてください', 'The data folder is inside the repo. Change YOMEPAY_DATA_DIR in .env')); process.exit(1); }
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const goalsFile = path.join(dataDir, 'goals.json');
const doc = fs.existsSync(goalsFile) ? JSON.parse(fs.readFileSync(goalsFile, 'utf8')) : { settings: {}, goals: [] };
doc.settings = { ...doc.settings, lang };
fs.writeFileSync(goalsFile, JSON.stringify(doc, null, 2) + '\n');
ok(`${T('データ', 'Data')}: ${dataDir} (${T(`目標 ${doc.goals.length}件`, `${doc.goals.length} goal(s)`)})`);

/* ---------- ntfy topics (long random names: anyone who knows one can read it) ---------- */
const secretsFile = path.resolve(expandHome(getEnv('YOMEPAY_SECRETS') || '~/.yomepay/secrets.json'));
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch {}
if (!secrets.meTopic || !secrets.wifeTopic) {
  secrets = { ntfyServer: secrets.ntfyServer || 'https://ntfy.sh', ...secrets,
    meTopic: secrets.meTopic || `yomepay-me-${crypto.randomBytes(12).toString('hex')}`,
    wifeTopic: secrets.wifeTopic || `yomepay-wife-${crypto.randomBytes(12).toString('hex')}` };
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
}
ok(`ntfy: ${secretsFile}`);

/* ---------- git hook ---------- */
if (fs.existsSync(path.join(ROOT, '.git'))) { run('git', ['-C', ROOT, 'config', 'core.hooksPath', '.githooks']); ok(T('git フック（個人データのコミットを止める）', 'git hook (blocks committing personal data)')); }

/* ---------- tools ---------- */
console.log('');
const gh = which('gh'), ghUser = gh && run(gh, ['api', 'user', '--jq', '.login']);
const ghAll = gh && run(gh, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts', '--jq', '[.hosts["github.com"][]? | select(.state == "success") | .login] | join(", ")']);
ghUser ? ok(`gh: ${ghAll || ghUser} ${T('（GitHub の目標で使います。別のアカウントも数えるなら gh auth login でもう1つログイン）', '(used by GitHub goals. To count another account too, sign it in with gh auth login)')}`)
  : warn(T('gh が未ログイン（GitHub の目標を使うなら: brew install gh && gh auth login）', 'gh is not signed in (for GitHub goals: brew install gh && gh auth login)'));
reviewerBin ? ok(`${reviewer}: ${reviewerBin}`) : warn(T('審査がオフ: 写真・動画・文章は自分で /yome-review を実行して審査します', 'Reviewer is off: run /yome-review yourself to review photos, videos and texts'));
which('ffmpeg') ? ok('ffmpeg') : warn(T('ffmpeg なし（任意。動画のコマはスマホ側で作ります。入れるなら brew install ffmpeg）', 'no ffmpeg (optional; the phone makes video frames. To add: brew install ffmpeg)'));
const ts = which('tailscale') || (fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : '');
const dns = ts && JSON.parse(run(ts, ['status', '--json']) || '{}').Self?.DNSName?.replace(/\.$/, '');
dns ? ok(`Tailscale: ${dns}`) : warn(T('Tailscale が見つからないか未ログイン（スマホから使うのに必要: https://tailscale.com/download）', 'Tailscale not found or not signed in (needed for the phone: https://tailscale.com/download)'));

/* ---------- next ---------- */
const url = dns ? `https://${dns}${httpsPort === '443' ? '' : `:${httpsPort}`}` : 'https://<mac>.<tailnet>.ts.net';
console.log(`
${T('次にやること', 'Next')}:
  bash scripts/install-service.sh   # ${T('サーバーを常駐（ログイン時に起動、Mac をスリープさせない）', 'run the server at login, keep the Mac awake')}
  bash scripts/tailscale-serve.sh   # ${T('スマホから', 'for the phone')}: ${url}
  npm run doctor                    # ${T('全部動いているか確認', 'check everything works')}

${T('スマホ（自分）', 'Your phone')}:
  1. Tailscale ${T('アプリで同じアカウントにログイン', 'app, signed in to the same account')}
  2. ${url} ${T('を開いてホーム画面に追加、カメラと位置情報を許可', 'open it, add to the home screen, allow camera and location')}
  3. ntfy ${T('アプリで購読', 'app, subscribe to')}: ${secrets.ntfyServer}/${secrets.meTopic}
${T('嫁のスマホ', "Your wife's phone")}:
  ntfy ${T('アプリで購読', 'app, subscribe to')}: ${secrets.ntfyServer}/${secrets.wifeTopic}
  ${T('（お試し中は嫁宛ての通知もあなたに届きます。本番は npm run go-live）', '(during the trial, her messages come to you; go live with npm run go-live)')}

${T('目標はアプリの「目標」タブで追加します。追加した次の日から数えます。', 'Add goals in the app’s Goals tab. Each one counts from the next day.')}
`);
rl?.close();
