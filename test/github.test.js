import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchPushesWithGh, cleanLogins, ghAccounts } from '../server/github.js';

// A stand-in for the `gh` CLI, signed in to "main" and "work". Each account's feed has one public push and one
// private push; the private one only shows up when the request uses that account's own token.
async function fakeGh() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yomepay-gh-'));
  const bin = path.join(dir, 'gh');
  await fs.writeFile(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = s => process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s));
if (a[0] === 'auth' && a[1] === 'status') out(['main', 'work']);
else if (a[0] === 'auth' && a[1] === 'token') out('tok-' + a[a.indexOf('--user') + 1]);
else if (a[0] === 'api' && a[1] === 'user') out('main');
else if (a[0] === 'api') {
  const login = a[1].split('/')[2];
  const ev = (id, repo, priv) => ({ id: login + id, type: 'PushEvent', repo: { name: login + '/' + repo }, created_at: '2026-11-10T12:00:00Z', priv });
  const events = [ev(1, 'public-repo', false), ev(2, 'private-repo', true), { id: login + 3, type: 'WatchEvent', repo: { name: 'x/y' }, created_at: '2026-11-10T12:00:00Z' }];
  out(events.filter(e => !e.priv || process.env.GH_TOKEN === 'tok-' + login));
} else process.exit(1);
`, { mode: 0o755 });
  return bin;
}

test('logins are cleaned', () => {
  assert.deepEqual(cleanLogins(' Main, @work  bad_name! main'), ['main', 'work']);
  assert.deepEqual(cleanLogins(['A', 'a', '']), ['a']);
});

test('without settings, every signed-in account is read, private repos included', async () => {
  const ghBin = await fakeGh();
  assert.deepEqual(await ghAccounts(ghBin), ['main', 'work']);
  const pushes = await fetchPushesWithGh({ ghBin })();
  assert.deepEqual(pushes.map(p => `${p.account}:${p.repo}:${p.isDefault}`).sort(), [
    'main:main/private-repo:true', 'main:main/public-repo:true', 'work:work/private-repo:true', 'work:work/public-repo:true',
  ]);
});

test('YOMEPAY_GITHUB_USER limits the defaults; accounts named by goals are read too', async () => {
  const ghBin = await fakeGh();
  const pushes = await fetchPushesWithGh({ ghBin, users: ['main'] })(['work', 'someone']);
  const by = acc => pushes.filter(p => p.account === acc).map(p => p.repo).sort();
  assert.deepEqual(by('main'), ['main/private-repo', 'main/public-repo']);
  assert.deepEqual(by('work'), ['work/private-repo', 'work/public-repo']);
  assert.deepEqual(by('someone'), ['someone/public-repo']); // gh is not signed in as them: public pushes only
  assert.ok(pushes.filter(p => p.account !== 'main').every(p => p.isDefault === false));
});
