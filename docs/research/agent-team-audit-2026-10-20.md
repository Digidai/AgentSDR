# Agent team adversarial audit — 2026-10-20

Three independent agents reviewed the Cloudflare-native fork, reproduced defects, implemented fixes in separate source areas, and challenged each other's changes. The root agent handled channel attribution, browser verification, integration and release. The final cross-review found no remaining proven P1/P2 in the reviewed delta; this is a bounded verification result, not a guarantee that every possible defect has been eliminated.

## Reproduction and checks

- Baseline: tracked sources at `0eff22199d4313f4d958ca35ed04a0c2a4feb153`, extracted into an isolated ignored directory without production credentials.
- The four new regression suites contain **56 scenarios**. On baseline, **40 failed and 16 passed**. These are scenario counts, not 40 independent root causes. [Machine-readable baseline](agent-team-baseline.json).
- Final native verification: TypeScript, **312 tests in 9 files**, frontend/recorder builds and **25 compiled Worker/workerd checks** passed. Dependency audit: **0 known vulnerabilities**.
- The compiled checks include actual local D1, R2, Queue consumption, formula WASM and password/session rotation. Provider interactions in these tests use controlled transports.
- Security and reliability agents cross-reviewed each other's fixes; the product agent independently challenged channel identity and group-message behavior, then reran the 31 product/channel scenarios after the final guard.

## Confirmed defects repaired

### Identity and permissions

Password changes invalidate older recovery tokens and compare the current password state before replacing it. Password login, invitation acceptance and workspace switching cannot create a new valid session from credentials or a source session revoked while the request was waiting. Invitation validity and membership grants are checked and consumed in one atomic D1 batch, including the Google signup path. Member and team updates recheck owner/member invariants at mutation time.

### Sending and follow-up reliability

Concurrent retry cannot reopen a send that has already reached an uncertain outcome. A fresh reply invalidates undispatched drafts while preserving evidence for sends that crossed the dispatch boundary. Draft editing/deletion and approval recheck status and content at the final mutation. Deleting a pending sequence draft stops its sequence. Delivery receipts and reconciliation tolerate deleted campaigns/accounts without recreating deleted workflows. A send completed during a pause advances its step once and retains the pause when another step remains.

### Tables and calls

Splitting or editing inputs invalidates derived caches and fences older jobs. Split output keys and the 150-column limit are checked before writes. Skipped conditional columns clear obsolete outputs; generated outputs cannot take ownership of another column. Invalid formula syntax returns a useful client error while internal runtime failures remain distinguishable. Manual call outcomes remain authoritative over delayed recorder completion; cancellation restores eligible contacts; unanswered attempts are counted once per call, including concurrent and legacy paths.

### Channel identity and browser feedback

Channel imports distinguish message events from read/reaction/deletion events, compare self-sender identity using the provider payload, separate LinkedIn identities from telephone numbers, and do not match absent identifiers to blank phone fields. Explicit senders take precedence over cached chat associations. Ambiguous group traffic cannot be attributed as a direct personal message or advance automated CRM; known group messages remain history only. Message persistence requires a stable message identifier. The contract was checked against [Unipile's message webhook documentation](https://developer.unipile.com/docs/new-messages-webhook).

Browser testing also reproduced a stale contact dialog: a background AI draft was saved but did not appear until reopening or refreshing. Contact details now refresh while visible, and the button feedback explains that the draft appears automatically. The browser confirmed the draft count increasing without a reload or closing the dialog.

## Authorized browser verification

The user explicitly authorized local browser interaction after the repository's `AGENTS.md` restriction was explained. Tests ran in a dedicated local Worker with synthetic users and isolated local D1/R2. All external Worker requests were blocked except explicitly mocked provider endpoints; hosted authorization was intercepted with a local fixture page.

Verified owner setup, authenticated navigation, actionable missing-channel setup, invalid DSN feedback, saving a fixture channel configuration, fixture LinkedIn/WhatsApp authorization and return, notification registration feedback, contact creation, automatic draft appearance, formula preview and persisted queued formula execution. At 390 × 844, the mobile navigation opened and routed correctly; the channel page's document and body widths were both 390 pixels, with no horizontal overflow. [Browser verification record](agent-team-browser-verification.json).

No real provider account was authorized, webhook registered, message sent, or call made. Real account permissions, provider delivery and microphone/phone operation still need controlled acceptance using the user's accounts. Production verification uses the initialized-workspace GET-only checker and preserves existing users, contacts and provider settings.

## Release evidence

The implementation retains Workers, D1, private R2, Queues, Cron and Workers AI. No database schema migration is required for this release. Exact deployed SHA, GitHub CI and Cloudflare traffic/version evidence are recorded in [the deployment receipt](agent-team-deployment.json) and [the read-only production checks](agent-team-live-verification.json) after release.
