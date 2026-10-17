# Upstream migration audit

Baseline: Kandid-ai/AgentSDR v0.3.1, commit `bdbf5efd2017347181f5bf549b54d89c1ae6e5f5`. The native application replaces PostgreSQL/Next server loops with Workers, D1, Queues/Cron and private R2; it retains and adapts the pure upstream provider implementations and contracts.

This audit maps **feature families**, rather than claiming wire compatibility for legacy API URLs. `upstream-routes.json` inventories the pinned upstream route files, their native family and implementation files. A mapping is a code review pointer, not proof that a third-party provider was exercised live.

| Upstream family | Native implementation | Native interface / verification |
| --- | --- | --- |
| Authentication/setup/organizations/teams | `auth.ts`, `features/identity.ts` | Private setup/session; Google PKCE/JWKS; invite roles, recovery, teams, organization switch. D1 isolation and reset/reuse/session tests. |
| Lead database/custom fields/company records | `api.ts`, `features/crm.ts`, `features/completeness.ts` | `/people`, `/company-records`, `/lead-fields`, notes/tasks; import/merge/export, typed conversion preview, DNC and private attachments. |
| Enrichment integrations | `ported/integrations`, `features/tables.ts` | 15 providers, 84 registered implemented actions; credential validation, mapping/output columns, persisted asynchronous state and delayed Queue polling. Registration coverage is distinct from live provider coverage. |
| Grid/AI/HTTP/formulas | `features/tables.ts`, `features/formula.ts`, `features/ai.ts` | Typed rows/columns, DAG/conditions, static QuickJS WASM, lodash/Moment/FormulaJS/LOOKUP, HTTP secrets/body/path, generated/private R2 images, BYOK catalog/routes, schemas/examples/web research. Real workerd WASM checks plus provider fixtures. |
| Folder/workbook/view/selection/row utilities | `features/tables.ts`, `features/completeness.ts` | CRUD, move/reorder API, saved view/selection, duplicate/dedupe/split, export, grid-to-campaign conversion. |
| Gmail/outreach | `features/google.ts`, `features/channels.ts`, `jobs.ts` | Delegated JWT, MIME/signatures/threads, history/full sync pagination and 404 recovery, watch renewal/push authentication, mailbox/account pools and pacing. RSA/MIME/history fixtures; no live Gmail account connected by this release. |
| LinkedIn | `features/channels.ts`, `providers.ts`, `jobs.ts` | Account/hosted auth, limits/bursts/working hours/profile lookups, acceptance gate, search batches/pages/queries/import, connections and replayable event processing. |
| WhatsApp | `features/channels.ts`, `providers.ts`, `inbound.ts` | Account/warmup/new-chat caps, thread affinity, chats/backfill/read state, phone echoes, fresh/history CRM distinction and message campaigns. |
| Campaigns/inbox | `api.ts`, `features/workflows.ts`, `features/crm.ts` | Multichannel timed steps, merge fields, pools, preview/duplicate/enrollment stop/export, unified inbox, human-sent drafts, important/read marks, reconciliation. Queued jobs replace server loops; browser data refresh replaces legacy streaming endpoints. |
| CRM classification/pipeline/sequences | `features/crm.ts`, `ported/crm-*`, `jobs.ts` | Seeded taxonomy, policy/confidence/protected customer/stages, manual adopt/ack/undo, immutable versions, follow-up drafts, pause/snooze/DNC, identity exceptions and operator instructions. |
| Calling/recorder | `features/calls.ts`, `features/phone.ts`, native recorder build | Call campaigns/contact import/edit/photo/outcomes/retries, original Chrome recorder plus native multipart capabilities, hangup bridge, private playback/ranges and transcription. Local R2/bearer tests; actual microphone/call remains manual. |
| Legacy domain qualification | `features/workflows.ts`, `features/completeness.ts` | Organization domain-catalog import/filter, category/app counts, website evidence, Apollo counts/targets, parent review and search/export links. The upstream private dataset and provider accounts are not bundled. |
| Analytics/jobs/recovery | `features/workflows.ts`, `jobs.ts`, `features/runtime.ts` | Time-window channel/account/campaign/CRM/call data, durable claims, delayed continuations, stale recovery, audit and uncertain-send review. |

Legacy `debug-env` is deliberately replaced by non-sensitive `/api/health`; environment secrets are never exposed. Declared-only upstream grid runners (`waterfall`, `functions`, `message`, `merge`) and its deferred ads-qualification stage were not runnable in this baseline and are not represented as implemented native functionality.

The frontend exposes the migrated families through the existing workspace plus Channels, Discovery, CRM, Calling and Team/Data Services pages. Native API details may differ from the original Next.js contracts. Some advanced operations are exposed through the API as well as normal table forms.

Local release checks: TypeScript, focused D1/R2 API/task/fixture tests, frontend and recorder build, a compiled Worker/workerd smoke test, dependency audit, and upstream root TypeScript/lint. See `deployment.json` for exact test counts, CI, deployment version and production proof. The repository disallows unsolicited browser automation; UI usability and real provider operations remain explicitly separate acceptance steps.
