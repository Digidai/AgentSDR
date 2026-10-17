// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

const API_BASE = "https://api.apollo.io/api/v1";

export async function verifyApolloCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch(`${API_BASE}/users/api_profile`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": credentials.apiKey,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Apollo could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) return;
  if (response.status === 401) throw new Error("Apollo rejected this API key.");
  if (response.status === 403)
    throw new Error(
      "This Apollo key does not have permission to read the current user profile.",
    );
  if (response.status === 429)
    throw new Error("Apollo rate-limited verification. Try again shortly.");
  throw new Error(
    "Apollo could not verify this account right now. Try again shortly.",
  );
}
