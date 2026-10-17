# Upstream feature migration implementation plan

> Execute the authorized migration in this checkout. No subagents or separate sessions are required.

**Goal:** Migrate the remaining implemented product capabilities of AgentSDR v0.3.1, upstream SHA bdbf5efd2017347181f5bf549b54d89c1ae6e5f5, retaining entirely Cloudflare-native hosting, persistence and background execution; pass checks, push and deploy.

**Architecture:** Reuse upstream MIT-licensed pure contracts, provider adapters, rule definitions and recorder code. Replace PostgreSQL/long-running loops with D1 transactions, Queues, Cron and a statically imported QuickJS WASM module. Use Workers WebCrypto for Google JWT/OAuth and credential encryption; keep files/recordings private in R2 with short-lived capabilities and multipart upload.

**Tech stack:** Hono, TypeScript, React/Vite, Cloudflare Workers/D1/R2/Queues/Workers AI, QuickJS WASM.

## 1. Inventory and schema

Create a pinned source route inventory and functional capability matrix. Do not count upstream declarations with no implementation as missing product behavior. Expand schema additively in `cloudflare/migrations/0002_upstream_parity.sql`; preserve existing users, leads, campaigns and encrypted credentials. Tests must apply every migration in order.

## 2. Mail and identity

Implement Google Workspace service-account JWT, mailbox connection tests/signature/hours/pools, Gmail sends/threading/history sync/watch renewal and authenticated Pub/Sub processing. Implement invitation/reset/verification email, Google OAuth with PKCE/state/nonce and verified email, multiple organizations, member roles and teams. Credentials remain scoped and encrypted. Use provider fixtures; no real external message is sent by the agent.

## 3. Tables and enrichment

Port all 15 provider definitions, implemented action handlers and credential verifiers. Add multiple provider accounts, typed columns, output mapping, asynchronous polling, per-cell audit/status/retry, dependency ordering/conditions, QuickJS formulas with lodash/moment/FormulaJS and cross-table lookup, formula generation/preview, HTTP methods/headers/secret references, workbooks/folders/views, cell editing, row operations/dedupe/split/export and campaign integration.

## 4. Channels and calling

Implement Unipile hosted auth/account sync/reconnect/defaults/working hours, all upstream channel rules and account overrides, atomic per-account pacing/daily caps, WhatsApp warm-up/new-chat limits/account affinity, LinkedIn acceptance-gated steps/search queue/connections/messages, authenticated webhooks/replay/backfill. Implement call campaigns, outcomes/retries, scoped recorder bearer contracts, private R2 multipart recording uploads and playback, transcription, extension build/download/update and UI bridge.

## 5. CRM and workspace UI

Implement categories/subcategories, immutable published sequence versions, per-stage attachment, classifications/undo/acknowledge, action queue, staged human-approved sequence drafts, pause/resume/stop/snooze/DNC, send-attempt reconciliation, AI instructions/models/provider pinning, inbox notes/tasks/read/important, custom lead/company fields, organizations/teams. Add all controls to the native UI, retaining accessible desktop/mobile layout. Audit additional upstream modules and expose equivalent native product workflows.

## 6. Verification and release

Run unit/integration tests using local D1/R2 and provider fixtures; include cross-tenant/role access, stale queue work, at-least-once delivery, Gmail parsing/cursors, acceptance gates, multipart capabilities and formula isolation. Run real Worker/WASM smoke checks, TypeScript, frontend/extension builds, dependency audit, Wrangler dry-run and GitHub CI. Apply additive remote migration and deploy an exact pushed SHA to sdr.genedai.me. Do not use the old fresh-install smoke check once an owner exists. Record feature implementation, fixture coverage and real-provider verification separately.

A provider account that has not been supplied prevents a real-provider test, not implementation. Report remaining unverified paths accurately and continue all independent work. Never mark full parity merely from a route count, retained upstream source or green mocks.
