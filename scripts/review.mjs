#!/usr/bin/env node
// Review evidence waiting for a decision. Used by Claude Code through the /yome-review skill.
//   npm run review                      list pending submissions (video frames are cut into contact sheets)
//   npm run review -- approve <id> [note]
//   npm run review -- reject <id> <note>
//   npm run review -- paths              image and contact-sheet files of everything pending, one per line
//   npm run review -- apply <file> [by]   apply decisions an automatic reviewer wrote as JSON (scripts/auto-review.sh)
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, readSecrets } from '../server/config.js';
import { createStore } from '../server/store.js';
import { createNotifier } from '../server/notify.js';
import { createActions } from '../server/actions.js';
import { createGoals } from '../server/goals.js';
import { fmt } from '../server/windows.js';
import { L, getLang } from '../server/i18n.js';

const now = () => Date.now();
const store = await createStore(config.dataDir);
const notifier = createNotifier({ store, secrets: readSecrets, dryRun: config.dryRun, now });
const actions = createActions({ store, notifier, now });
const { goals } = await createGoals(config.dataDir, { now }).load();
const [cmd = 'list', id, ...rest] = process.argv.slice(2);
const note = rest.join(' ').trim();

// What to check, from the goal's own conditions and the user's description of each kind of proof.
function checks(s, g) {
  if (s.kind === 'payment') return L(['PayPay の送金完了画面である', '金額が amountYen 以上', '送金先が嫁（表示名）で、日時が罰金の発生後'],
    ['It is a PayPay "transfer complete" screen', 'The amount is at least amountYen', 'It went to the wife (display name), after the penalty was made']);
  const req = s.requires || { photo: ['photo', 'location'], video: ['video'], reading: ['text'] }[s.kind] || [];
  const out = [];
  const said = k => g?.[k]?.prompt && req.includes(k);
  if (said('photo')) out.push(L(`どんな写真か: ${g.photo.prompt}`, `What the photo should show: ${g.photo.prompt}`));
  if (said('video')) out.push(L(`どんな動画か: ${g.video.prompt}`, `What the video should show: ${g.video.prompt}`));
  if (said('text')) out.push(L(`何を書くか: ${g.text.prompt}`, `What to write: ${g.text.prompt}`));
  if (!said('photo') && !said('video') && g?.howto) out.push(L(`達成の基準: ${g.howto}`, `What counts: ${g.howto}`));
  if (req.includes('photo')) out.push(L('写真に指示どおりの手（右手/左手・指の本数）が写っている。画面を撮った写真や使い回しではない',
    'The photo shows the instructed hand (right/left, number of fingers). Not a photo of a screen, not reused'));
  if (req.includes('video')) out.push(L('録画の最初に指示どおりの手を見せている。途中で切れたり、画面を撮影した映像ではない',
    'The recording starts with the instructed hand. Not cut short, not filmed off a screen'));
  if (req.includes('text')) out.push(L('文章が具体的で、誰でも書ける一般論ではない。過去の提出との一致（⚠）があればコピペを疑う',
    'The text is specific, not something anyone could write. If it matches an earlier one (⚠), suspect a copy'));
  if (req.includes('location')) out.push(L(`場所: 距離はサーバーで確認済み（半径 ${g?.location?.radiusM || 200}m 以内）。精度・時刻・⚠ を見て、位置偽装（精度0m、毎回同じ座標、古い位置）でないか判断する`,
    `Place: the server already checked the distance (within ${g?.location?.radiusM || 200} m). Use the accuracy, time and ⚠ to judge whether it was faked (0 m accuracy, the same coordinates every time, an old position)`));
  return out;
}

