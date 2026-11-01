#!/usr/bin/env node
// Ends the trial week: moves the trial's results (settlements, penalties, exemptions, sent notifications)
// into DATA/trial-archive-<date>/ (nothing is deleted), restarts counting from tomorrow, and turns off
// dry run so messages really reach your wife. Then restart the server: scripts/install-service.sh
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { createGoals } from '../server/goals.js';
import { addDays, businessDate } from '../server/windows.js';
import { L } from '../server/i18n.js';

const now = () => Date.now();
const goals = createGoals(config.dataDir, { now });
const { settings } = await goals.load(); // also sets the language
if (!process.argv.includes('--yes')) {
  console.log(L('お試しの結果（罰金・判定・通知の記録）を退避して、明日から本番（嫁に通知が届く）にします。',
    'This moves the trial\'s results (penalties, decisions, sent messages) aside and goes live tomorrow (your wife gets the messages).'));
  console.log(L('よければ: npm run go-live -- --yes', 'If that is OK: npm run go-live -- --yes'));
  process.exit(0);
}
const tomorrow = addDays(businessDate(now(), settings), 1);
const archive = path.join(config.dataDir, `trial-archive-${businessDate(now(), settings)}`);
await fs.mkdir(archive, { recursive: true });
for (const k of ['settlements', 'penalties', 'exemptions', 'notifications']) {
  await fs.rename(path.join(config.dataDir, k), path.join(archive, k)).catch(() => {});
  await fs.mkdir(path.join(config.dataDir, k), { recursive: true });
}
await goals.update(doc => { doc.settings.startDate = tomorrow; });

const envFile = path.join(ROOT, '.env');
let env = await fs.readFile(envFile, 'utf8').catch(() => '');
env = /^YOMEPAY_DRY_RUN=.*$/m.test(env) ? env.replace(/^YOMEPAY_DRY_RUN=.*$/m, 'YOMEPAY_DRY_RUN=false') : `${env.trimEnd()}\nYOMEPAY_DRY_RUN=false\n`;
await fs.writeFile(envFile, env);

console.log(L(`お試しの記録を ${archive} に退避しました。`, `Moved the trial's records to ${archive}.`));
console.log(L(`カウント開始: ${tomorrow}（3:00 区切り） / 嫁への通知: 本番`, `Counting starts: ${tomorrow} (days end at 3:00) / messages to your wife: live`));
console.log(L('サーバーを再起動してください: bash scripts/install-service.sh', 'Now restart the server: bash scripts/install-service.sh'));
