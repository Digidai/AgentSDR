// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifySnovCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  const response = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Snov.io could not be reached. Check your connection and try again.",
    );
  });
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
  } | null;
  if (
    response.ok &&
    typeof payload?.access_token === "string" &&
    payload.access_token
  )
    return;
  if (response.status === 400 || response.status === 401)
    throw new Error("Snov.io rejected this client ID or client secret.");
  if (response.status === 429)
    throw new Error("Snov.io rate-limited verification. Try again shortly.");
  throw new Error(
    "Snov.io could not verify this account right now. Try again shortly.",
  );
}
