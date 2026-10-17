// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifyLushaCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch("https://api.lusha.com/v3/account/usage", {
    method: "GET",
    headers: { Accept: "application/json", api_key: credentials.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Lusha could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw new Error("Lusha rejected this API key.");
  if (response.status === 429)
    throw new Error("Lusha rate-limited verification. Try again shortly.");
  throw new Error(
    "Lusha could not verify this account right now. Try again shortly.",
  );
}
