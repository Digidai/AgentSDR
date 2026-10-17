import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { app } from "../src/api";
import { processJob, enqueue, tick } from "../src/jobs";
import {
  id,
  now,
  digest,
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
} from "../src/core";
import { evaluateFormula, formulaTokens } from "../src/features/formula";
import { orderedColumns } from "../src/features/tables";
import { INTEGRATIONS } from "../src/ported/integrations/catalog";
import { getIntegrationActionHandler } from "../src/ported/integrations/server/registry";
import { verifyIntegrationCredentials } from "../src/ported/integrations/verification";
import {
  syncGmail,
  sendGmail,
  parseGmailMessage,
  base64url,
  decodeBase64url,
  googleToken,
} from "../src/features/google";
import {
  withinHours,
  reserveAccount,
  acceptConnection,
  selectAccount,
  processWebhook,
  importChat,
} from "../src/features/channels";
import {
  attachSequence,
  createSequenceDraft,
  advanceCrmDraft,
  setCategory,
} from "../src/features/crm";
import { pref, savePref, record } from "../src/features/shared";
import { receive } from "../src/inbound";
import type { Env, Row } from "../src/types";
let env: Env,
  mf: Miniflare,
  cookie = "",
  org = "",
  person = "",
  owner = "";
const origin = "https://sdr.test";
async function req(
  path: string,
  method = "GET",
  body?: unknown,
  session = cookie,
  headers: Row = {},
) {
  return app.request(
    origin + "/api" + path,
    {
      method,
      headers: {
        Origin: origin,
        ...(session ? { Cookie: session } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function data(path: string, method = "GET", body?: unknown) {
  const r = await req(path, method, body),
    b: any = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`);
  return b;
}
const sql = (s: string, ...args: any[]) => env.DB.prepare(s).bind(...args);
const fetchMock = (
  fn: (url: string, init: RequestInit) => Response | Promise<Response>,
) => {
  const mock = vi.fn((u: any, i: RequestInit = {}) =>
    Promise.resolve(fn(String(u), i)),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
};
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
      queueProducers: { TASKS: "parity-tasks" },
    }),
  );
  env = {
    ...(await mf.getBindings()),
    APP_URL: origin,
    ENCRYPTION_KEY: "encryption-test",
    UNSUBSCRIBE_SECRET: "unsub-test",
    BOOTSTRAP_TOKEN: "private",
    AI_MODEL: "test",
    AI: {
      run: vi.fn(async () => ({
        response:
          '{"classification":"interested","confidence":0.9,"draft":"Thank you","summary":"Synthetic test call"}',
        text: "Synthetic test call",
      })),
    },
  } as unknown as Env;
  for (const name of ["0001_native.sql", "0002_upstream_parity.sql"])
    await env.DB.exec(
      await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"),
    );
  const r = await req(
    "/auth/setup",
    "POST",
    {
      token: "private",
      email: "owner@parity.example",
      name: "Owner",
      organization: "Parity",
      password: "correct-horse-battery-staple",
    },
    "",
  );
  expect(r.status).toBe(201);
  cookie = r.headers.get("set-cookie")!.split(";")[0];
  const status = await data("/auth/status");
  org = status.user.org_id;
  owner = status.user.id;
  person = (
    await data("/people", "POST", {
      name: "Synthetic Contact",
      email: "synthetic@example.com",
      phone: "+12025550100",
      linkedin: "https://linkedin.com/in/synthetic",
    })
  ).id;
  await sql(
    "INSERT INTO organizations(id,name) VALUES('other-org','Other')",
  ).run();
}, 30000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await mf?.dispose();
});
describe("pinned upstream implementation contracts", () => {
  it("contains all 15 providers and 84 implemented actions", () => {
    expect(INTEGRATIONS).toHaveLength(15);
    expect(
      INTEGRATIONS.flatMap((d) => d.actions.filter((a) => a.implemented)),
    ).toHaveLength(84);
  });
  for (const d of INTEGRATIONS)
    for (const a of d.actions.filter((a) => a.implemented))
      it(`${d.key}/${a.key} has a native runnable handler`, () => {
        expect(getIntegrationActionHandler(a.handlerKey)).toBeTypeOf(
          "function",
        );
        expect(a.docsUrl).toMatch(/^https:/);
        expect(new Set(a.inputs.map((i) => i.key)).size).toBe(a.inputs.length);
      });
  for (const d of INTEGRATIONS)
    it(`${d.key} refuses an unauthorized connection`, async () => {
      fetchMock(() => new Response("{}", { status: 401 }));
      const creds = Object.fromEntries(
        d.auth.fields.map((f) => [f.key, "test-not-a-secret"]),
      );
      await expect(
        verifyIntegrationCredentials(d.key, creds),
      ).rejects.toThrow();
    });
});
describe("isolated QuickJS formulas", () => {
  it("loads lodash, moment and FormulaJS in the sandbox", async () => {
    expect(
      await evaluateFormula('_.startCase({{name}}) + ":" + SUM([1,2,3])', {
        name: "hello_world",
      }),
    ).toBe("Hello World:6");
    expect(await evaluateFormula('moment("2026-10-17").format("YYYY")')).toBe(
      "2026",
    );
  });
  it("quotes untrusted values and keeps host APIs absent", async () => {
    expect(
      await evaluateFormula("{{x}}", { x: '"; globalThis.owned=true; //' }),
    ).toContain("globalThis.owned");
    expect(
      await evaluateFormula("[typeof fetch, typeof process, typeof require]"),
    ).toEqual(["undefined", "undefined", "undefined"]);
    expect(await evaluateFormula("typeof globalThis.owned")).toBe("undefined");
  });
  it("interrupts infinite loops and survives the next evaluation", async () => {
    await expect(evaluateFormula("(()=>{while(true){} })()")).rejects.toThrow(
      /interrupted/,
    );
    expect(await evaluateFormula("2+3")).toBe(5);
  }, 5000);
  it("sorts dependencies and rejects cycles", () => {
    expect(
      orderedColumns([
        {
          key: "b",
          name: "B",
          type: "formula",
          config: { expression: "{{a}}+1" },
        },
        { key: "a", name: "A", type: "text" },
      ]).map((x) => x.key),
    ).toEqual(["a", "b"]);
    expect(() =>
      orderedColumns([
        {
          key: "a",
          name: "A",
          type: "formula",
          config: { expression: "{{b}}" },
        },
        {
          key: "b",
          name: "B",
          type: "formula",
          config: { expression: "{{a}}" },
        },
      ]),
    ).toThrow(/cycle/);
  });
  it("LOOKUP is limited to explicit organization data", async () => {
    expect(
      await evaluateFormula(
        'LOOKUP("rates","USD","key","rate",0)',
        {},
        { rates: [{ key: "USD", rate: 7 }] },
      ),
    ).toBe(7);
  });
});
describe("D1 tables, dependent enrichment and histories", () => {
  let tid = "",
    rid = "";
  it("preserves old rows through the additive schema and supports folders/workbooks", async () => {
    const f = await data("/folders", "POST", { name: "Research" }),
      w = await data("/workbooks", "POST", {
        name: "Workbook",
        folder_id: f.id,
      });
    tid = (await data("/tables", "POST", { name: "Calculation" })).id;
    await data(`/tables/${tid}`, "PATCH", {
      workbook_id: w.id,
      columns: [
        { key: "name", name: "Name", type: "text" },
        { key: "count", name: "Count", type: "number" },
        {
          key: "sum",
          name: "Total",
          type: "formula",
          config: { expression: "{{count}}+2" },
        },
      ],
    });
    await data(`/tables/${tid}/rows`, "POST", {
      rows: [{ name: "Row", count: 3 }],
    });
    rid = (await data(`/tables/${tid}`)).rows[0].id;
    await data(`/workbooks/${w.id}/reorder`, "POST", { ids: [tid] });
  });
  it("executes a real QuickJS formula through the task queue and records audit", async () => {
    await data(`/tables/${tid}/run`, "POST", {});
    const j = await sql(
      "SELECT id FROM jobs WHERE kind='table-row' AND json_extract(payload,'$.row_id')=? ORDER BY rowid DESC",
      rid,
    ).first<Row>();
    await processJob(env, j!.id);
    const row = (await data(`/tables/${tid}`)).rows[0];
    expect(row.cells.sum).toBe(5);
    expect(row.cell_meta.sum.status).toBe("success");
    expect((await data(`/tables/${tid}/runs`)).items[0].status).toBe("done");
  });
  it("invalidates dependent results after editing and auto-runs new rows", async () => {
    await data(`/tables/${tid}`, "PATCH", { auto_run: true });
    await data(`/tables/${tid}/rows/${rid}`, "PATCH", { cells: { count: 7 } });
    const j = await sql(
      "SELECT id FROM jobs WHERE kind='table-row' AND json_extract(payload,'$.row_id')=? ORDER BY rowid DESC",
      rid,
    ).first<Row>();
    await processJob(env, j!.id);
    expect((await data(`/tables/${tid}`)).rows[0].cells.sum).toBe(9);
    await data(`/tables/${tid}/rows`, "POST", {
      rows: [{ name: "Auto", count: 1 }],
    });
    expect(
      (await sql(
        "SELECT COUNT(*) n FROM jobs WHERE kind='table-row' AND json_extract(payload,'$.table_id')=?",
        tid,
      ).first<Row>())!.n,
    ).toBeGreaterThanOrEqual(3);
  });
  it("deduplicates and splits without deleting unrelated data", async () => {
    await data(`/tables/${tid}/rows`, "POST", {
      rows: [{ name: "Row", count: 8 }],
    });
    expect(
      (await data(`/tables/${tid}/dedupe`, "POST", { key: "name" })).removed,
    ).toBe(1);
    await data(`/tables/${tid}/split`, "POST", {
      key: "name",
      separator: "o",
      outputs: ["piece_a", "piece_b"],
    });
    expect(
      (await data(`/tables/${tid}`)).columns.some(
        (c: Row) => c.key === "piece_a",
      ),
    ).toBe(true);
  });
  it("validates provider credentials and writes mapped outputs", async () => {
    fetchMock((url) => {
      if (url.endsWith("/account")) return Response.json({ data: {} });
      expect(url).toContain("email-finder");
      return Response.json({ data: { email: "found@example.com", score: 99 } });
    });
    const connection = await data("/provider-connections", "POST", {
      provider: "hunter",
      name: "Hunter test",
      credentials: { apiKey: "fixture" },
    });
    await data(`/tables/${tid}`, "PATCH", {
      columns: [
        { key: "domain", name: "Domain", type: "text" },
        { key: "fullName", name: "Full name", type: "text" },
        {
          key: "find",
          name: "Find",
          type: "enrichment",
          config: {
            integrationKey: "hunter",
            actionKey: "find-work-email",
            connectionId: connection.id,
            inputs: {
              fullName: { source: "column", columnKey: "fullName" },
              companyDomain: { source: "column", columnKey: "domain" },
            },
          },
        },
      ],
    });
    await data(`/tables/${tid}/rows/${rid}`, "PATCH", {
      cells: { domain: "example.com", fullName: "Synthetic Contact" },
    });
    const jid = await enqueue(env, org, "table-row", {
      table_id: tid,
      row_id: rid,
      force: true,
    });
    await processJob(env, jid);
    const row = (await data(`/tables/${tid}`)).rows.find(
      (r: Row) => r.id === rid,
    );
    expect(row.cell_meta.find.status).toBe("success");
    expect(Object.values(row.cells)).toContain("found@example.com");
    expect(
      (await data(`/tables/${tid}`)).columns.some(
        (c: Row) => c.type === "integration_output",
      ),
    ).toBe(true);
    const exposed = JSON.stringify(await data("/provider-connections"));
    expect(exposed).not.toContain("fixture");
  });
  it("separates saved HTTP secrets and denies another organization table", async () => {
    await data("/http-secrets/GRID_HTTP_SECRET_TEST", "PUT", {
      value: "Bearer fixture",
    });
    expect((await data("/http-secrets")).keys).toContain(
      "GRID_HTTP_SECRET_TEST",
    );
    expect(
      (await req("/http-secrets/PLAIN", "PUT", { value: "bad" })).status,
    ).toBe(400);
    await sql(
      "INSERT INTO enrichment_tables(id,org_id,name) VALUES('other-table','other-org','Private')",
    ).run();
    expect(
      (
        await req("/tables/other-table/formula-preview", "POST", {
          expression: "1",
        })
      ).status,
    ).toBe(404);
  });
});
describe("CRM taxonomy, immutable sequences and safe progression", () => {
  let sid = "",
    eid = "",
    did = "";
  it("seeds upstream taxonomy once and retains human deletion", async () => {
    const cat = await data("/crm/categories"),
      subs = cat.items.flatMap((c: Row) => c.subcategories);
    expect(subs.length).toBeGreaterThan(10);
    await data(`/crm/subcategories/${subs[0].id}`, "DELETE");
    expect(
      (await data("/crm/categories")).items.flatMap(
        (c: Row) => c.subcategories,
      ),
    ).toHaveLength(subs.length - 1);
  });
  it("publishes immutable versions and enqueues human-reviewed drafts", async () => {
    sid = (
      await data("/crm/sequences", "POST", {
        name: "Follow up",
        steps: [
          { channel: "email", body: "Version one", delay_minutes: 0 },
          { channel: "email", body: "Second", delay_minutes: 1440 },
        ],
      })
    ).id;
    await data(`/crm/sequences/${sid}/publish`, "POST", {});
    await data(`/crm/sequences/${sid}`, "PATCH", {
      steps: [{ channel: "email", body: "Version two" }],
    });
    await attachSequence(env, org, person, sid);
    const e = await sql(
      "SELECT * FROM crm_enrollments WHERE person_id=? AND status='active'",
      person,
    ).first<Row>();
    eid = e!.id;
    await createSequenceDraft(env, org, eid);
    const d = await sql(
      "SELECT * FROM drafts WHERE id=(SELECT draft_id FROM crm_enrollments WHERE id=?)",
      eid,
    ).first<Row>();
    did = d!.id;
    expect(d!.body).toBe("Version one");
    expect(
      (await sql(
        "SELECT step FROM crm_enrollments WHERE id=?",
        eid,
      ).first<Row>())!.step,
    ).toBe(0);
    await createSequenceDraft(env, org, eid);
    expect(
      (await sql("SELECT COUNT(*) n FROM drafts WHERE id=?", did).first<Row>())!
        .n,
    ).toBe(1);
  });
  it("advances only after a confirmed send and applies next-step delay", async () => {
    await advanceCrmDraft(env, org, did);
    const e = await sql(
      "SELECT * FROM crm_enrollments WHERE id=?",
      eid,
    ).first<Row>();
    expect(e!.step).toBe(1);
    expect(Date.parse(e!.next_run)).toBeGreaterThan(Date.now() + 23 * 3600000);
  });
  it("incoming replies cancel the old sequence and pending follow-up draft", async () => {
    await sql(
      "UPDATE crm_enrollments SET next_run=? WHERE id=?",
      now(),
      eid,
    ).run();
    await createSequenceDraft(env, org, eid);
    const e = await sql(
      "SELECT * FROM crm_enrollments WHERE id=?",
      eid,
    ).first<Row>();
    await receive(env, org, "email", {
      external_id: "stop-sequence",
      person_id: person,
      body: "Please send information",
    });
    expect(
      (await sql(
        "SELECT status FROM crm_enrollments WHERE id=?",
        eid,
      ).first<Row>())!.status,
    ).toBe("stopped");
    expect(
      (await sql(
        "SELECT status FROM drafts WHERE id=?",
        e!.draft_id,
      ).first<Row>())!.status,
    ).toBe("discarded");
  });
  it("keeps historical chat imports outside CRM and does not stop a sequence", async () => {
    await attachSequence(env, org, person, sid);
    await receive(env, org, "whatsapp", {
      external_id: "historical",
      person_id: person,
      body: "Old reply",
      historyOnly: true,
    });
    expect(
      (await sql(
        "SELECT status FROM crm_enrollments WHERE person_id=? ORDER BY rowid DESC",
        person,
      ).first<Row>())!.status,
    ).toBe("active");
  });
  it("protects customer stage from automatic downgrades and can undo classifications", async () => {
    await sql("UPDATE people SET stage='customer' WHERE id=?", person).run();
    const cid = await setCategory(
      env,
      org,
      person,
      "interested",
      null,
      "ai",
      "Example",
      0.7,
    );
    expect((await record(env, org, "people", person)).stage).toBe("customer");
    await data(`/crm/classifications/${cid}/undo`, "POST", {});
    expect((await record(env, org, "people", person)).stage).toBe("customer");
  });
  it("supports notes, tasks, typed fields and previews incompatible conversions", async () => {
    const f = await data("/lead-fields", "POST", {
      key: "budget",
      name: "Budget",
      type: "text",
    });
    await data(`/people/${person}`, "PATCH", { custom: { budget: "unknown" } });
    expect(
      (await data(`/lead-fields/${f.id}/type-preview?type=number`))
        .incompatible,
    ).toBe(1);
    await data("/notes", "POST", {
      person_id: person,
      body: "Internal context",
    });
    const task = await data("/tasks", "POST", {
      person_id: person,
      title: "Follow up",
    });
    await data(`/tasks/${task.id}`, "PATCH", { status: "done" });
    expect((await data(`/notes?person_id=${person}`)).items[0].body).toBe(
      "Internal context",
    );
    expect((await data("/tasks")).items[0].status).toBe("done");
  });
  it("stores unmatched replies for explicit identity resolution", async () => {
    await receive(env, org, "email", {
      external_id: "unknown-id",
      email: "unmatched@example.com",
      body: "Who handles this?",
    });
    const e = (await data("/crm/identity-exceptions")).items[0];
    await data(`/crm/identity-exceptions/${e.id}`, "PATCH", {
      status: "resolved",
      person_id: person,
    });
    expect(
      (await sql(
        "SELECT person_id FROM messages WHERE external_id='unknown-id'",
      ).first<Row>())!.person_id,
    ).toBe(person);
  });
});
describe("channel accounts, pacing, acceptance and inbox behavior", () => {
  let linkedin = "",
    whatsapp = "";
  it("syncs Unipile accounts and persists per-account preferences", async () => {
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'unipile',?)",
      org,
      await encrypt(
        { api_key: "fixture", base_url: "https://fixture.unipile.com" },
        env.ENCRYPTION_KEY,
      ),
    ).run();
    fetchMock(() =>
      Response.json({
        items: [
          {
            id: "li-fixture",
            type: "LINKEDIN",
            name: "LI",
            sources: [{ status: "OK" }],
          },
          {
            id: "wa-fixture",
            type: "WHATSAPP",
            name: "WA",
            sources: [{ status: "OK" }],
          },
        ],
      }),
    );
    expect((await data("/accounts/sync", "POST", {})).synced).toBe(2);
    const accounts = (await data("/accounts")).items;
    linkedin = accounts.find((a: Row) => a.channel === "linkedin").id;
    whatsapp = accounts.find((a: Row) => a.channel === "whatsapp").id;
    await data(`/accounts/${linkedin}`, "PATCH", {
      is_default: true,
      daily_limit: 1,
      settings: { hours: null },
    });
    expect(
      (await record(env, org, "channel_accounts", linkedin)).is_default,
    ).toBe(1);
  });
  it("does not claim a provider account already owned by another organization", async () => {
    await sql(
      "INSERT INTO channel_accounts(id,org_id,channel,external_id) VALUES('foreign-account','other-org','linkedin','foreign-external')",
    ).run();
    fetchMock(() =>
      Response.json({
        items: [
          {
            id: "foreign-external",
            type: "LINKEDIN",
            sources: [{ status: "OK" }],
          },
        ],
      }),
    );
    expect((await req("/accounts/sync", "POST", {})).status).toBe(400);
  });
  it("validates organization rules and overnight hours", async () => {
    expect(
      (await req("/channel-rules/email", "PUT", { dailySendLimit: 9999 }))
        .status,
    ).toBe(400);
    expect(
      withinHours(
        { timezone: "UTC", days: [1], start: "22:00", end: "02:00" },
        new Date("2026-10-20T01:00:00Z"),
      ),
    ).toBe(true);
    expect(
      withinHours(
        { timezone: "UTC", days: [1], start: "22:00", end: "02:00" },
        new Date("2026-10-20T03:00:00Z"),
      ),
    ).toBe(false);
  });
  it("atomically reserves daily capacity across concurrent workers", async () => {
    const a = await record(env, org, "channel_accounts", linkedin),
      p = await record(env, org, "people", person);
    const outcomes = await Promise.allSettled([
      reserveAccount(env, org, a, p, "invite"),
      reserveAccount(env, org, a, p, "invite"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await sql(
        "SELECT SUM(count) n FROM daily_usage WHERE channel=?",
        `account:${linkedin}:invite`,
      ).first<Row>())!.n,
    ).toBe(1);
    const ok = outcomes.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<any>;
    await ok.value.release();
    expect(
      (await sql(
        "SELECT SUM(count) n FROM daily_usage WHERE channel=?",
        `account:${linkedin}:invite`,
      ).first<Row>())!.n,
    ).toBe(0);
  });
  it("rejects a brand-new WhatsApp campaign contact during warmup", async () => {
    const p = await record(env, org, "people", person);
    await expect(
      selectAccount(
        env,
        org,
        { channel: "whatsapp", account_id: whatsapp },
        { account_id: whatsapp },
        p,
        "message",
      ),
    ).rejects.toThrow(/warming up/);
  });
  it("unlocks a LinkedIn sequence only for the matching accepting identity", async () => {
    const c = await data("/campaigns", "POST", {
      name: "Connection",
      channel: "linkedin",
      steps: [
        { action: "invite", body: "Hello" },
        { body: "After acceptance", delay_minutes: 0 },
      ],
    });
    await sql(
      "UPDATE people SET custom=json_set(custom,'$.linkedin_provider_id','member-123') WHERE id=?",
      person,
    ).run();
    await sql(
      "INSERT INTO enrollments(id,org_id,campaign_id,person_id,next_run,step,gate,account_id) VALUES('accept-enrollment',?,?,?,?,1,'acceptance',?)",
      org,
      c.id,
      person,
      now(),
      linkedin,
    ).run();
    await acceptConnection(env, org, {
      account_id: "li-fixture",
      user_provider_id: "wrong",
    });
    expect(
      (await record(env, org, "enrollments", "accept-enrollment")).gate,
    ).toBe("acceptance");
    await acceptConnection(env, org, {
      account_id: "li-fixture",
      user_provider_id: "member-123",
    });
    expect(
      (await record(env, org, "enrollments", "accept-enrollment")).gate,
    ).toBe("");
  });
  it("protects webhook endpoints and preserves incoming phone echoes", async () => {
    expect(
      (
        await req(`/channel-webhooks/${org}/messages`, "POST", {
          account_id: "wa-fixture",
        })
      ).status,
    ).toBe(403);
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'webhook',?)",
      org,
      await encrypt(
        { secret: "webhook-fixture-private-long-value" },
        env.ENCRYPTION_KEY,
      ),
    ).run();
    const accepted = await req(
      `/channel-webhooks/${org}/messages`,
      "POST",
      {
        account_id: "wa-fixture",
        chat_id: "chat-fixture",
        message_id: "echo-1",
        is_sender: true,
        sender: { attendee_provider_id: "12025550100@s.whatsapp.net" },
        message: "Sent from phone",
      },
      "",
      { "X-Webhook-Secret": "webhook-fixture-private-long-value" },
    );
    expect(accepted.status).toBe(200);
    const event = await sql(
      "SELECT * FROM webhook_events ORDER BY rowid DESC",
    ).first<Row>();
    await processWebhook(env, org, event!.id);
    expect(
      (await sql(
        "SELECT direction FROM messages WHERE external_id='echo-1'",
      ).first<Row>())!.direction,
    ).toBe("outbound");
  });
  it("paginates LinkedIn searches and imports unique identities", async () => {
    const b = await data("/search/batches", "POST", {
      name: "Test search",
      account_id: linkedin,
      queries: ["engineers"],
    });
    fetchMock(() =>
      Response.json({
        items: [
          {
            id: "member-search",
            name: "Synthetic Search",
            public_profile_url: "https://linkedin.com/in/test",
          },
        ],
        cursor: "next-page",
      }),
    );
    await data(`/search/batches/${b.id}/run`, "POST", {});
    const q = await sql(
        "SELECT id FROM search_queries WHERE batch_id=?",
        b.id,
      ).first<Row>(),
      j = await sql(
        "SELECT id FROM jobs WHERE kind='linkedin-search' AND json_extract(payload,'$.query_id')=?",
        q!.id,
      ).first<Row>();
    await processJob(env, j!.id);
    expect(
      (await data(`/search/batches/${b.id}`)).queries[0].results,
    ).toHaveLength(1);
    expect(
      (await data(`/search/batches/${b.id}/continue`, "POST", {})).queued,
    ).toBe(1);
    expect(
      (await data(`/search/batches/${b.id}/import`, "POST", {})).imported,
    ).toBe(1);
    expect(
      (await data(`/search/batches/${b.id}/import`, "POST", {})).imported,
    ).toBe(0);
  });
});
describe("delegated Gmail and MIME contracts", () => {
  let mailbox = "",
    rsa: CryptoKeyPair;
  beforeAll(async () => {
    rsa = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(
        await crypto.subtle.exportKey("pkcs8", rsa.privateKey),
      ).toString("base64") +
      "\n-----END PRIVATE KEY-----";
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'google-workspace',?)",
      org,
      await encrypt(
        {
          client_email: "service@fixture.iam.gserviceaccount.com",
          private_key: pem,
          webhook_secret: "gmail-hook-private",
        },
        env.ENCRYPTION_KEY,
      ),
    ).run();
  });
  const mail = (mid: string) => ({
    id: mid,
    threadId: "thread-1",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Synthetic <synthetic@example.com>" },
        { name: "Subject", value: "Reply" },
        { name: "Message-ID", value: "<rfc-fixture@example.com>" },
      ],
      mimeType: "text/plain",
      body: { data: base64url("请给我产品资料。") },
    },
  });
  it("signs a delegated RS256 assertion with the correct mailbox and scopes", async () => {
    const fetch = fetchMock(async (url, init) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const assertion = new URLSearchParams(init.body as URLSearchParams)
          .get("assertion")!
          .split("."),
        claims = JSON.parse(
          new TextDecoder().decode(decodeBase64url(assertion[1])),
        );
      expect(claims.sub).toBe("sender@fixture.example");
      expect(claims.scope).toContain("gmail.modify");
      expect(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          rsa.publicKey,
          decodeBase64url(assertion[2]),
          new TextEncoder().encode(assertion[0] + "." + assertion[1]),
        ),
      ).toBe(true);
      return Response.json({
        access_token: "delegated-fixture",
        expires_in: 3600,
      });
    });
    expect(await googleToken(env, org, "sender@fixture.example")).toBe(
      "delegated-fixture",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("creates the mailbox and refuses spoofed Pub/Sub notifications", async () => {
    fetchMock((url) => {
      expect(url).toContain("/profile");
      return Response.json({
        emailAddress: "sender@fixture.example",
        historyId: "10",
      });
    });
    mailbox = (
      await data("/mailboxes", "POST", {
        email: "sender@fixture.example",
        name: "Sender",
        signature: "Best, Sender",
      })
    ).id;
    expect(
      (
        await req("/outreach/webhooks/gmail-watch?token=wrong", "POST", {
          emailAddress: "sender@fixture.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "/outreach/webhooks/gmail-watch?token=gmail-hook-private",
          "POST",
          {
            message: {
              data: base64url(
                JSON.stringify({
                  emailAddress: "sender@fixture.example",
                  historyId: "99",
                }),
              ),
            },
          },
        )
      ).status,
    ).toBe(200);
  });
  it("does not advance a Gmail history cursor until all pages have persisted", async () => {
    fetchMock((url) =>
      url.includes("/history?")
        ? Response.json(
            url.includes("pageToken=page-2")
              ? {
                  historyId: "30",
                  history: [
                    {
                      id: "29",
                      messagesAdded: [{ message: { id: "gmail-2" } }],
                    },
                  ],
                }
              : {
                  historyId: "30",
                  nextPageToken: "page-2",
                  history: [
                    {
                      id: "20",
                      messagesAdded: [{ message: { id: "gmail-1" } }],
                    },
                  ],
                },
          )
        : Response.json(mail(url.includes("gmail-2") ? "gmail-2" : "gmail-1")),
    );
    await syncGmail(env, org, mailbox);
    expect(
      (await record(env, org, "channel_accounts", mailbox)).history_id,
    ).toBe("10");
    expect((await pref<Row>(env, org, `gmail-sync:${mailbox}`, {})).page).toBe(
      "page-2",
    );
    await syncGmail(env, org, mailbox);
    expect(
      (await record(env, org, "channel_accounts", mailbox)).history_id,
    ).toBe("30");
    expect(
      (await sql(
        "SELECT COUNT(*) n FROM messages WHERE external_id IN ('gmail-1','gmail-2')",
      ).first<Row>())!.n,
    ).toBe(2);
  });
  it("keeps the cursor stable when a message fetch fails, then safely retries", async () => {
    let fail = true;
    fetchMock((url) => {
      if (url.includes("/history?"))
        return Response.json({
          historyId: "40",
          history: [{ messagesAdded: [{ message: { id: "gmail-3" } }] }],
        });
      return fail
        ? new Response("{}", { status: 503 })
        : Response.json(mail("gmail-3"));
    });
    await expect(syncGmail(env, org, mailbox)).rejects.toThrow();
    expect(
      (await record(env, org, "channel_accounts", mailbox)).history_id,
    ).toBe("30");
    fail = false;
    await syncGmail(env, org, mailbox);
    expect(
      (await record(env, org, "channel_accounts", mailbox)).history_id,
    ).toBe("40");
  });
  it("encodes Unicode MIME, signatures, RFC reply headers and thread affinity", async () => {
    const a = await record(env, org, "channel_accounts", mailbox),
      p = await record(env, org, "people", person);
    fetchMock((_url, init) => {
      const b = JSON.parse(init.body as string),
        mime = new TextDecoder().decode(decodeBase64url(b.raw));
      expect(mime).toContain("In-Reply-To: <rfc-fixture@example.com>");
      expect(mime).toContain(
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      );
      expect(mime).toContain("Content-Transfer-Encoding: base64");
      expect(b.threadId).toBe("thread-1");
      return Response.json({ id: "gmail-sent", threadId: "thread-1" });
    });
    const r = await sendGmail(
      env,
      org,
      p,
      a,
      "资料",
      "你好 %signature%",
      "gmail-send-fixture",
    );
    expect(r.body).toContain("Best, Sender");
    expect(r.externalId).toBe("gmail-sent");
  });
  it("parses nested HTML/alternative MIME without executing markup", () => {
    const m = mail("mime");
    m.payload = {
      headers: m.payload.headers,
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: base64url("<p>Hello</p><script>alert(1)</script>") },
        },
      ],
    } as any;
    expect(parseGmailMessage(m).body).toContain("Hello");
    expect(parseGmailMessage(m).email).toBe("synthetic@example.com");
  });
});
describe("R2 recording protocol, bearer scoping and call campaigns", () => {
  let cid = "",
    call = "",
    bearer = "",
    upload: Row;
  async function recorder(path: string, b?: Row, auth = bearer) {
    return req(
      `/call-recorder/calls/${call}${path}`,
      b ? "POST" : "GET",
      b,
      "",
      { Authorization: "Bearer " + auth },
    );
  }
  it("imports phone-only contacts without merging unrelated people", async () => {
    cid = (
      await data("/calling/campaigns", "POST", { name: "Synthetic calls" })
    ).id;
    const r = await data(`/calling/campaigns/${cid}/import`, "POST", {
      rows: [
        { name: "One", phone: "+12025550101" },
        { name: "Two", phone: "+12025550102" },
      ],
    });
    expect(r.added).toBe(2);
    await data(`/calling/campaigns/${cid}/contacts`, "POST", {
      people: [person],
    });
    const c = (await data(`/calling/campaigns/${cid}`)).contacts.find(
      (r: Row) => r.person_id === person,
    );
    const started = await data("/calls", "POST", {
      personId: person,
      campaignContactId: c.id,
    });
    call = started.call.id;
    bearer = started.recorderToken;
    expect(
      (await record(env, org, "calls", call)).recorder_token_hash,
    ).not.toBe(bearer);
  });
  it("requires the scoped recorder token, disallows 200 MB overflow and creates multipart capability", async () => {
    expect((await recorder("", undefined, "wrong")).status).toBe(403);
    expect(
      (
        await recorder("/upload-url", {
          bytes: 201 * 1024 * 1024,
          contentType: "audio/webm",
        })
      ).status,
    ).toBe(400);
    expect((await recorder("/started", { startedAt: now() })).status).toBe(200);
    const r = await recorder("/upload-url", {
      bytes: 4,
      contentType: "audio/webm",
    });
    expect(r.status).toBe(200);
    upload = (await r.json()) as Row;
    expect(upload.multipart.partSize).toBe(8 * 1024 * 1024);
  });
  it("uploads to private R2, verifies the completed size and finalizes idempotently", async () => {
    const part = await app.request(
      upload.uploadUrl + "&part=1",
      {
        method: "PUT",
        headers: { "Content-Type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
      env,
    );
    expect(part.status).toBe(200);
    const result = await part.json();
    const complete = await app.request(
      upload.multipart.completeUrl,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [result] }),
      },
      env,
    );
    expect(complete.status).toBe(200);
    const finished = {
      outcome: "recorded",
      recordingKey: upload.recordingKey,
      bytes: 4,
      contentType: "audio/webm",
      durationMs: 1000,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      endedAt: now(),
    };
    expect((await recorder("/finish", finished)).status).toBe(200);
    expect((await recorder("/finish", finished)).status).toBe(200);
    expect((await data(`/calls/${call}`)).hasRecording).toBe(true);
    expect(
      (await sql(
        "SELECT COUNT(*) n FROM jobs WHERE kind='call-transcribe' AND json_extract(payload,'$.call_id')=?",
        call,
      ).first<Row>())!.n,
    ).toBe(1);
  });
  it("authorizes recordings with a short-lived URL and supports byte ranges", async () => {
    expect(
      (await req(`/recordings/${call}`, "GET", undefined, "")).status,
    ).toBe(403);
    const r = await req(`/calls/${call}/recording`);
    expect(r.status).toBe(302);
    const response = await app.request(
      origin + r.headers.get("location")!,
      { headers: { Range: "bytes=1-2" } },
      env,
    );
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([2, 3]),
    );
  });
  it("transcribes a stored R2 object and accurately marks unknown speaker attribution", async () => {
    const j = await sql(
      "SELECT id FROM jobs WHERE kind='call-transcribe' AND json_extract(payload,'$.call_id')=?",
      call,
    ).first<Row>();
    await processJob(env, j!.id);
    const r = await data(`/calls/${call}`);
    expect(r.transcriptStatus).toBe("done");
    expect(r.transcript.utterances[0].speaker).toBe("unknown");
  });
  it("keeps outcome retry stages and stops Do Not Call leads", async () => {
    const c = (await data(`/calling/campaigns/${cid}`)).contacts.find(
      (r: Row) => r.person_id === person,
    );
    await data(`/calling/contacts/${c.id}`, "PATCH", {
      callStatus: "no_answer",
      notes: "No answer",
    });
    const r = await data(`/calling/contacts/${c.id}`);
    expect(r.stage).toBe("to_call");
    expect(r.unanswered_attempts).toBe(1);
    expect(Date.parse(r.follow_up_at)).toBeGreaterThan(
      Date.now() + 23 * 3600000,
    );
    await data(`/calls/${call}`, "PATCH", { disposition: "do_not_call" });
    expect((await req("/calls", "POST", { personId: person })).status).toBe(
      400,
    );
  });
  it("denies expired recorder sessions even with a correct bearer", async () => {
    await sql(
      "UPDATE calls SET token_expires_at=? WHERE id=?",
      new Date(Date.now() - 1000).toISOString(),
      call,
    ).run();
    expect((await recorder("")).status).toBe(403);
  });
});
describe("organizations, teams and identity recovery", () => {
  it("prevents owner removal and foreign team membership", async () => {
    expect(
      (await req(`/members/${owner}`, "PATCH", { role: "member" })).status,
    ).toBe(400);
    const team = await data("/teams", "POST", { name: "Team" });
    await data(`/teams/${team.id}`, "PATCH", { members: [owner] });
    expect((await data("/teams")).items[0].members[0].id).toBe(owner);
    expect(
      (await req(`/teams/${team.id}`, "PATCH", { members: ["foreign-user"] }))
        .status,
    ).toBe(400);
  });
  it("switches organizations with a new scoped session", async () => {
    const o = await data("/organizations", "POST", {
      name: "Second workspace",
      slug: "second",
    });
    const r = await req(`/organizations/${o.id}/switch`, "POST", {}),
      newCookie = r.headers.get("set-cookie")!.split(";")[0];
    expect(r.status).toBe(200);
    const status = (await (
      await req("/auth/status", "GET", undefined, newCookie)
    ).json()) as Row;
    expect(status.user.org_id).toBe(o.id);
    expect(
      (
        (await (
          await req("/people", "GET", undefined, newCookie)
        ).json()) as Row
      ).items,
    ).toHaveLength(0);
    const back = await req(
      `/organizations/${org}/switch`,
      "POST",
      {},
      newCookie,
    );
    cookie = back.headers.get("set-cookie")!.split(";")[0];
  });
  it("supports authenticated email verification and rejects a reused token", async () => {
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'resend',?)",
      org,
      await encrypt(
        { api_key: "fixture", from_address: "auth@fixture.example" },
        env.ENCRYPTION_KEY,
      ),
    ).run();
    let verifyToken = "";
    fetchMock((_u, init) => {
      verifyToken = String(JSON.parse(init.body as string).text).split(
        "token=",
      )[1];
      return Response.json({ id: "email-fixture" });
    });
    expect((await req("/auth/send-verification", "POST", {})).status).toBe(200);
    expect(verifyToken).not.toBe("");
    expect(
      (
        await req(
          "/auth/verify-email?token=" + verifyToken,
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await req(
          "/auth/verify-email?token=" + verifyToken,
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(400);
  });
  it("uses one-time reset tokens, revokes sessions and gives generic unknown-email responses", async () => {
    let resetToken = "";
    fetchMock((_u, init) => {
      resetToken = JSON.parse(init.body as string).text.split("#token=")[1];
      return Response.json({ id: "reset-email" });
    });
    const known = await data("/auth/forgot-password", "POST", {
        email: "owner@parity.example",
      }),
      unknown = await data("/auth/forgot-password", "POST", {
        email: "unknown@parity.example",
      });
    expect(known).toEqual(unknown);
    const b = { token: resetToken, password: "new-password-long-enough" };
    expect((await req("/auth/reset-password", "POST", b, "")).status).toBe(200);
    expect((await req("/auth/reset-password", "POST", b, "")).status).toBe(400);
    expect((await req("/people")).status).toBe(401);
    const login = await req(
      "/auth/login",
      "POST",
      { email: "owner@parity.example", password: b.password },
      "",
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });
  it("starts Google OAuth with PKCE and refuses mismatched state", async () => {
    await data("/integrations/google-signin", "POST", {
      client_id: "test-client",
      client_secret: "fixture",
    });
    const r = await req("/auth/google", "GET", undefined, "");
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location")!);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
      (
        await req(
          "/auth/callback/google?state=wrong&code=test",
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(400);
  });
  it("keeps unauthenticated new feature APIs private and returns nav counts", async () => {
    for (const path of [
      "/crm/categories",
      "/calls",
      "/accounts",
      "/provider-connections",
      "/organizations",
      "/tasks",
      "/prospecting",
      "/http-secrets",
    ])
      expect((await req(path, "GET", undefined, "")).status).toBe(401);
    expect((await data("/nav/badges")).inbox).toBeGreaterThan(0);
  });
});
describe("migration closeout regressions", () => {
  it("holds low-confidence classification and customer changes for human adoption", async () => {
    const p = (
      await data("/people", "POST", {
        name: "Policy subject",
        email: "policy@example.com",
      })
    ).id;
    const cid = await setCategory(
      env,
      org,
      p,
      "customer",
      null,
      "ai",
      "Possible customer",
      0.99,
    );
    expect((await record(env, org, "people", p)).category).toBeNull();
    expect((await record(env, org, "classifications", cid)).decision).toBe(
      "requires_review",
    );
    await data(`/crm/classifications/${cid}/apply`, "POST", {});
    expect((await record(env, org, "people", p)).stage).toBe("customer");
    const low = await setCategory(
      env,
      org,
      p,
      "other",
      null,
      "ai",
      "Uncertain",
      0.1,
    );
    expect((await record(env, org, "classifications", low)).decision).toBe(
      "protected_customer",
    );
  });
  it("validates and persists structured operator instructions", async () => {
    await data("/crm/settings/ai-instructions", "PUT", {
      draftInstructions: [{ id: "tone", title: "Tone", content: "Be concise" }],
      classificationInstructions: [],
    });
    expect(
      (await data("/crm/settings/ai-instructions")).draftInstructions[0].title,
    ).toBe("Tone");
    expect(
      (
        await req("/crm/settings/ai-instructions", "PUT", {
          draftInstructions: [{ title: "Too long", content: "x".repeat(8001) }],
        })
      ).status,
    ).toBe(400);
  });
  it("requires previewed incompatible counts before converting custom field values", async () => {
    const field = (await data("/lead-fields")).items.find(
      (f: Row) => f.key === "budget",
    );
    expect(
      (await req(`/lead-fields/${field.id}`, "PATCH", { type: "number" }))
        .status,
    ).toBe(400);
    await data(`/lead-fields/${field.id}`, "PATCH", {
      type: "number",
      acknowledge_incompatible: 1,
    });
    expect(
      JSON.parse((await record(env, org, "people", person)).custom).budget,
    ).toBeNull();
  });
  it("keeps company and person custom field registries independent", async () => {
    await data("/lead-fields", "POST", {
      key: "budget",
      name: "Company budget",
      type: "currency",
      entity: "company",
    });
    expect(
      (await data("/lead-fields?entity=company")).items.find(
        (f: Row) => f.key === "budget",
      ).entity,
    ).toBe("company");
  });
  it("loads a private domain catalog with actual filters and category counts", async () => {
    await data("/domains/import", "POST", {
      rows: [
        {
          domain: "shop.example",
          countryCode: "US",
          c1: "Retail",
          platform: "Shopify",
          revenue: 1000,
          apps: ["Klaviyo"],
        },
        {
          domain: "other.example",
          countryCode: "CN",
          c1: "Software",
          platform: "Custom",
          revenue: 100,
        },
      ],
    });
    const filtered = await data(
      "/domains?countryCode=US&platform=Shopify&app=Klaviyo&minRevenue=500",
    );
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].domain).toBe("shop.example");
    expect(
      (await data("/domains/categories?level=c1&countryCode=US")).items[0].name,
    ).toBe("Retail");
    expect((await data("/domains/apps")).items[0].name).toBe("Klaviyo");
  });
  it("qualifies companies using measured Apollo counts and emits the search URL", async () => {
    await sql(
      "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'apollo',?)",
      org,
      await encrypt({ api_key: "apollo-fixture" }, env.ENCRYPTION_KEY),
    ).run();
    fetchMock((url) =>
      url.includes("api.apollo.io")
        ? Response.json({
            total_entries: url.includes("contact_email_status") ? 12 : 20,
          })
        : new Response(
            "<html><title>Company</title><p>Software for teams.</p></html>",
          ),
    );
    const c = await data("/prospecting", "POST", {
      name: "Qualified batch",
      domains: ["shop.example"],
      mode: "qualification",
      minVerifiedEmployees: 10,
      jobTitles: ["Founder"],
    });
    await data(`/prospecting/${c.id}/run`, "POST", {});
    const p = (await data(`/prospecting/${c.id}`)).items[0],
      j = await sql(
        "SELECT id FROM jobs WHERE kind='prospect' AND json_extract(payload,'$.prospect_id')=?",
        p.id,
      ).first<Row>();
    await processJob(env, j!.id);
    const result = JSON.parse(
      (await data(`/prospecting/${c.id}`)).items[0].result,
    );
    expect(result.verifiedEmployeeCount).toBe(12);
    expect(result.qualified).toBe(true);
    expect((await data(`/prospecting/${c.id}/apollo-link`)).url).toContain(
      "shop.example",
    );
  });
  it("creates a draft campaign from selected table rows with mapped merge fields", async () => {
    const t = await data("/tables", "POST", { name: "Source" });
    await data(`/tables/${t.id}/rows`, "POST", {
      rows: [
        {
          person_name: "Mapped Person",
          work_email: "mapped@example.com",
          opening: "Custom greeting",
        },
      ],
    });
    const rows = (await data(`/tables/${t.id}`)).rows,
      c = await data(`/tables/${t.id}/campaigns`, "POST", {
        name: "From grid",
        channel: "email",
        row_ids: rows.map((r: Row) => r.id),
        mapping: { name: "person_name", email: "work_email" },
        steps: [{ body: "{{opening}}", subject: "Hello" }],
      });
    expect(c.enrolled).toBe(1);
    const p = (await data("/people?q=mapped")).items[0];
    expect(JSON.parse(p.custom).opening).toBe("Custom greeting");
    expect(
      (await data(`/campaigns/${c.id}/preview`, "POST", { person_id: p.id }))
        .steps[0].body,
    ).toBe("Custom greeting");
  });
  it("never dispatches with an explicit account owned by another workspace", async () => {
    const p = await record(env, org, "people", person);
    await expect(
      selectAccount(
        env,
        org,
        { channel: "linkedin", account_id: "foreign-account" },
        null,
        p,
        "message",
      ),
    ).rejects.toThrow(/workspace/);
  });
  it("schedules async enrichment polls through delayed Queues and does not rerun completed columns", async () => {
    const t = await data("/tables", "POST", { name: "Async verifier" }),
      connection = (await data("/provider-connections")).items.find(
        (c: Row) => c.provider === "hunter",
      );
    await data(`/tables/${t.id}`, "PATCH", {
      columns: [
        { key: "email", name: "Email", type: "email" },
        {
          key: "check",
          name: "Verify",
          type: "enrichment",
          config: {
            integrationKey: "hunter",
            actionKey: "verify-email",
            connectionId: connection.id,
            inputs: { email: { source: "column", columnKey: "email" } },
          },
        },
      ],
    });
    await data(`/tables/${t.id}/rows`, "POST", {
      rows: [{ email: "async@example.com" }],
    });
    const rid = (await data(`/tables/${t.id}`)).rows[0].id,
      jid = await enqueue(env, org, "table-row", {
        table_id: t.id,
        row_id: rid,
      }),
      send = vi.fn(async (_body: unknown, _options?: Row) => {}),
      testEnv = { ...env, TASKS: { send } } as unknown as Env;
    fetchMock(() => new Response("{}", { status: 202 }));
    await processJob(testEnv, jid);
    expect(send).toHaveBeenCalledWith(
      { id: jid },
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    );
    expect(send.mock.calls[0][1]!.delaySeconds).toBeGreaterThan(0);
    expect((await record(env, org, "jobs", jid)).status).toBe("queued");
    await sql(
      "UPDATE jobs SET available_at=? WHERE id=?",
      new Date(Date.now() - 1000).toISOString(),
      jid,
    ).run();
    fetchMock(() =>
      Response.json({
        data: { email: "async@example.com", status: "valid", score: 99 },
      }),
    );
    await processJob(testEnv, jid);
    expect((await data(`/tables/${t.id}`)).rows[0].cell_meta.check.status).toBe(
      "success",
    );
    expect((await data(`/tables/${t.id}/runs`)).items).toHaveLength(1);
  });
  it("cancels queued table jobs and keeps a concurrent user edit from being overwritten", async () => {
    const t = await data("/tables", "POST", { name: "Cancel" });
    await data(`/tables/${t.id}`, "PATCH", {
      columns: [
        { key: "input", name: "Input", type: "text" },
        {
          key: "out",
          name: "Output",
          type: "formula",
          config: { expression: "{{input}}" },
        },
      ],
    });
    await data(`/tables/${t.id}/rows`, "POST", { rows: [{ input: "before" }] });
    await data(`/tables/${t.id}/run`, "POST", {});
    await data(`/tables/${t.id}/stop`, "POST", {});
    const j = await sql(
      "SELECT id FROM jobs WHERE kind='table-row' AND json_extract(payload,'$.table_id')=?",
      t.id,
    ).first<Row>();
    await processJob(env, j!.id);
    expect((await record(env, org, "jobs", j!.id)).status).toBe("done");
    expect((await data(`/tables/${t.id}`)).rows[0].cells.out).toBeUndefined();
  });
  it("supports profile photos as authenticated multipart uploads", async () => {
    const c = (await data("/calling/campaigns")).items[0],
      contact = (await data(`/calling/campaigns/${c.id}`)).contacts[0];
    const body = new FormData();
    body.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    );
    const r = await app.request(
      origin + `/api/calling/contacts/${contact.id}/photo`,
      { method: "POST", headers: { Origin: origin, Cookie: cookie }, body },
      env,
    );
    expect(r.status).toBe(200);
    const b = (await r.json()) as Row;
    expect(
      (await app.request(origin + b.url, { headers: { Cookie: cookie } }, env))
        .status,
    ).toBe(200);
    expect((await app.request(origin + b.url, {}, env)).status).toBe(401);
  });
  it("merges imported identities without clearing Do Not Contact", async () => {
    await data("/people/import", "POST", {
      mode: "merge",
      rows: [
        {
          name: "Updated synthetic",
          email: "synthetic@example.com",
          dnc: false,
          title: "Founder",
        },
      ],
    });
    const p = await record(env, org, "people", person);
    expect(p.dnc).toBe(1);
    expect(p.title).toBe("Founder");
  });
  it("keeps the packaged recorder native origin and R2 multipart protocol enabled", async () => {
    const source = await readFile(
      new URL(
        "../../extensions/whatsapp-recorder/src/origins.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain('"https://sdr.genedai.me"');
    const upload = await readFile(
      new URL(
        "../../extensions/whatsapp-recorder/src/upload.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(upload).toContain("multipart");
  });
});
describe("OpenRouter BYOK parity", () => {
  let connection = "",
    table = "";
  function mockByok() {
    return fetchMock((url, init) => {
      if (url.endsWith("/key"))
        return Response.json({ data: { is_management_key: false } });
      if (url.includes("/byok?"))
        return Response.json({
          data: [
            {
              id: "credential",
              provider: "fixture",
              name: "Fixture",
              disabled: false,
              is_fallback: false,
              allowed_models: null,
              allowed_api_key_hashes: null,
            },
          ],
          total_count: 1,
        });
      if (url.endsWith("/providers"))
        return Response.json({ data: [{ slug: "fixture", name: "Fixture" }] });
      if (url.includes("/models?"))
        return Response.json({
          data: [
            {
              id: "fixture/text",
              name: "Text",
              architecture: { output_modalities: ["text"] },
              supported_parameters: ["tools"],
            },
            {
              id: "fixture/image",
              name: "Image",
              architecture: { output_modalities: ["image"] },
            },
          ],
        });
      if (url.endsWith("/images")) {
        const body = JSON.parse(init.body as string);
        expect(body.provider.only).toEqual(["fixture"]);
        expect(body.provider.allow_fallbacks).toBe(false);
        expect(body.provider.require_parameters).toBeUndefined();
        return Response.json({
          data: [{ b64_json: "AQIDBA==", media_type: "image/png" }],
        });
      }
      const body = JSON.parse(init.body as string);
      expect(body.provider.only).toEqual(["fixture"]);
      expect(body.provider.allow_fallbacks).toBe(false);
      expect(body.tools[0].function.name).toBe("fill_row");
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { arguments: '{"answer":"Measured answer"}' } },
              ],
            },
          },
        ],
      });
    });
  }
  it("discovers prioritized BYOK credentials and validates model selections", async () => {
    mockByok();
    connection = (
      await data("/ai/connections", "POST", {
        name: "BYOK fixture",
        api_key: "inference-fixture",
        management_key: "management-fixture",
      })
    ).id;
    const catalog = await data("/ai/byok/catalog?connectionId=" + connection);
    expect(catalog.providers[0].models).toHaveLength(2);
    const settings = {
      connectionId: connection,
      providers: ["fixture"],
      modelsByProvider: { fixture: ["fixture/text", "fixture/image"] },
      defaultModel: { provider: "fixture", modelId: "fixture/text" },
      byokOnlyConfirmed: false,
    };
    expect((await req("/ai/byok/settings", "PUT", settings)).status).toBe(400);
    await data("/ai/byok/settings", "PUT", {
      ...settings,
      byokOnlyConfirmed: true,
    });
    expect(JSON.stringify(await data("/ai/connections"))).not.toContain(
      "inference-fixture",
    );
  });
  it("uses a pinned tool schema and persists structured AI outputs", async () => {
    mockByok();
    table = (await data("/tables", "POST", { name: "BYOK native" })).id;
    await data(`/tables/${table}`, "PATCH", {
      columns: [
        { key: "input", name: "Input", type: "text" },
        {
          key: "response",
          name: "AI",
          type: "ai",
          config: {
            model: "fixture/text",
            upstreamProvider: "fixture",
            prompt: "Research {{input}}",
            outputs: [{ key: "answer", name: "Answer", type: "text" }],
          },
        },
      ],
    });
    await data(`/tables/${table}/rows`, "POST", {
      rows: [{ input: "Synthetic" }],
    });
    const row = (await data(`/tables/${table}`)).rows[0],
      j = await enqueue(env, org, "table-row", {
        table_id: table,
        row_id: row.id,
      });
    await processJob(env, j);
    expect((await data(`/tables/${table}`)).rows[0].cells.answer).toBe(
      "Measured answer",
    );
  });
  it("stores generated images in authenticated private R2 files", async () => {
    mockByok();
    await data(`/tables/${table}`, "PATCH", {
      columns: [
        { key: "input", name: "Input", type: "text" },
        {
          key: "picture",
          name: "Picture",
          type: "ai",
          config: {
            model: "fixture/image",
            upstreamProvider: "fixture",
            useCase: "generate-image",
            prompt: "Generate {{input}}",
          },
        },
      ],
    });
    const row = (await data(`/tables/${table}`)).rows[0],
      j = await enqueue(env, org, "table-row", {
        table_id: table,
        row_id: row.id,
        force: true,
      });
    await processJob(env, j);
    const image = (await data(`/tables/${table}`)).rows[0].cells.picture;
    expect(image).toMatch(/^\/api\/files\//);
    expect((await req(image.replace(/^\/api/, ""))).status).toBe(200);
    expect(
      (await req(image.replace(/^\/api/, ""), "GET", undefined, "")).status,
    ).toBe(401);
  });
});
