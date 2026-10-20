# AgentSDR — Cloudflare native

Production: **https://sdr.genedai.me** · GitHub fork: [Digidai/AgentSDR](https://github.com/Digidai/AgentSDR/tree/cloudflare-native).

This branch migrates the implemented AgentSDR v0.3.1 feature families to **Workers, D1, private R2, Queues, Cron and Workers AI**. No PostgreSQL, server process, container or external application database is required. Upstream MIT source/history remains in the repository; the running application is entirely in this directory.

## Capabilities

- People/companies, typed custom fields, conversion previews, CSV/XLSX import and merge, exports, notes, assigned tasks, DNC and private attachments.
- All **15 upstream enrichment providers and 84 implemented actions**, multiple encrypted connections, typed table columns and output mapping, conditions/dependencies, async polling, audit/status, retries, row editing, dedupe/split/duplicate/export, folders/workbooks, saved views/selection and table-to-campaign conversion.
- QuickJS WASM formulas with lodash, Moment, FormulaJS and organization-scoped LOOKUP; formula preview/generation. HTTP methods, JSON bodies/response paths and encrypted secret references.
- Workers AI by default; optional OpenRouter connections, BYOK management catalog, fixed provider/model selection, structured outputs/examples, web research, private generated images and configurable call transcription.
- Google Workspace delegated Gmail sending, Unicode MIME, signatures, thread affinity, paginated history/full sync and authenticated Pub/Sub wakeups with periodic sync/watch renewal.
- LinkedIn/WhatsApp account sync and hosted linking/reconnection, working hours, daily limits, pacing/bursts, WhatsApp warmup, account pools/affinity, LinkedIn acceptance gates, searches/pagination/import, chats/backfill/read state and authenticated/replayable webhook events.
- Multichannel campaigns with merge fields, previews, pause/stop, enrollment controls and exports. Unified inbox, AI drafts, human approval, important/read marks and uncertain-send reconciliation.
- Upstream CRM taxonomy and classification policy, confidence/customer/stage review, acknowledge/adopt/undo, immutable sequence versions, draft-based follow-ups, snooze/pause/stop, identity exceptions and operator instruction blocks.
- Calling campaigns, contact import/edit/photo/outcomes and retry dates; Chrome WhatsApp recorder, hangup bridge, private R2 multipart recordings, playback/ranges and transcripts. Download the native recorder after login at `/downloads/call-recorder`.
- Organizations, roles, teams, invitations, password recovery/verification and optional Google PKCE sign-in. No public signup.
- Domain-catalog import/filtering, website research, Apollo measured qualification/targets, parent review, exports and Apollo search links. Upstream does **not** ship its domain dataset; load your own through the workspace.
- Persisted D1 jobs, at-least-once-safe claims, delayed Queue continuations and Cron recovery. Provider-ambiguous sends are held for reconciliation.

The redesigned native APIs are capability equivalents, not a drop-in replacement for the old Next.js URLs. The pinned source inventory and mapping are in [upstream-parity.md](../docs/research/upstream-parity.md).

## First use and integrations

Open the private `/#setup=...` link supplied with deployment, create the owner, then configure providers in **渠道账号**, **团队与数据服务**, and **工作台设置**. Keep the bootstrap token private. An already initialized installation uses its existing accounts.

- Gmail: enable Gmail API and domain-wide delegation for the service account, authorize `gmail.modify` and `gmail.send`, then provide the service-account email/private key and a delegated test mailbox. A Pub/Sub topic is optional; polling works without it. The authenticated push URL is available from `/api/mailbox-webhook`.
- LinkedIn/WhatsApp: add the organization's Unipile API key/endpoint, sync accounts, set limits/hours and register notifications. Native webhook URLs require the organization's secret header. Repeated provider events are deduplicated.
- OpenRouter: Workers AI works without OpenRouter. For strict BYOK, add inference/management keys, discover prioritized provider credentials/models and select enabled routes. Confirm the provider-side shared-capacity setting before enabling strict BYOK. Fallback-section credentials are excluded from selectable routes.
- Calling: use Chrome 116+, unzip the authenticated recorder download, load it from `chrome://extensions` in developer mode and log in to WhatsApp Web. Grant the recorder's requested permissions. A real call and microphone recording require human verification.
- Authentication email and invitation delivery need a configured Resend sender. Google sign-in needs OAuth client credentials; callback is `https://sdr.genedai.me/api/auth/callback/google`.

For Resend connection verification, use a **Full access** API key from the correct Resend account: the read-only `/domains` check is unavailable to **Sending access** keys. The sender's exact domain must be verified in that account before actual delivery. Connection verification never sends an email. Invalid keys, insufficient permissions and connection failures now appear as specific validation messages.

Keys are encrypted with AES-GCM and excluded from API reads. Preserve the Worker encryption secret with your D1 backup. Provider subscriptions and credentials are external dependencies; fixture tests do not establish real delivery or account permissions.

## Develop, verify, deploy

```sh
cd cloudflare
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run check
npm run check:runtime
npm audit
npm run dev
```

`check` runs TypeScript, local D1/R2 API/task tests and the frontend/recorder build. `check:runtime` bundles the actual Worker and runs auth, database and static-WASM checks in workerd. Tests cover all 84 handler registrations, all 15 unauthorized credential paths and selected full provider fixtures; they do not call all providers live. `vendor:refresh` regenerates formula distributions/static WASM and license copies from the lockfile dependencies.

For production, authenticate with `wrangler whoami`, back up D1, apply additive migrations, then deploy an exact pushed commit:

```sh
npm run db:remote
npx wrangler deploy --var RELEASE:<git-sha>
```

`wrangler.jsonc` is the source of truth for the deployment account, D1/R2/Queues, AI and custom domain. Production secrets remain in Worker secrets and ignored local backups; never commit them. See [delivery status](../docs/research/delivery-status.md) and `deployment.json` for the actually deployed version and verification evidence.

The operator-only `scripts/live-check.mjs` refuses to bootstrap an initialized installation. On a fresh installation it verifies a synthetic organization, then deletes only its own test data and restores private owner setup. Do not use it on an existing owner account.

## Operational limits and validation boundaries

Each API request imports up to 1,000 people or 500 table rows; larger files can be chunked. Tables display/run up to 1,000 rows per request, with up to 150 columns; LOOKUP has a 50,000-row source cap. Formula execution has a time/memory budget and no host/network bindings. Calls upload up to 200 MiB in 8 MiB parts; provider audio/model limits still apply. Whisper handles small recordings; larger recordings need a configured audio model.

Campaign sends require activation and configured channels; CRM follow-ups create reviewable drafts. Reply/DNC checks happen before dispatch, but cannot recall a request already accepted by a provider. Send receipts mean provider acceptance, not inbox delivery. Analytics label message counts separately from people or meeting requests.

UI/browser automation is deliberately excluded by this repository's `AGENTS.md`. Manual acceptance should cover owner setup, desktop/mobile navigation, column/forms, a controlled owned-recipient email, and a real recorder call after provider configuration. No claim of real provider delivery, actual calls or microphone capture follows from the automated tests.

MIT license: [LICENSE](../LICENSE). Ported upstream and third-party notices: [ported/README.md](src/ported/README.md).

## Bug audit (2026-10-20)

See [the audit report](../docs/research/bug-audit-2026-10-20.md) for the 53-scenario baseline comparison, fixes and acceptance boundaries. For an initialized production workspace, use `node scripts/live-readonly-check.mjs <exact-deployed-sha> <output-json>`; the fresh-install checker must not be rerun. The read-only checker makes GET requests only.
