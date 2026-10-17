// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifyHunterCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch("https://api.hunter.io/v2/account", {
    method: "GET",
    headers: { Accept: "application/json", "X-API-KEY": credentials.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Hunter could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw new Error("Hunter rejected this API key.");
  if (response.status === 429)
    throw new Error("Hunter rate-limited verification. Try again shortly.");
  throw new Error(
    "Hunter could not verify this account right now. Try again shortly.",
  );
}
