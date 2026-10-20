# Channel connection repair — 2026-10-20

The user reported that LinkedIn, WhatsApp and notification registration were unusable. The production settings metadata contained Resend and webhook connections, but no Unipile connection. No provider key or encrypted connection value was retrieved for diagnosis.

## Reproduced failures and repair

- Hosted authorization dereferenced a missing Unipile connection before checking prerequisites, returning a generic HTTP 500. Both channels now return a specific HTTP 400 setup message, and the page opens its connection setup form when configuration is missing.
- Unipile v1 DSN endpoints can include a service-specific HTTPS port. The previous shared URL validator rejected every non-443 port. Unipile endpoints now allow these ports only on HTTPS `*.unipile.com` hosts; arbitrary hosts and embedded credentials remain rejected. The configured address and key are trimmed before verification and encrypted storage.
- The channel page exposes a direct setup form and safe connection-readiness flags. Existing provider failures display actionable errors without changing the `ProviderError` uncertainty behavior used by background jobs.
- Hosted authorization validates channel/reconnection identity and the returned HTTPS Unipile authorization URL, then returns the user to the channel page with synchronization guidance.
- Notification registration checks the provider first, avoiding local webhook-credential writes when configuration is missing or provider access fails. Existing provider webhooks are reused on repeated registration. Its success dialog describes the result instead of showing `{ok:true}` and unrelated private-credential instructions.
- Work-email setup also guides the user to Google Workspace configuration before requesting a mailbox.

## Verification and boundary

The first 11 regression cases failed against the pre-repair behavior, including both missing-configuration crashes and the rejected Unipile DSN port. The final 12 connection tests pass, along with the full **256-test** suite, TypeScript, frontend/recorder builds and **22 compiled workerd checks**. Runtime checks verify that missing setup is handled without a crash or credential write. Successful channel authorization, DSN verification and notification registration use provider fixtures in local isolated databases.

No actual Unipile account was configured or registered during diagnosis. The user must supply their own Unipile DSN/API key and complete channel authentication. Production QA uses read-only requests and does not send messages, create provider webhooks, reset accounts or alter business data. Current deployment evidence is recorded separately.

Official provider reference: https://developer.unipile.com/docs/hosted-auth
