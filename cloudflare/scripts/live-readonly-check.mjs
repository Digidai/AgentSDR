// Safe for an initialized workspace: GET requests only, no session or provider keys.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const expected = process.argv[2],
  output = process.argv[3];
if (!/^[a-f0-9]{40}$/.test(expected || ""))
  throw new Error("Pass the exact deployed Git SHA");
const origin = "https://sdr.genedai.me",
  checks = [];
function check(name, ok) {
  checks.push({ name, ok: !!ok });
  if (!ok) throw new Error(name);
  console.log("PASS " + name);
}
const get = (route) =>
  fetch(origin + route, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
const health = await get("/api/health"),
  healthBody = await health.json();
check(
  "HTTPS health and exact pushed runtime SHA",
  health.ok && healthBody.ok && healthBody.release === expected,
);
const status = await get("/api/auth/status"),
  statusBody = await status.json();
check(
  "Existing owner stays initialized and anonymous requests have no user",
  status.ok &&
    statusBody.initialized &&
    statusBody.user === null &&
    statusBody.version === expected,
);
check(
  "Private API responses cannot be cached",
  status.headers.get("cache-control") === "no-store",
);
for (const route of [
  "/api/people",
  "/api/inbox",
  "/api/settings",
  "/api/accounts",
  "/api/provider-connections",
  "/api/ai/connections",
  "/api/http-secrets",
  "/api/crm/categories",
  "/api/crm/classifications",
  "/api/calling/campaigns",
  "/api/calls",
  "/api/organizations",
  "/api/teams",
  "/api/tables",
  "/api/jobs",
  "/api/send-attempts",
  "/recorder.zip",
  "/downloads/call-recorder",
])
  check("Authentication required: " + route, (await get(route)).status === 401);
check(
  "Recorder capability required",
  (await get("/api/call-recorder/calls/audit-invalid")).status === 403,
);
check(
  "Private recording signature required",
  (await get("/api/recordings/audit-invalid")).status === 403,
);
const html = await get("/");
check("Application shell serves successfully", html.status === 200);
check(
  "Security headers restrict scripts and framing",
  html.headers.get("content-security-policy")?.includes("script-src 'self'") &&
    html.headers.get("x-frame-options") === "DENY" &&
    html.headers.get("x-content-type-options") === "nosniff",
);
const stripJsd = (s) =>
  s.replace(
    /<script>\(function\(\)\{function c\(\)\{[\s\S]*?<\/script>/g,
    (script) =>
      script.includes("/cdn-cgi/challenge-platform/scripts/jsd/main.js") &&
      script.includes("window.__CF$cv$params")
        ? ""
        : script,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = [];
check(
  "Application HTML matches this build after the known Cloudflare transform",
  hash(stripJsd(await html.text())) === hash(await readFile("dist/index.html")),
);
for (const file of await readdir("dist/assets")) {
  const r = await get("/assets/" + file),
    actual = hash(Buffer.from(await r.arrayBuffer())),
    expectedHash = hash(await readFile(path.join("dist/assets", file)));
  check("Asset hash: " + file, r.ok && actual === expectedHash);
  assets.push({ path: "/assets/" + file, sha256: expectedHash });
}
const result = {
  checked_at: new Date().toISOString(),
  origin,
  expected_sha: expected,
  production_mutations: 0,
  real_provider_calls: 0,
  checks,
  assets,
};
if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Read-only production checks: ${checks.length} passed`);
