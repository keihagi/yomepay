#!/usr/bin/env node
// Creates two hard-to-guess ntfy topics (yours and your wife's) in ~/.yomepay/secrets.json.
// Anyone who knows a topic name can read it, so the names are long random strings and never go in the repo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, readSecrets } from '../server/config.js';

const s = readSecrets();
if (!s.meTopic || !s.wifeTopic) {
  const next = {
    ntfyServer: s.ntfyServer || 'https://ntfy.sh',
    meTopic: s.meTopic || `yomepay-me-${crypto.randomBytes(12).toString('hex')}`,
    wifeTopic: s.wifeTopic || `yomepay-wife-${crypto.randomBytes(12).toString('hex')}`,
  };
  fs.mkdirSync(path.dirname(config.secretsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.secretsFile, JSON.stringify({ ...s, ...next }, null, 2) + '\n', { mode: 0o600 });
  Object.assign(s, next);
  console.log(`作成しました: ${config.secretsFile}`);
}
console.log(`\n自分用:  ${s.ntfyServer}/${s.meTopic}`);
console.log(`嫁用:    ${s.ntfyServer}/${s.wifeTopic}`);
console.log('\nスマホに ntfy アプリを入れて「+」→ トピック名を入力して購読。嫁用のアドレスは嫁に送って購読してもらう。');
console.log('アプリの「設定」タブからテスト通知を送れます。');
