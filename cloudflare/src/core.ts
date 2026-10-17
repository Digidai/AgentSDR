const encoder = new TextEncoder();
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const toB64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
export const fromB64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export const token = () =>
  toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function hashPassword(
  password: string,
  salt = toB64(crypto.getRandomValues(new Uint8Array(16))),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromB64(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${toB64(new Uint8Array(hash))}`;
}
export function constantEqual(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2" || parts[1] !== "100000")
    return false;
  return constantEqual(await hashPassword(password, parts[2]), stored);
}
async function cipherKey(secret: string) {
  if (!secret) throw new Error("Encryption key is missing");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encrypt(value: unknown, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cipherKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `${toB64(iv)}.${toB64(new Uint8Array(data))}`;
}
export async function decrypt<T = Record<string, string>>(
  value: string,
  secret: string,
): Promise<T> {
  const [iv, data] = value.split(".");
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(iv) },
        await cipherKey(secret),
        fromB64(data),
      ),
    ),
  );
}
export async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toB64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function text(value: unknown, max = 10000) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}
export const emailValid = (v: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
export function json<T>(v: string | undefined, fallback: T): T {
  try {
    return JSON.parse(v || "") as T;
  } catch {
    return fallback;
  }
}
export function render(template: string, person: Record<string, unknown>) {
  const fields = {
    ...json<Record<string, unknown>>(
      typeof person.custom === "string"
        ? person.custom
        : JSON.stringify(person.custom || {}),
      {},
    ),
    ...person,
    first_name: String(person.name || "").split(" ")[0],
    full_name: person.name,
    job_title: person.title,
    company_name: person.company,
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) =>
    String(
      Object.hasOwn(fields, key)
        ? ((fields as Record<string, unknown>)[key] ?? "")
        : "",
    ),
  );
}
export function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function publicUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && !["443"].includes(url.port)) ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host === "localhost" ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    (host.endsWith(".workers.dev") && host.includes("localhost"))
  )
    throw new Error("Use a public HTTPS address");
  return url;
}
export function sendingWindow(org: Record<string, any>, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: org.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  return {
    allowed: hour >= Number(org.start_hour) && hour < Number(org.end_hour),
    day: `${p.year}-${p.month}-${p.day}`,
  };
}
export function classifyFallback(value: string) {
  if (
    /unsubscribe|remove me|stop contacting|退订|不要再/.test(
      value.toLowerCase(),
    )
  )
    return "unsubscribe";
  if (/out of (the )?office|automatic reply|休假/.test(value.toLowerCase()))
    return "out_of_office";
  return "needs_review";
}
export function extractJson<T>(value: string): T {
  const clean = value.replace(/```(?:json)?\s*|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error("AI returned an invalid response; try again");
  return JSON.parse(clean.slice(start, end + 1)) as T;
}

/** Workers AI can return text, OpenAI choices, or an already parsed JSON response. */
export function modelText(result: Record<string, any>): string {
  const value = result?.choices?.[0]?.message?.content ?? result?.response;
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  throw new Error("AI did not return content. Please retry the task.");
}
