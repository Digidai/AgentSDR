import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const directory = path.resolve(".wrangler/runtime-smoke");
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--dry-run",
    "--outdir",
    directory,
  ],
  { stdio: "pipe" },
);
const origin = "https://runtime.test";
const providerRequests = [];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modulesRoot: directory,
    modules: [
      { type: "ESModule", path: path.join(directory, "index.js") },
      ...(await readdir(directory))
        .filter((f) => f.endsWith(".wasm"))
        .map((f) => ({ type: "CompiledWasm", path: path.join(directory, f) })),
    ],
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      APP_URL: origin,
      ENCRYPTION_KEY: "runtime-fixture",
      UNSUBSCRIBE_SECRET: "runtime-unsubscribe",
      BOOTSTRAP_TOKEN: "runtime-private",
      AI_MODEL: "unused",
      RELEASE: "runtime-test",
    },
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
    queueProducers: { TASKS: "runtime-tasks" },
    queueConsumers: {
      "runtime-tasks": { maxBatchSize: 1, maxBatchTimeout: 0 },
    },
    outboundService: (request) => {
      providerRequests.push({ url: request.url, method: request.method });
      if (
        request.url === "https://api.resend.com/emails" &&
        request.method === "POST"
      )
        return Response.json({ id: "runtime-delivery-fixture" });
      if (
        request.url !== "https://api.resend.com/domains" ||
        request.method !== "GET"
      )
        throw new Error("Unexpected outbound request in runtime smoke");
      const key = request.headers.get("Authorization");
      if (key === "Bearer re_runtime_verified")
        return Response.json({
          data: [{ name: "example.invalid", status: "verified" }],
          has_more: false,
        });
      if (key === "Bearer re_runtime_redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://redirect.invalid/never-follow" },
        });
      return Response.json({ name: "restricted_api_key" }, { status: 403 });
    },
  }),
);
let count = 0,
  cookie = "";
