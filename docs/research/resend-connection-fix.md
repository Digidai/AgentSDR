# Resend connection failure — 2026-10-20

The user's live Resend connection attempts failed before receiving an HTTP response. A workerd probe reproduced the exact runtime failure: Cloudflare fetch rejects `redirect: "error"` before making an outbound request. A separate route regression also hid provider validation errors: the newly mounted CRM integration endpoint shadowed the base endpoint and bypassed its validation error handling and rate limit.

## Fix

- Use `redirect: "manual"` for provider and website requests. Explicitly reject provider redirects, preserving the rule that credentials must not follow redirects.
- Restrict the CRM integration endpoint to its Google-specific providers and delegate shared providers to the base endpoint, restoring validation errors and limits.
- Trim Resend key/address fields and show actionable messages for invalid keys, insufficient permissions, rate limits and network failures. Explain the existing Full access requirement and sender-domain prerequisite in the connection form.

## Verification

- The new API regression failed before the route fix: expected HTTP 400, received the generic HTTP 500 shown by the user.
- The new compiled-Worker provider test failed before the fetch fix. Afterward, all 191 tests, TypeScript and builds passed, plus 12 compiled workerd checks.
- Compiled-runtime fixtures cover a successful connection, restricted-key rejection and redirect rejection. The fixture asserts that verification makes only three read-only GET requests to the domains endpoint.
- A separate unauthenticated live-network workerd probe reproduced the unsupported redirect error and received Resend HTTP 401 after switching to manual redirects. No real API key was used in this probe.
- This repair does not send email, replace user credentials or create/reset owner accounts. Real connection success and actual delivery remain separate acceptance steps after deployment.

The current deployment receipt is recorded separately; the original 32-check fresh-install report belongs to the earlier release and must not be rerun on the now initialized workspace.
