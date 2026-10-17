// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

const API_BASE = "https://api.millionverifier.com/api/v3";

export async function verifyMillionVerifierCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const url = new URL(`${API_BASE}/credits`);
  url.searchParams.set("api", credentials.apiKey);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "MillionVerifier could not be reached. Check your connection and try again.",
    );
  });
  const payload = (await response.json().catch(() => null)) as {
    credits?: unknown;
    error?: unknown;
  } | null;
  if (response.ok && typeof payload?.credits === "number") return;
  const error =
    typeof payload?.error === "string" ? payload.error.toLowerCase() : "";
  if (
    response.status === 401 ||
    response.status === 403 ||
    error.includes("api")
  )
    throw new Error("MillionVerifier rejected this API key.");
  if (response.status === 429)
    throw new Error(
      "MillionVerifier rate-limited verification. Try again shortly.",
    );
  throw new Error(
    "MillionVerifier could not verify this account right now. Try again shortly.",
  );
}
