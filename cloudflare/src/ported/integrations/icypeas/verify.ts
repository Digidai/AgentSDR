// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifyIcypeasCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch(
    "https://app.icypeas.com/api/find-people/count",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: credentials.apiKey,
      },
      body: JSON.stringify({
        query: { currentCompanyId: { include: ["icypeas.com"] } },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => {
    throw new Error(
      "Icypeas could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
    } | null;
    if (payload?.success !== false) return;
    throw new Error("Icypeas rejected this API key.");
  }
  if (response.status === 401 || response.status === 403)
    throw new Error("Icypeas rejected this API key.");
  if (response.status === 429)
    throw new Error("Icypeas rate-limited verification. Try again shortly.");
  throw new Error(
    "Icypeas could not verify this account right now. Try again shortly.",
  );
}
