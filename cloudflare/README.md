# AgentSDR — Cloudflare native edition

A Cloudflare-native fork of [Kandid-ai/AgentSDR](https://github.com/Kandid-ai/AgentSDR), preserving its MIT license and upstream history. The native application lives in this directory; the upstream Next.js/PostgreSQL application is retained outside it for reference and future ports.

Production: **https://sdr.genedai.me**

## Architecture

| Purpose                                                 | Cloudflare service              |
| ------------------------------------------------------- | ------------------------------- |
| API and React app                                       | Workers + Static Assets         |
| People, campaigns, conversations, credentials, sessions | D1                              |
| Private files and uploaded recordings                   | R2                              |
| AI, enrichment, transcription, dispatch                 | Queues with a dead-letter queue |
| Due sequences and interrupted-task recovery             | Cron, every five minutes        |
| Default AI                                              | Workers AI, Llama 3.3 70B       |

No external database, persistent container, or Redis is required. Outreach channels still require your own provider accounts.

## Start using the workspace

1. Open the private setup link supplied with the deployment. Create your owner account (password at least 12 characters). The setup secret is single use at the application boundary; ordinary public visitors cannot claim the workspace.
2. Add product facts, target customers, sending timezone and hours in **设置 → 工作台**. Add factual reference material in **知识库**.
3. Add people manually, or preview and import a CSV/XLSX/XLS file. The first row contains column names: `name,email,company,title,phone,linkedin,website,notes`. Chinese equivalents are accepted. Import up to 1,000 rows at a time; duplicate email addresses are skipped. CSV export escapes formula injection.
4. Generate an AI draft from a lead's detail panel. Inbound replies can be recorded manually or received through an authenticated webhook. They stop active follow-ups for that lead. AI drafts wait for an explicit **审核并发送** action.
5. Connect Resend or Unipile in **渠道连接** before starting outbound. Create a campaign, write sequence steps, enroll leads and click **启动活动**. This starts the sequence inside configured sending hours and caps. Nothing is automatically enrolled or started by deployment.

## Integrations

- **Resend**: API key with domain-read access for connection validation, plus a verified sender address. This edition sends via Resend HTTP API. Provider acceptance is recorded as `sent`; delivery and open tracking are not implemented.
- **Unipile**: HTTPS API hostname (`*.unipile.com`), API key, LinkedIn / WhatsApp account IDs. Connect the underlying accounts through Unipile. LinkedIn profile URLs resolve to provider IDs; WhatsApp numbers require an international prefix. Provider APIs are implemented but real account dispatch must be verified after credentials are connected.
- **Workers AI**: built in; no external model key needed. Organization-specific OpenRouter is optional and overrides the default model.
- **Hunter / Apollo**: optional enrichment providers. Tables also support AI-generated columns and read-only HTTPS JSON API columns. Templates accept `{{name}}`, `{{first_name}}`, `{{company}}` and other row keys.
- **Incoming replies**: create a webhook secret of at least 24 characters. Configure the organization's channel-specific URL from Settings and `X-Webhook-Secret` header. A normalized inbound event contains `external_id`, `email` or `phone` (or `person_id`), `body`, and optional `subject`. Unipile message events with `message_id`, `message`, `sender.attendee_provider_id` are also parsed. Duplicate events are ignored. Mailbox OAuth/synchronization and Resend signed delivery webhooks are not implemented; use a mailbox webhook transformer or log a reply manually.
- **Recordings**: private audio-file upload and queued transcription are supported. Browser dialing/recording and the upstream Chrome recorder extension are not ported to this API.

Stored integration credentials are encrypted with AES-256-GCM. API responses expose only connection names and timestamps. The encryption key must be backed up with the database and never changed casually.

## Local development

```sh
cd cloudflare
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run build
npm run dev
```

For UI editing, run `npm run web:dev` in another terminal; it proxies API traffic to Wrangler on port 8787. Local AI requires an actual Workers AI binding or a remote deployment; test inference is mocked. Generate independent secrets; do not use production keys locally.

## Validation and deployment

```sh
npm run check
npm audit
npx wrangler deploy --dry-run
npx wrangler whoami
npm run db:remote
npx wrangler secret bulk .secrets.production.json
npm run deploy
```

Secret JSON contains `ENCRYPTION_KEY`, `UNSUBSCRIBE_SECRET`, and `BOOTSTRAP_TOKEN`. Keep it outside version control with filesystem mode 0600. The account, database, R2 bucket, queues and custom hostname are declared in `wrangler.jsonc`. Adapt these when using a different Cloudflare account. Never apply this fork's migrations to the upstream PostgreSQL database or another product's D1 database.

The installed version and asset/inference proof are recorded in `docs/research/deployment.json` and `live-verification.json`. The operator-only `node scripts/live-check.mjs --release=<deployed-sha>` performs a fresh-install smoke test only when no owner exists, then removes its own synthetic workspace. It requires local Cloudflare credentials and ignored deployment secrets; do not run it after initializing a real workspace.

`npm run check` runs TypeScript, unit/API/task tests against real local D1/R2 emulation, and the production frontend build. Tests cover tenant/role boundaries, setup races, session revocation, webhook deduplication, follow-up stops, send idempotency, uncertain delivery, encryption, opt-out, enrichment and private files. See [delivery status](../docs/research/delivery-status.md) for actual release evidence and remaining verification.

## Operational behavior

- Pending jobs are persisted before queue publication; Cron recovers publication interruptions and stale tasks.
- A database claim admits one consumer per job. Resend receives a deterministic idempotency key. Timeout or ambiguous provider acceptance is held as `uncertain`; no automatic send retry is allowed for that state.
- Outbound is checked again for DNC, active enrollment, campaign state, sending hours and daily caps immediately before dispatch.
- Limits reserve per organization/channel and campaign/day in the workspace's timezone. Five-minute Cron means a due step may run several minutes after its nominal timestamp.
- GET unsubscribe links show a confirmation; POST applies the signed opt-out and records suppression. DNC persists independently of campaign membership.
- Analytics count actual stored messages and current lead stages. Manually logged replies are included. This edition does not infer meeting attendance, delivery, revenue, or customer outcomes from a send receipt.
- Invite links target a specific email, expire in seven days, and do not send an invitation email automatically. Password change revokes other sessions. No public signup, Google OAuth, or email password reset is enabled.

## Porting scope

This is a working native SDR application, **not complete feature parity** with upstream v0.3.1. The native edition adds the workflow above while retaining upstream code as reference. It currently lacks Google Workspace sending/sync, the full 15-provider registry, formula/QuickJS columns, advanced mailbox pools/warm-up, account-specific platform limits, automated connection-acceptance gates, native phone calling/recording and the upstream Chrome recorder integration. Do not use a UI label or a source file retained in the fork as evidence that an upstream feature is deployed.

Copyright and license notices remain in [LICENSE](../LICENSE).
