/**
 * The AgentSDR origins the extension takes calls from and sends recordings
 * to. A call's recorder token is only ever sent back to the origin that
 * issued it, and only if that origin is allowed here.
 *
 * Two kinds:
 *  - BUILT_IN_ORIGINS, in static/manifest.json (the bridge content script's
 *    `matches` and `host_permissions`) — keep the two in sync;
 *  - origins added on the extension's Options page, for a self-hosted
 *    AgentSDR. Each is granted through `optional_host_permissions` when it is
 *    added, kept in chrome.storage.sync, and gets the bridge script through
 *    chrome.scripting.registerContentScripts (background.ts).
 */
export const BUILT_IN_ORIGINS: readonly string[] = ["https://sdr.genedai.me", "https://app.agentsdr.ai", "http://localhost:3000"];

const STORAGE_KEY = "customAppOrigins";

/**
 * The origin a person means by what they typed ("sdr.example.com",
 * "https://sdr.example.com/analytics"), or null if it cannot be one: only
 * https, or http on localhost / 127.0.0.1 for development.
 */
export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".") && !local) return null;
  return url.origin;
}

/** The match pattern that covers every page of an origin. */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

/** Origins added on the Options page, in the order they were added. */
export async function customOrigins(): Promise<string[]> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const list = stored[STORAGE_KEY];
  return Array.isArray(list) ? list.filter((value): value is string => typeof value === "string" && normalizeOrigin(value) === value) : [];
}

export async function saveCustomOrigins(origins: string[]): Promise<void> {
  const unique = [...new Set(origins)].filter((origin) => !BUILT_IN_ORIGINS.includes(origin));
  await chrome.storage.sync.set({ [STORAGE_KEY]: unique });
}

export function isCustomOriginsChange(changes: Record<string, unknown>): boolean {
  return STORAGE_KEY in changes;
}

/** Every origin the extension serves: the built-in ones, then the added ones. */
export async function allowedOrigins(): Promise<string[]> {
  return [...BUILT_IN_ORIGINS, ...(await customOrigins())];
}
