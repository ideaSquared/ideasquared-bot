# ideaSquared Bot

Cloudflare Worker that receives GitHub webhooks and posts them to Discord **as the bot** (no per-channel Discord webhooks).

## Routing

One GitHub webhook per project, pointing at `https://<worker>/<project>`:

| Path | Project |
| --- | --- |
| `/ads` | AdoptDontShop |
| `/pairflix` | Pairflix |
| `/creatrgrid` | CreatrGrid |

Events → channels (see `src/config.ts`):

| Event | Channels |
| --- | --- |
| `pull_request`, `issues` (and push/discussion/star/fork if enabled) | `<project>-github` (private) |
| `release` (published) | `<project>-releases` (public) + `<project>-github` |

Failures and misconfiguration are reported to `#bot-logs`.

## Configuration

Secrets (`wrangler secret put <NAME>`):

- `DISCORD_BOT_TOKEN` – shared bot token
- `GITHUB_WEBHOOK_SECRET_<PROJECT>` – per-project GitHub webhook secret (`ADS`, `PAIRFLIX`, `CREATRGRID`); set the same value in that repo's webhook settings. Requests without a valid `X-Hub-Signature-256` are rejected.

Channel IDs (not secret; `wrangler.json` `vars` or secrets):

- `DISCORD_CHANNEL_<PROJECT>_<KIND>` where KIND is `PUBLIC`, `RELEASES`, `DEVELOPMENT`, `GITHUB`, `INTERNAL`
- `DISCORD_CHANNEL_BOT_LOGS`

The bot needs **View Channel** and **Send Messages** (plus **Embed Links**) on each channel it posts to, granted via category permissions.

## Adding a project

Add an entry to `PROJECTS` in `src/config.ts`, set its env vars, and point the repo's webhook at `/<path>`.

## Dev

```bash
npm test
npm run deploy
```
