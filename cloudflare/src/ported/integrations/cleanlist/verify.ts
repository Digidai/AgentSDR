// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.

import { asRecord, parseJson } from "../server/helpers";

const WHOAMI_URL = "https://api.cleanlist.ai/api/v2/whoami";
const REQUIRED_SCOPES = [
  "people:read",
  "companies:read",
  "enrich:write",
  "enrich:read",
] as const;

export async function verifyCleanlistCredentials(
  credentials: Record<string, string>,
): Promise<void> {
  const response = await fetch(WHOAMI_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      "Cleanlist could not be reached. Check your connection and try again.",
    );
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Cleanlist rejected this API key.");
  }
  if (response.status === 429) {
    throw new Error("Cleanlist rate-limited verification. Try again shortly.");
  }
  if (!response.ok) {
    throw new Error(
      "Cleanlist could not verify this account right now. Try again shortly.",
    );
  }

  const body = parseJson(await response.text());
  const rawScopes = asRecord(body).scopes;
  if (!Array.isArray(rawScopes)) {
    throw new Error(
      "Cleanlist verified the key but did not return its granted scopes.",
    );
  }
  const scopes = new Set(
    rawScopes.filter((scope): scope is string => typeof scope === "string"),
  );
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `Cleanlist API key is missing required scopes: ${missing.join(", ")}. Re-issue the key with these scopes and reconnect it.`,
    );
  }
}
