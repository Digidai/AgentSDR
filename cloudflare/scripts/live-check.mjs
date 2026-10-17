import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const base = "https://sdr.genedai.me";
const expected =
  process.argv.find((value) => value.startsWith("--release="))?.slice(10) ||
  execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
const secrets = JSON.parse(await readFile(".secrets.production.json", "utf8"));
const checks = [];
let cookie = "",
  owner = "",
  org = "",
  email = "",
  fileId = "";
function check(name, condition) {
  if (!condition) throw new Error(name);
  checks.push(name);
  console.log("PASS " + name);
}
async function request(route, method = "GET", body, authenticated = true) {
  return fetch(base + route, {
    method,
    headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      Origin: base,
      ...(body === undefined || body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
}
async function api(route, method = "GET", body) {
  const r = await request("/api" + route, method, body);
  const b = await r.json();
  if (!r.ok) throw new Error(`${route}: ${r.status} ${b.error || ""}`);
  return b;
}
async function cf(sql, params = []) {
  const token = execFileSync(
    "python3",
    [
      "-c",
      "import tomllib;print(tomllib.load(open('/Users/dai/Library/Preferences/.wrangler/config/default.toml','rb'))['oauth_token'])",
    ],
    { encoding: "utf8" },
  ).trim();
  const r = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/48d9ccaf5ee7914c803b5d0656462848/d1/database/6f1a38df-84f6-4bbd-b665-2ca0e720d17e/query",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const b = await r.json();
  if (!r.ok || !b.success) throw new Error("Smoke cleanup query failed");
  return b.result;
}
let failure;
try {
  check(
    "HTTPS health and exact release SHA",
    (await api("/health")).release === expected,
  );
  check(
    "Private API returns 401",
    (await request("/api/people", "GET", undefined, false)).status === 401,
  );
  const status = await api("/auth/status");
  if (status.initialized)
    throw new Error(
      "Refusing smoke bootstrap: this workspace is already initialized",
    );
  check(
    "Public bootstrap rejects invalid secret",
    (
      await request(
        "/api/auth/setup",
        "POST",
        { token: "not-the-secret" },
        false,
      )
    ).status === 403,
  );
  email =
    "deployment-check-" + randomBytes(6).toString("hex") + "@example.invalid";
  const setup = await request(
    "/api/auth/setup",
    "POST",
    {
      token: secrets.BOOTSTRAP_TOKEN,
      email,
      name: "Deployment Check",
      organization: "Isolated deployment verification",
      password: randomBytes(32).toString("base64url"),
    },
    false,
  );
  check(
    "Owner setup and secure session cookie",
    setup.status === 201 &&
      setup.headers.get("set-cookie")?.includes("Secure") &&
      setup.headers.get("set-cookie")?.includes("HttpOnly"),
  );
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const user = (await api("/auth/status")).user;
  org = user.org_id;
  owner = user.id;
  const badOrigin = await fetch(base + "/api/people", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://example.invalid",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  check("Cross-origin mutation denied", badOrigin.status === 403);
  const person = await api("/people", "POST", {
    name: "Ada Example",
    email: "ada@example.invalid",
    company: "Example company",
    title: "Founder",
    notes:
      "Fictional data for deployment validation; removed after this check.",
  });
  check(
    "D1 authenticated write and read",
    (await api("/people/" + person.id)).name === "Ada Example",
  );
  const job = await api("/ai/draft", "POST", {
    person_id: person.id,
    prompt:
      "Write one concise English introductory email using only the provided facts. This is a fictional deployment check. Do not invent product claims.",
  });
  for (let i = 0; i < 24; i++) {
    const row = (await api("/jobs")).items.find((x) => x.id === job.job);
    if (row?.status === "done") break;
    if (["failed", "uncertain"].includes(row?.status))
      throw new Error("Live AI task failed: " + row.error);
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  const inbox = await api("/inbox");
  check(
    "Real Workers AI + Queue + D1 draft",
    inbox.drafts.length === 1 &&
      inbox.drafts[0].body.length > 10 &&
      inbox.drafts[0].status === "pending",
  );
  check(
    "No automatic message send",
    ((await api("/overview")).messages.sent || 0) === 0,
  );
  const campaign = await api("/campaigns", "POST", {
    name: "Deployment check — never started",
    channel: "email",
    steps: [
      {
        subject: "Test",
        body: "Fictional test; do not send",
        delay_minutes: 0,
      },
    ],
  });
  await api(`/campaigns/${campaign.id}/enroll`, "POST", {
    people: [person.id],
  });
  check(
    "Unconfigured outbound cannot start",
    (
      await request(`/api/campaigns/${campaign.id}`, "PATCH", {
        status: "active",
      })
    ).status === 400,
  );
  const table = await api("/tables", "POST", { name: "Deployment test table" });
  await api(`/tables/${table.id}/rows`, "POST", {
    rows: [{ name: "Fictional row", company: "Example" }],
  });
  check(
    "D1 enrichment table persistence",
    (await api(`/tables/${table.id}`)).rows.length === 1,
  );
  const form = new FormData();
  form.set("person_id", person.id);
  form.set(
    "file",
    new File(["private deployment check"], "verification.txt", {
      type: "text/plain",
    }),
  );
  fileId = (await api("/files", "POST", form)).id;
  check(
    "Private R2 upload and authenticated retrieval",
    (await (await request("/api/files/" + fileId)).text()) ===
      "private deployment check",
  );
  check(
    "R2 unauthenticated access blocked",
    (await request("/api/files/" + fileId, "GET", undefined, false)).status ===
      401,
  );
  const settings = await api("/settings");
  check(
    "Integration secrets absent from API",
    settings.integrations.length === 0 &&
      !JSON.stringify(settings).includes(secrets.ENCRYPTION_KEY),
  );
  const index = await fetch(base + "/");
  check(
    "Homepage and CSP",
    index.ok &&
      index.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
  );
  async function files(directory) {
    let all = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const f = path.join(directory, entry.name);
      if (entry.isDirectory()) all.push(...(await files(f)));
      else all.push(f);
    }
    return all;
  }
  for (const f of await files("dist")) {
    const relative = f.slice(5);
    const remote = await fetch(base + "/" + relative);
    let bytes = Buffer.from(await remote.arrayBuffer());
    if (relative === "index.html") {
      // Cloudflare's zone-level JavaScript Detection injects one dynamic
      // challenge script. Compare every original byte after removing only
      // that observed script; all application JS/CSS still require exact SHA.
      const html = bytes
        .toString("utf8")
        .replace(
          /<script>\(function\(\)\{function c\(\)\{[\s\S]*?<\/script>/g,
          (script) =>
            script.includes(
              "/cdn-cgi/challenge-platform/scripts/jsd/main.js",
            ) && script.includes("window.__CF$cv$params")
              ? ""
              : script,
        );
      bytes = Buffer.from(html);
    }
    check(
      (relative === "index.html"
        ? "HTML SHA256 after known Cloudflare JSD transform "
        : "Asset SHA256 ") + relative,
      remote.ok &&
        createHash("sha256").update(bytes).digest("hex") ===
          createHash("sha256")
            .update(await readFile(f))
            .digest("hex"),
    );
  }
  check(
    "Robots excludes private app",
    (await (await fetch(base + "/robots.txt")).text()).includes("Disallow: /"),
  );
} catch (e) {
  failure = e;
  console.error("FAIL " + e.message);
} finally {
  if (org && owner) {
    if (fileId) await api("/files/" + fileId, "DELETE");
    await cf("DELETE FROM organizations WHERE id=? AND name=?", [
      org,
      "Isolated deployment verification",
    ]);
    await cf("DELETE FROM users WHERE id=? AND email=?", [owner, email]);
    await cf("DELETE FROM setup_claim WHERE user_id=?", [owner]);
    console.log(
      "Removed only the isolated verification workspace and test account.",
    );
  }
  const state = await api("/auth/status");
  check(
    "Production ready for private owner setup",
    state.initialized === false && state.user === null,
  );
  await writeFile(
    "../docs/research/live-verification.json",
    JSON.stringify(
      {
        host: base,
        release: expected,
        checked_at: new Date().toISOString(),
        checks,
        syntheticWorkspaceRemoved: true,
        providerSendTested: false,
        browserInteractionTested: false,
        success: !failure,
      },
      null,
      2,
    ) + "\n",
  );
}
if (failure) throw failure;
