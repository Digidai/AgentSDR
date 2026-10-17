# AgentSDR Cloudflare-native fork

User selected a D1 rewrite with all application hosting and persistence on Cloudflare, and requested a GitHub fork and sdr.genedai.me deployment.

Upstream remains preserved under the MIT license. The deployable implementation is in cloudflare/; it does not run upstream's PostgreSQL app. Architecture: Worker/Hono API, React/Vite assets, D1 relational data, R2 private attachments, Queues durable tasks, Cron recovery and scheduling, Workers AI inference. No VPS, external PostgreSQL, or always-on container.

The product provides an authenticated workspace with people/companies, CSV/XLSX import and CSV export, editable lead profiles and DNC, campaigns and timed sequence steps, a unified conversation inbox, AI classification and reply drafts, a drag-and-drop-free accessible pipeline, enrichment tables, integration settings, members and real analytics. Initial state is empty. Provider-dependent actions expose their configuration state. AI drafts require an explicit send action; starting a campaign schedules its sequence. No campaign is started during deployment.

Authentication uses server-side sessions and PBKDF2 password hashes. First-run setup requires a single-use secret; public visitors cannot claim ownership. Every data query is scoped to organization, integration keys use AES-GCM, mutations check Origin, and webhook/unsubscribe endpoints validate dedicated secrets. Sessions and secrets never reach client bundles.

Background jobs are represented in D1 before being placed on Queues. Cron recovers queued work. Send claims and idempotency prevent duplicate dispatch; ambiguous provider failures are held for inspection instead of blind retries. Replies stop sequence enrollment; DNC and sending windows/daily caps are checked again at dispatch.

Validation: typecheck, focused business/security unit tests, local API integration checks, a Wrangler deployment rehearsal, remote migrations, HTTPS/asset/API/auth checks on the requested hostname, and exact GitHub SHA evidence. Upstream AGENTS.md restricts unsolicited browser automation; use HTTP and API verification and document manual UI checks.

Capability and provider parity gaps are recorded in docs/research/delivery-status.md rather than presented as upstream feature parity.
