// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

export async function verifyRocketReachCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch("https://api.rocketreach.co/api/v2/account/", {
    method: "GET",
    headers: { Accept: "application/json", "Api-Key": credentials.apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "RocketReach could not be reached. Check your connection and try again.",
    );
  });
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw new Error("RocketReach rejected this API key.");
  if (response.status === 429)
    throw new Error(
      "RocketReach rate-limited verification. Try again shortly.",
    );
  throw new Error(
    "RocketReach could not verify this account right now. Try again shortly.",
  );
}
