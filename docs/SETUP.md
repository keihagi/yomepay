# Setting up yomepay

This guide is written so that **a person or a coding agent (Claude Code, Codex)** can follow it from a fresh clone.
If you are an agent: do the Mac steps yourself, ask the user for the choices marked **Ask**, and hand the phone
steps to the user as a short checklist at the end. Never send a test message to the wife's topic, and never turn
off trial mode, without the user saying so.

## What you need

| | Needed for |
|---|---|
| A Mac that stays on (macOS, Node 20+) | Runs the server, the deadlines and the reminders |
| [Tailscale](https://tailscale.com/download) on the Mac and on your phone, same account | Your phone reaches the Mac privately over HTTPS (never the public internet) |
| [ntfy](https://ntfy.sh) app on your phone, and on your wife's phone | Reminders for you; penalty messages for her |
| Claude Code **or** Codex, signed in on the Mac | Reviews photos, videos, texts and check-ins (uses your own sign-in, no API key) |
| `gh` (GitHub CLI), signed in — only for GitHub goals | Counts your pushes (any repository; sign in every account that should count) |
| `ffmpeg` — optional | Cuts video frames on the Mac (otherwise the phone makes them) |

## 1. On the Mac

```bash
git clone <this repo> yomepay && cd yomepay
npm run setup
```

`npm run setup` asks two things (an agent can pass them instead: `npm run setup -- --lang en --reviewer claude --yes`):

- **Ask** the user: app language, `ja` or `en`.
- **Ask** the user: who reviews evidence — `claude` (Claude Code), `codex`, or `off` (they run `/yome-review` themselves).
  Setup suggests whichever is installed.

Other options: `--https-port 8443` if something on this Mac already serves HTTPS on 443 (check with
`tailscale serve status`), `--github-user <login>[,<login>]` if the pushes to count are not those of the accounts `gh` is signed in to.

Setup writes `.env`, makes the data folder `~/.yomepay/data` (outside the repo — personal data never goes in the repo),
makes two long random ntfy topics in `~/.yomepay/secrets.json` (one for you, one for your wife), and turns on a git hook
that refuses to commit personal data. It is safe to run again.

Then start it and open it to the phone:

```bash
bash scripts/install-service.sh   # runs at login under launchd, keeps the Mac awake; logs in ~/Library/Logs/yomepay.log
bash scripts/tailscale-serve.sh   # https://<mac>.<tailnet>.ts.net — tailnet only (never `tailscale funnel`)
npm run doctor                    # everything ✓ ?
```

If the reviewer is `claude` or `codex`, make sure it is signed in (`claude` once interactively, or `codex login`).
The server runs `scripts/auto-review.sh` about 20 seconds after each submission and every 30 minutes while something
waits; its log is `~/Library/Logs/yomepay-review.log`. You can run it by hand: `npm run review:auto`.
The reviewer only reads: it answers with its decisions and the script applies them (it cannot run commands,
write files or reach the network).

GitHub goals: `brew install gh && gh auth login` (setup and doctor tell you if this is missing).
A push to any repository of the account counts. If the user has several GitHub accounts, run `gh auth login` once
per account: every account `gh` is signed in to counts (a push from any one of them is enough), private repositories
included. A goal can also name its own accounts in the app (goal editor → GitHub → Accounts).

## 2. On your phone (hand this to the user)

1. Install **Tailscale**, sign in with the same account as the Mac.
2. Open the address `npm run setup` / `npm run doctor` printed (`https://<mac>.<tailnet>.ts.net`) in Safari (iPhone) or
   Chrome (Android). Add it to the home screen. Allow **camera** and **location** when asked.
3. Install **ntfy**, tap **+**, and subscribe to *your* topic (the `me` address setup printed; also shown in the app's
   Settings tab). In the app's Settings tab, tap **Test** next to "Me" — a notification should arrive.
4. In the app's **Goals** tab, add goals (templates are there). Each one counts from the next day.
   For a place goal, open it while you are at the place and tap **Register this place**.

## 3. On your wife's phone

Install **ntfy** and subscribe to the *wife* topic (shown in the app's Settings tab). She only receives:
new/changed/paused goals, exceptions used, penalties, the unpaid total once a day, and payments ticked off.

## 4. Trial, then live

The app starts in **trial mode**: everything runs for real, but messages meant for your wife come to you, marked as a trial.
When the user is happy (their decision):

```bash
npm run go-live -- --yes          # keeps the trial's records in an archive, counts from tomorrow, wife gets messages
bash scripts/install-service.sh   # restart
```

## Day to day

- Submit from the phone; reviews happen on the Mac by Claude Code / Codex. A rejection arrives on your phone with
  the reason, and you can redo it before the deadline.
- Daily goals close at 03:00 the next morning; weekly ones Monday 03:00; monthly ones the 1st at 03:00.
- Up to 3 exceptions a month for days you really can't.
- Pay penalties (PayPay etc.) and tick them in the Penalties tab — your wife is told.

## Troubleshooting

- `npm run doctor` says what is wrong and how to fix it.
- Camera does not open: the page must be opened over the `https://` Tailscale address, not `http://`.
- No notifications: check the topic in the ntfy app matches the Settings tab; tap **Test**.
- Reviews never happen: `YOMEPAY_REVIEWER` in `.env`, then `npm run review:auto` and read `~/Library/Logs/yomepay-review.log`.
- Try the app without touching real data: `npm run demo` (http://localhost:4750, sample data, fake clock, no messages).