const run = (bin, args) => new Promise((resolve, reject) =>
  execFile(bin, args, { timeout: 120000 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));

async function contactSheets(sub) {
  // Prefer sheets cut by ffmpeg from the video itself; fall back to the ones the phone made while recording.
  const fromPhone = (sub.sheets || []).map(n => store.mediaPath(n));
  const dir = path.join(config.dataDir, 'review-frames', sub.id);
  const hasFfmpeg = await run(config.ffmpegBin, ['-version']).then(() => true, () => false);
  if (!hasFfmpeg && fromPhone.length) return fromPhone.map(f => `${f}  ${L('（スマホ側で作成）', '(made on the phone)')}`);
  const existing = await fs.readdir(dir).catch(() => []);
  if (existing.length) return existing.sort().map(f => path.join(dir, f));
  await fs.mkdir(dir, { recursive: true });
  try {
    // one frame per second, 12 frames (4x3) per sheet, numbered in time order
    await run(config.ffmpegBin, ['-loglevel', 'error', '-i', store.mediaPath(sub.media), '-vf', 'fps=1,scale=360:-2,tile=4x3', '-q:v', '4', path.join(dir, 'sheet-%02d.jpg')]);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    return [L(`(コマ切り出し失敗: ${e.message.trim().split('\n')[0]} — ffmpeg が無ければ brew install ffmpeg)`, `(could not cut frames: ${e.message.trim().split('\n')[0]} — without ffmpeg: brew install ffmpeg)`)];
  }
  return (await fs.readdir(dir)).sort().map(f => path.join(dir, f));
}

if (cmd === 'count') {
  console.log((await store.list('submissions')).filter(s => s.status === 'pending').length);
} else if (cmd === 'list') {
  const pending = (await store.list('submissions')).filter(s => s.status === 'pending').sort((a, b) => a.receivedAt - b.receivedAt);
  console.log(`言語 / language: ${getLang()}  ${L('（判定のメモはこの言語で書く。却下の理由は本人のスマホに届く）', '(write notes in this language; rejection reasons go to the phone)')}`);
  if (!pending.length) { console.log(L('審査待ちはありません。', 'Nothing is waiting for review.')); process.exit(0); }
  console.log(L(`審査待ち ${pending.length} 件\n`, `${pending.length} waiting for review\n`));
  for (const s of pending) {
    const g = goals.find(x => x.id === s.goalId);
    console.log(`━━ ${s.id}`);
    console.log(L(`目標: ${s.goalTitle || s.goalId}（${s.kind}） 枠: ${s.windowKey || '-'}  提出: ${fmt(s.submittedAt)}  受信: ${fmt(s.receivedAt)}`,
      `Goal: ${s.goalTitle || s.goalId} (${s.kind})  window: ${s.windowKey || '-'}  submitted: ${fmt(s.submittedAt)}  received: ${fmt(s.receivedAt)}`));
    if (s.instruction) console.log(`${L('指示', 'Instruction')}: ${s.instruction}`);
    if (s.gps) console.log(L(`場所: ${g?.location?.name || '登録地点'}から ${s.gps.distanceM}m（精度 ±${s.gps.accuracy}m、座標 ${s.gps.lat}, ${s.gps.lng}${s.gps.at ? `、取得 ${fmt(s.gps.at)}` : ''}）`,
      `Place: ${s.gps.distanceM} m from ${g?.location?.name || 'the registered place'} (accuracy ±${s.gps.accuracy} m, at ${s.gps.lat}, ${s.gps.lng}${s.gps.at ? `, fixed ${fmt(s.gps.at)}` : ''})`));
    if (s.durationSec) console.log(L(`長さ: 約${s.durationSec}秒`, `Length: about ${s.durationSec} s`));
    if (s.reading) console.log(L(`本: ${s.reading.book}  範囲: ${s.reading.pages || '-'}\nメモ:\n${s.reading.memo}`, `Book: ${s.reading.book}  pages: ${s.reading.pages || '-'}\nMemo:\n${s.reading.memo}`));
    if (s.text) console.log(`${L('文章', 'Text')}:\n${s.text}`);
    if (s.amountYen) console.log(L(`支払い額（未払い合計）: ¥${s.amountYen.toLocaleString('ja-JP')}  対象: ${s.penaltyIds.join(', ')}`, `Amount (unpaid total): ¥${s.amountYen.toLocaleString('ja-JP')}  for: ${s.penaltyIds.join(', ')}`));
    for (const f of s.flags || []) console.log(`⚠ ${f}`);
    if (s.media?.endsWith('.jpg')) console.log(`${L('画像', 'Image')}: ${store.mediaPath(s.media)}`);
    const video = s.video || (s.kind === 'video' && s.media);
    if (video) { console.log(`${L('動画', 'Video')}: ${store.mediaPath(video)}`); for (const f of await contactSheets({ ...s, media: video })) console.log(`${L('コマ', 'Frames')}: ${f}`); }
    console.log(L('確認すること:', 'Check:'));
    for (const c of checks(s, g)) console.log(`  - ${c}`);
    console.log('');
  }
  console.log(L('判定: npm run review -- approve <id> "メモ"  /  npm run review -- reject <id> "理由（本人に通知されます）"',
    'Decide: npm run review -- approve <id> "note"  /  npm run review -- reject <id> "reason (sent to the phone)"'));
} else if (cmd === 'paths') {
  for (const s of (await store.list('submissions')).filter(s => s.status === 'pending')) {
    if (s.media?.endsWith('.jpg')) console.log(store.mediaPath(s.media));
    const video = s.video || (s.kind === 'video' && s.media);
    if (video) for (const f of await contactSheets({ ...s, media: video })) if (f.endsWith('.jpg')) console.log(f);
  }
} else if (cmd === 'apply') {
  // The automatic reviewer only reads and answers with JSON; this applies it. Anything odd is skipped (stays pending).
  const raw = await fs.readFile(id, 'utf8').catch(() => '');
  const json = raw.match(/\{[\s\S]*"decisions"[\s\S]*\}/)?.[0];
  let decisions = [];
  try { decisions = JSON.parse(json).decisions; } catch {}
  if (!Array.isArray(decisions)) decisions = [];
  if (!decisions.length) console.log(L('判定がありませんでした（すべて審査待ちのまま）', 'No decisions (everything stays pending)'));
  const by = /^[a-z-]{2,20}$/.test(rest[0] || '') ? rest[0] : 'auto';
  for (const d of decisions) {
    const did = String(d?.id || ''), what = String(d?.decision || ''), why = String(d?.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (what !== 'approve' && what !== 'reject') { console.log(`${did}: ${L('審査待ちのまま', 'left pending')}${why ? ` (${why})` : ''}`); continue; }
    if (what === 'reject' && !why) { console.log(`${did}: ${L('理由のない却下は無視しました', 'rejection without a reason ignored')}`); continue; }
    try {
      const s = await actions.review(did, what, why, by);
      console.log(`${s.id}: ${s.status}${why ? ` (${why})` : ''}`);
      await fs.rm(path.join(config.dataDir, 'review-frames', s.id), { recursive: true, force: true });
    } catch (e) { console.log(`${did}: ${e.message}`); }
  }
} else if (cmd === 'approve' || cmd === 'reject') {
  if (!id) { console.error(L('id を指定してください', 'Give the id')); process.exit(1); }
  if (cmd === 'reject' && !note) { console.error(L('却下には理由が必要です（本人に通知されます）', 'A rejection needs a reason (it is sent to the phone)')); process.exit(1); }
  const s = await actions.review(id, cmd, note).catch(e => { console.error(e.message); process.exit(1); });
  console.log(L(`${s.id}: ${s.status === 'approved' ? '承認' : '却下'}しました${note ? `（${note}）` : ''}`, `${s.id}: ${s.status}${note ? ` (${note})` : ''}`));
  await fs.rm(path.join(config.dataDir, 'review-frames', id), { recursive: true, force: true });
} else {
  console.error(L('使い方', 'Usage') + ': npm run review [-- count | paths | approve <id> [note] | reject <id> <note> | apply <file>]');
  process.exit(1);
}
