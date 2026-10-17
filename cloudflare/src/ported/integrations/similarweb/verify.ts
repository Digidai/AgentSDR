// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifySimilarwebCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch("https://api.similarweb.com/v3/batch/credits", {
    headers: { Accept: "application/json", "api-key": credentials.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Similarweb could not be reached. Check your connection and try again.",
    );
  });
  const payload = (await response.json().catch(() => null)) as {
    credits?: unknown;
  } | null;
  if (response.ok && typeof payload?.credits === "number") return;
  if (response.status === 401 || response.status === 403)
    throw new Error("Similarweb rejected this API key.");
  if (response.status === 429)
    throw new Error("Similarweb rate-limited verification. Try again shortly.");
  throw new Error(
    "Similarweb could not verify this account right now. Try again shortly.",
  );
}
