// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

const ZEROBOUNCE_CREDITS_URL = "https://api.zerobounce.net/v2/getcredits";

export async function verifyZeroBounceCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const url = new URL(ZEROBOUNCE_CREDITS_URL);
  url.searchParams.set("api_key", credentials.apiKey);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "ZeroBounce could not be reached. Check your connection and try again.",
    );
  });
  const payload = (await response.json().catch(() => null)) as {
    Credits?: unknown;
    credits?: unknown;
    error?: unknown;
  } | null;
  const credits = payload?.Credits ?? payload?.credits;
  if (response.ok && Number.isFinite(Number(credits)) && Number(credits) >= 0)
    return;
  if (response.status === 429)
    throw new Error("ZeroBounce rate-limited verification. Try again shortly.");
  if (
    Number(credits) === -1 ||
    response.status === 401 ||
    response.status === 403
  )
    throw new Error("ZeroBounce rejected this API key.");
  throw new Error(
    "ZeroBounce could not verify this account right now. Try again shortly.",
  );
}
