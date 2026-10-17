# AgentSDR Cloudflare native delivery status

## Authorized scope

The user requested an SDR based on Kandid-ai/AgentSDR at sdr.genedai.me, selected an entirely Cloudflare/D1 rewrite, and requested a GitHub fork. Fork: https://github.com/Digidai/AgentSDR, native branch cloudflare-native. Upstream baseline: bdbf5efd2017347181f5bf549b54d89c1ae6e5f5 (MIT).

## Implemented

React workspace and Worker API; private owner bootstrap and sessions; scoped people/company records; CSV/Excel import preview and safe CSV export; stages and DNC; multichannel campaigns with timed steps/enrollment; unified messages; AI classification and editable human-sent drafts; enrichment tables with AI/HTTP/Hunter/Apollo columns; knowledge; members and invitations; private R2 attachments and queued audio transcription; real message/pipeline analytics; durable D1 jobs, queues, recovery Cron, idempotent send claims and ambiguous-provider holds.

## Infrastructure

- Account: Gene Dai Account (48d9ccaf5ee7914c803b5d0656462848).
- Worker: agentsdr-native. Domain: sdr.genedai.me.
- D1: agentsdr-native, 6f1a38df-84f6-4bbd-b665-2ca0e720d17e; migration 0001_native.sql applied remotely.
- R2: agentsdr-native-media (private).
- Queues: agentsdr-native-tasks / agentsdr-native-dead.
- Cron: every five minutes. AI: @cf/meta/llama-3.3-70b-instruct-fp8-fast.
- Encryption, unsubscribe, and bootstrap secrets stored as Worker secrets; local backups ignored by Git and mode 0600. No credential values belong in this file.

## Verification

TypeScript, 24 focused unit/API/task tests, production frontend build, Wrangler dry-run, and npm audit pass. Tests use real local D1/R2 emulation and mock provider/model responses. Upstream root TypeScript also passed; upstream lint completed with six existing warnings and no errors. Production release `d9c3fa27bf85f5367aa258ea3b79ba82422ca9ec` is live as Worker version `b20e2346-eb58-4052-b2ff-42fdcf10d8d4` (100% traffic). GitHub Actions run 39041143468 passed on that exact SHA. The live verification report records 22 passing checks: real Workers AI through Queues produced a persisted editable draft, no automatic send occurred, authenticated D1/R2 operations worked, private routes/attachments were denied to anonymous callers, cross-origin mutations were blocked, and application assets matched the build. HTML is compared after removing the observed zone-level Cloudflare JavaScript Detection injection. Synthetic test organization/account/data were removed; owner initialization remains available. See live-verification.json and deployment.json. A later documentation/verification-script closeout commit does not represent a different deployed runtime.

## Not configured or not verified

Owner account setup is intentionally left to the user through a private one-time setup link. No real leads or external provider credentials are imported. No real outreach is sent during deployment. Configure a verified Resend sender or Unipile accounts before sending. Provider acceptance, delivery, inbox placement, replies, meetings and business outcomes remain distinct.

Resend/Unipile/Hunter/Apollo adapters are implemented but untested with real customer credentials. Audio transcription is implemented but not exercised with a real recording. Browser interaction/responsive screenshots are not run: upstream AGENTS.md limits unsolicited browser automation. Manual verification: create owner, check navigation and forms at desktop and mobile widths, import a small list, inspect a draft and configure a channel before a controlled recipient test.

This is not full upstream parity. Unported: Google Workspace mailbox sending/sync, full enrichment provider catalog, QuickJS/formulas, advanced account pools/warm-up and platform-specific account limits, automatic connection acceptance gates, browser calling/recording, upstream recorder extension integration, Google sign-in and auth-email reset/invitations. Upstream source retained in this fork is not evidence of a deployed native feature. See cloudflare/README.md for the operational contract.
