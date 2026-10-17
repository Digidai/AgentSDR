// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifyContactOutCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch("https://api.contactout.com/v1/stats", {
    method: "GET",
    headers: {
      Accept: "application/json",
      authorization: "basic",
      token: credentials.apiKey,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "ContactOut could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "ContactOut rejected this API token or it does not have API access.",
    );
  }
  if (response.status === 429)
    throw new Error("ContactOut rate-limited verification. Try again shortly.");
  throw new Error(
    "ContactOut could not verify this account right now. Try again shortly.",
  );
}
