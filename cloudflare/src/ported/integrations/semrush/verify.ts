// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifySemrushCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const url = new URL("https://www.semrush.com/users/countapiunits.html");
  url.searchParams.set("key", credentials.apiKey);
  const response = await fetch(url, {
    headers: { Accept: "text/plain" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Semrush could not be reached. Check your connection and try again.",
    );
  });
  const text = (await response.text()).trim();
  if (response.ok && /^\d+$/.test(text)) return;
  if (response.status === 429)
    throw new Error("Semrush rate-limited verification. Try again shortly.");
  if (
    response.status === 401 ||
    response.status === 403 ||
    /ERROR|KEY/i.test(text)
  )
    throw new Error("Semrush rejected this API key.");
  throw new Error(
    "Semrush could not verify this account right now. Try again shortly.",
  );
}
