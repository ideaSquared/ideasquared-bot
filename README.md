# ideaSquared Bot

Cloudflare Worker that receives GitHub webhooks and posts them to Discord **as the bot** (no per-channel Discord webhooks).

## Routing

One GitHub webhook per project, pointing at `https://<worker>/<project>`:

| Path | Project |
| --- | --- |
| `/ads` | AdoptDontShop |
| `/pairflix` | Pairflix |
| `/creatrgrid` | CreatrGrid |
| `/gaminginit` | GamingInit (`gaminginit` + `gaminginit-bot` repos share this webhook) |

Events → channels (see `src/config.ts`):

| Event | Channels |
| --- | --- |
| `pull_request`, `issues` (and push/discussion/star/fork if enabled) | `<project>-github` (private) |
| `release` (published) | `<project>-releases` (public) + `<project>-github` |
| `deployment_status` (success / failure / error) | `<project>-github` |
| `check_run` (completed, Cloudflare Workers Builds only) | `<project>-github` |

Deployments: subscribe the webhook to **Deployment statuses** if the repo deploys via a GitHub Actions job with an `environment`, or **Check runs** if it deploys via Cloudflare Workers Builds.

Failures and misconfiguration are reported to `#bot-logs`.

## Deploy reports from shipper

Repos that deploy with [ideaSquared/shipper](https://github.com/ideaSquared/shipper) send a signed report to
`POST /ship` after every deploy, and when a deploy is blocked. The bot posts one embed to `<project>-github`:

- the outcome in the title (shipped, rolled back, failed, blocked), linking to the Actions run;
- who shipped it and when (shown in each reader's own time zone);
- the commit that was live before and the one now live, with a compare link and the newest ten commits;
- each component's result, including why a rollback happened.

The report's `project` must be a key of `PROJECTS`. Requests are checked with `X-Ship-Signature-256` (HMAC-SHA256
of the body, like GitHub's webhook signature) using the `SHIP_NOTIFY_SECRET` secret. Set the same value as an org-level
GitHub Actions secret so every repo's deploy can sign its report.

Once a repo deploys with shipper, untick **Deployment statuses** on its webhook, or both messages are posted.

### Live deploy board

Every report also updates one message in `#ship-status` (`DISCORD_CHANNEL_SHIP_STATUS`): each product and
environment, the commit live there, who shipped it and when. A failed, rolled-back or blocked attempt shows as an
extra line under the environment.

- 🟢 shipped · 🟡 rolled back (the previous commit is shown as live) · 🔴 failed · ⛔ blocked (what was live stays live)
- The board's state and message id are kept in the `BOT_STATE` KV namespace under `ship-board`. If the message is
  deleted, the next report posts a new one. To start the board again: `pnpm exec wrangler kv key delete --binding BOT_STATE ship-board --remote`.
- A board failure is logged to `#bot-logs` and never fails the report.

The board only knows what shipper has reported since it started, so a product appears after its first ship.

## Configuration

Secrets (`wrangler secret put <NAME>`):

- `DISCORD_BOT_TOKEN` – shared bot token
- `SHIP_NOTIFY_SECRET` – shared secret for shipper's deploy reports (`POST /ship`)
- `GITHUB_WEBHOOK_SECRET_<PROJECT>` – per-project GitHub webhook secret (`ADS`, `PAIRFLIX`, `CREATRGRID`, `GAMINGINIT`, `IDEASQUARED`); set the same value in that repo's webhook settings. Requests without a valid `X-Hub-Signature-256` are rejected.

Channel IDs (not secret; `wrangler.json` `vars` or secrets):

- `DISCORD_CHANNEL_<PROJECT>_<KIND>` where KIND is `PUBLIC`, `RELEASES`, `DEVELOPMENT`, `GITHUB`, `INTERNAL`
- `DISCORD_CHANNEL_BOT_LOGS`

| Variable | Channel ID |
| --- | --- |
| `DISCORD_CHANNEL_ADS_GITHUB` | `1568708022765883533` |
| `DISCORD_CHANNEL_ADS_RELEASES` | `1568707993326067864` |
| `DISCORD_CHANNEL_PAIRFLIX_GITHUB` | `1568708231511937185` |
| `DISCORD_CHANNEL_PAIRFLIX_RELEASES` | `1568708218782482442` |
| `DISCORD_CHANNEL_CREATRGRID_GITHUB` | `1568708444318601386` |
| `DISCORD_CHANNEL_CREATRGRID_RELEASES` | `1568708410692739153` |
| `DISCORD_CHANNEL_GAMINGINIT_GITHUB` | `1568967721838977064` |
| `DISCORD_CHANNEL_GAMINGINIT_RELEASES` | `1568967675726790677` |
| `DISCORD_CHANNEL_IDEASQUARED_GITHUB` | `1570920349070004234` |
| `DISCORD_CHANNEL_SHIP_STATUS` | `1570920375708287046` |
| `DISCORD_CHANNEL_BOT_LOGS` | `1568708548605771797` |
| `DISCORD_CHANNEL_DOMAIN_ALERTS` | `1568741669954654338` |

The bot needs **View Channel** and **Send Messages** (plus **Embed Links**) on each channel it posts to, granted via category permissions.

## Domain watcher

A cron trigger (every 30 minutes) watches `ideasquared.com` (`WATCHED_DOMAIN` in `src/config.ts`) and posts an **IDEASQUARED DOMAIN ALERT** to the domain alerts channel whenever something changes:

- RDAP (Verisign): registration status, registrar, registration/expiry dates, nameservers. A 404 means the domain is unregistered → "Available for registration / Register immediately".
- `redemption period` / `pending delete` statuses are flagged as urgent (the domain is about to drop).
- Afternic listing (GoDaddy aftermarket): for-sale flag, buy-now price, minimum bid, seller. Best effort: if the page can't be fetched, `#bot-logs` is warned once and the last known listing is kept.

The first run posts a baseline alert. The latest snapshot and a change history (last 500 entries) are kept in the `DOMAIN_WATCH` KV namespace under the `snapshot` and `history` keys:

```bash
pnpm exec wrangler kv key get --binding DOMAIN_WATCH history --remote
```

Setup:

- `DISCORD_CHANNEL_DOMAIN_ALERTS` – channel ID for alerts (`wrangler.json` `vars`)
- `DOMAIN_WATCH` KV namespace – created automatically on `wrangler deploy` (or create it with `pnpm exec wrangler kv namespace create DOMAIN_WATCH` and add the `id` to `wrangler.json`)

Test the cron locally with `pnpm exec wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"`.

## Adding a project

Add an entry to `PROJECTS` in `src/config.ts`, set its env vars, and point the repo's webhook at `/<path>`.

## Deploying

Every push to `master` deploys the bot through [ideaSquared/shipper](https://github.com/ideaSquared/shipper) once the
type-check, tests and a wrangler dry run pass (`.github/workflows/ci.yml`, described by `ship.yaml`). After deploying,
shipper checks `GET /health` answers and rolls the Worker back to the previous version if it doesn't.

One-time setup: add `CLOUDFLARE_API_TOKEN` (Cloudflare's **Edit Cloudflare Workers** template) and
`CLOUDFLARE_ACCOUNT_ID` as repo secrets. To deploy `master` again without a new commit, run
`ship deploy ideasquared-bot` (install with `pnpm add -g github:ideaSquared/shipper`) or Actions → CI → Run workflow.

Secrets set with `wrangler secret put` stay in place across deploys.

## Dev

```bash
pnpm test              # watch mode; CI runs pnpm exec vitest run
pnpm exec tsc --noEmit
```
