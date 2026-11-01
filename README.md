# yomepay

Goals checked by **evidence**, not checkboxes. Miss one and you owe your wife the penalty.
Runs on your own Mac; your phone reaches it privately over Tailscale. Evidence is reviewed by **your own Claude Code
or Codex** — no API keys, no cloud, no database, no dependencies. Japanese and English.

[日本語は下へ](#日本語)

## What it does

- **Goals** you set in the app: what counts as done — any mix of **text, photo, video and place** in one submission
  (e.g. a photo taken at the gym), or a **GitHub push** — how often (every day, picked weekdays, N a week, N a month),
  and the penalty per miss.
- **Proof that's hard to fake**: photos and videos come only from the in-app camera, start with a random hand sign,
  and are time-stamped by the server. Places are checked by distance and for signs of a faked GPS. Pushes are timed by GitHub.
- **Review on your Mac**: Claude Code or Codex looks at each photo, video (as frame sheets), text and check-in and
  approves or rejects it (`.claude/skills/yome-review/SKILL.md`). It runs automatically after each submission.
- **Deadlines and reminders**: daily goals close at 03:00 the next morning; reminders through [ntfy](https://ntfy.sh).
  The Today tab shows each goal as a card with its streak, and turns orange, then red, as the deadline gets close.
- **Penalties**: a miss becomes a penalty; your wife gets a message; you get nagged until you tick it as paid.
- **Fair rules**: rule changes, pausing and deleting only start tomorrow (next week/month), so a deadline can't be
  dodged. 3 exceptions a month for days you really can't. Your wife is told about all of it.
- Starts in **trial mode** (her messages come to you) until you go live.

## Set up

Ask your coding agent: **"Set up yomepay for me — follow docs/SETUP.md."** Or by hand:

```bash
npm run setup                     # language, reviewer (claude / codex), ntfy topics, data folder
bash scripts/install-service.sh   # run at login (launchd)
bash scripts/tailscale-serve.sh   # https address for your phone (tailnet only)
npm run doctor                    # check everything
```

Then on the phone: open the https address, add it to the home screen, subscribe to your ntfy topic.
Full guide: [docs/SETUP.md](docs/SETUP.md).

## Commands

| | |
|---|---|
| `npm run demo` | Try it with sample data and a fake clock at http://localhost:4750 (touches nothing real) |
| `npm run review` | List evidence waiting for review (`approve <id> "note"` / `reject <id> "reason"`) |
| `npm run review:auto` | Run the review now with Claude Code / Codex |
| `npm run doctor` | What's running, what's missing |
| `npm run go-live -- --yes` | End the trial: from tomorrow, your wife gets messages |
| `npm test` | Tests for deadlines, rules and penalties |

Data lives in `~/.yomepay/` (never in the repo). Paying is manual (PayPay has no personal-transfer API);
the payment step is a plug-in in `server/payments/`.

---

## 日本語

チェックボックスではなく**証拠**で判定する習慣アプリ。達成できなかったら、罰金を嫁に払う。
自分の Mac で動かし、スマホからは Tailscale で（インターネットに公開せずに）使う。証拠の審査は**自分の Claude Code か Codex**
がやるので、API キーもクラウドもいらない。日本語・英語対応。

- **目標**はアプリで自由に作る。達成の条件（文章・写真・動画・場所の組み合わせ、または GitHub への push）、頻度（毎日・曜日・週N回・月N回）、1回ミスごとの罰金。
- **ごまかしにくい証拠**：写真・動画はアプリのカメラでだけ撮れて、最初にランダムな手の指示を写す。場所は距離と位置偽装のサインをチェック。push は GitHub 側の時刻。
- **審査は Mac で**：Claude Code / Codex が写真・動画（コマ画像）・文章・チェックインを見て承認／却下する。提出すると自動で走る。
- **締め切りと通知**：毎日の目標は翌朝3:00締め。ntfy で通知。今日タブは目標ごとのカード（連続記録つき）で、締め切りが近いとオレンジ→赤になる。
- **罰金**：未達は罰金になり、嫁に通知。払ってチェックを入れるまで催促が来る。
- **ずるはできない**：ルール変更・一時停止・削除は明日（翌週・翌月）から。特例は月3回まで。どれも嫁に通知される。
- 最初は**お試しモード**（嫁宛ての通知は自分に届く）。

### セットアップ

Claude Code か Codex に **「docs/SETUP.md に沿って yomepay をセットアップして」** と頼めば OK。手でやるなら上の「Set up」と同じ：
`npm run setup` → `bash scripts/install-service.sh` → `bash scripts/tailscale-serve.sh` → `npm run doctor`。
スマホでは https のアドレスを開いてホーム画面に追加し、ntfy で自分のトピックを購読。嫁のスマホでは嫁のトピックを購読してもらう。
詳しくは [docs/SETUP.md](docs/SETUP.md)。