function assert(ok, name) {
  if (!ok) throw new Error(name);
  count++;
  console.log("PASS " + name);
}
async function request(route, method = "GET", body) {
  return mf.dispatchFetch(origin + "/api" + route, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(route, method = "GET", body) {
  const r = await request(route, method, body),
    b = await r.json();
  if (!r.ok) throw new Error(`${route}: ${r.status} ${JSON.stringify(b)}`);
  return b;
}
try {
  const db = await mf.getD1Database("DB");
  for (const name of ["0001_native.sql", "0002_upstream_parity.sql"])
    await db.exec(await readFile("migrations/" + name, "utf8"));
  assert(
    (await api("/health")).release === "runtime-test",
    "compiled Worker starts in workerd",
  );
  const r = await request("/auth/setup", "POST", {
    token: "runtime-private",
    email: "runtime@example.invalid",
    name: "Runtime",
    organization: "Runtime",
    password: "runtime-fixture-long-password",
  });
  assert(r.status === 201, "WebCrypto auth with real D1");
  cookie = r.headers.get("set-cookie").split(";")[0];
  const table = await api("/tables", "POST", { name: "Wasm runtime" });
  const value = await api(`/tables/${table.id}/formula-preview`, "POST", {
    expression: '_.startCase({{name}})+":"+SUM([2,3])',
    row: { name: "hello_world" },
  });
  assert(
    value.ok && value.value === "Hello World:5",
    "static QuickJS WASM and all formula libraries execute in workerd",
  );
  const denied = await api(`/tables/${table.id}/formula-preview`, "POST", {
    expression: 'typeof process+":"+typeof fetch',
  });
  assert(
    denied.value === "undefined:undefined",
    "formula isolate has no host APIs",
  );
  assert(
    (await api("/provider-catalog")).items.length === 15,
    "all native provider definitions load",
  );
  assert(
    (await api("/crm/categories")).items.flatMap((c) => c.subcategories)
      .length > 10,
    "taxonomy seeds with real SQLite",
  );
  const person = await api("/people", "POST", {
      name: "Runtime contact",
      phone: "+12025550110",
      email: "runtime-contact@example.invalid",
    }),
    started = await api("/calls", "POST", { personId: person.id });
  assert(!!started.recorderToken, "recorder session uses WebCrypto and D1");
  assert(
    (await request("/accounts")).status === 200,
    "new channel endpoints run in workerd",
  );
  const resend = await request("/integrations/resend", "POST", {
    api_key: "re_runtime_verified",
    from_address: "runtime@example.invalid",
  });
  assert(
    resend.status === 200,
    "compiled Worker validates a provider through workerd fetch",
  );
  const restricted = await request("/integrations/resend", "POST", {
    api_key: "re_runtime_sending_only",
    from_address: "runtime@example.invalid",
  });
  assert(
    restricted.status === 400 &&
      (await restricted.json()).error.includes("Full access"),
    "provider permission errors remain actionable client errors",
  );
  const redirect = await request("/integrations/resend", "POST", {
    api_key: "re_runtime_redirect",
    from_address: "runtime@example.invalid",
  });
  assert(
    redirect.status === 400,
    "provider redirects are rejected without following credentials",
  );
  assert(
    providerRequests.length === 3 &&
      providerRequests.every(
        (r) => r.url === "https://api.resend.com/domains" && r.method === "GET",
      ),
    "connection checks make only read-only provider requests",
  );
  const identity = (await api("/auth/status")).user;
  await db
    .prepare("UPDATE organizations SET start_hour=0,end_hour=24 WHERE id=?")
    .bind(identity.org_id)
    .run();
  await db
    .prepare(
      "INSERT INTO drafts(id,org_id,person_id,channel,body) VALUES('runtime-draft',?,?,'email','Compiled runtime fixture')",
    )
    .bind(identity.org_id, person.id)
    .run();
  const queued = await api("/drafts/runtime-draft/send", "POST", {});
  const until = Date.now() + 10000;
  let sendJob;
  do {
    sendJob = await db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .bind(queued.job)
      .first();
    if (["done", "failed", "uncertain"].includes(sendJob?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert(
    sendJob?.status === "done",
    "compiled queue executes atomic dispatch and receipt transaction",
  );
  assert(
    (
      await db
        .prepare("SELECT status FROM drafts WHERE id='runtime-draft'")
        .first()
    ).status === "sent",
    "compiled queue persists confirmed draft delivery",
  );
  await (await mf.getBindings()).TASKS.send({ id: queued.job });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(
    providerRequests.filter((r) => r.method === "POST").length === 1,
    "duplicate delivery cannot reach the provider twice",
  );
  const columns = Array.from({ length: 150 }, (_, i) => ({
    key: `c${i}`,
    name: `Column ${i}`,
    type: "number",
  }));
  await api(`/tables/${table.id}`, "PATCH", { columns });
  assert(
    (await api(`/tables/${table.id}`)).columns.length === 150,
    "150-column invalidation fits real D1 argument limits",
  );
  const cycle = await request(`/tables/${table.id}`, "PATCH", {
    columns: [
      {
        key: "self",
        name: "Self",
        type: "formula",
        config: { expression: "{{self}}+1" },
      },
    ],
  });
  assert(
    cycle.status === 400,
    "compiled route rejects self-referential formulas",
  );
  const foreignKey =
    "foreign-workspace/photos/00000000-0000-4000-8000-000000000000";
  const media = await mf.getR2Bucket("MEDIA");
  await media.put(foreignKey, "private fixture");
  await api(`/people/${person.id}`, "PATCH", {
    custom: { photo_key: foreignKey },
  });
  assert(
    (await request(`/people/${person.id}/photo`)).status === 404,
    "compiled photo route rejects a forged foreign R2 key",
  );
  await api(`/people/${person.id}`, "DELETE");
  assert(
    !!(await media.head(foreignKey)),
    "deleting a lead cannot delete a foreign R2 photo",
  );
  console.log(`Runtime smoke: ${count} passed`);
} finally {
  await mf.dispose();
}
