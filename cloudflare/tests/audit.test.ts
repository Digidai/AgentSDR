import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { app } from "../src/api";
import { enqueue, processJob } from "../src/jobs";
import { id, encrypt, digest, now } from "../src/core";
import { receive } from "../src/inbound";
import {
  attachSequence,
  createSequenceDraft,
  advanceCrmDraft,
  setCategory,
} from "../src/features/crm";
import { lookupRegistry } from "../src/features/formula";
import { syncGmail, base64url } from "../src/features/google";
import { normalizeRows } from "../web/lib";
import type { Env, Row, Column } from "../src/types";

let mf: Miniflare, env: Env, cookie: string, org: string, owner: string;
const origin = "https://audit.test";
const sql = (s: string, ...args: any[]) => env.DB.prepare(s).bind(...args);
async function req(path: string, method = "GET", body?: unknown) {
  return app.request(
    origin + "/api" + path,
    {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie || "",
        "Content-Type": "application/json",
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
async function lead() {
  return (
    await data("/people", "POST", {
      name: "Audit fixture",
      email: `${id()}@example.invalid`,
      phone: "+12025550100",
    })
  ).id as string;
}
async function sequence() {
  const pid = await lead(),
    sid = (
      await data("/crm/sequences", "POST", {
        name: "Audit follow-up",
        steps: [
          { channel: "email", body: "Fixture one" },
          { channel: "email", body: "Fixture two", delay_minutes: 60 },
        ],
      })
    ).id;
  await data(`/crm/sequences/${sid}/publish`, "POST", {});
  await attachSequence(env, org, pid, sid);
  const e = await sql(
    "SELECT * FROM crm_enrollments WHERE org_id=? AND person_id=? AND status='active'",
    org,
    pid,
  ).first<Row>();
  await createSequenceDraft(env, org, e!.id);
  const fresh = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    e!.id,
  ).first<Row>();
  return { pid, sid, eid: e!.id, did: fresh!.draft_id as string };
}
async function table(columns: Column[], cells: Row = { input: 2 }) {
  const tid = (await data("/tables", "POST", { name: "Audit grid" })).id;
  await data(`/tables/${tid}`, "PATCH", { columns });
  await data(`/tables/${tid}/rows`, "POST", { rows: [cells] });
  return { tid, rid: (await data(`/tables/${tid}`)).rows[0].id as string };
}
async function run(tid: string, rid: string, extra: Row = {}) {
  const jid = await enqueue(env, org, "table-row", {
    table_id: tid,
    row_id: rid,
    ...extra,
  });
  await processJob(env, jid);
  return (await data(`/tables/${tid}`)).rows.find((r: Row) => r.id === rid);
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("fixture")}}',
      compatibilityDate: "2026-10-17",
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA"],
    }),
  );
  env = {
    ...(await mf.getBindings()),
    APP_URL: origin,
    ENCRYPTION_KEY: "audit-key",
    UNSUBSCRIBE_SECRET: "audit-unsub",
    BOOTSTRAP_TOKEN: "audit-setup",
    TASKS: { send: vi.fn(async () => {}) },
    AI_MODEL: "fixture",
    AI: { run: vi.fn(async () => ({ response: '{"total":7}' })) },
  } as unknown as Env;
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await env.DB.exec(await readFile(new URL(name, dir), "utf8"));
  const r = await req("/auth/setup", "POST", {
    token: "audit-setup",
    email: "owner@audit.invalid",
    name: "Owner",
    organization: "Audit",
    password: "correct-horse-battery-staple",
  });
  expect(r.status).toBe(201);
  cookie = r.headers.get("set-cookie")!.split(";")[0];
  const status = await data("/auth/status");
  org = status.user.org_id;
  owner = status.user.id;
  await sql(
    "UPDATE organizations SET timezone='UTC',start_hour=0,end_hour=24,daily_limit=1000 WHERE id=?",
    org,
  ).run();
  await sql(
    "INSERT INTO integrations(org_id,kind,encrypted) VALUES(?,'resend',?)",
    org,
    await encrypt(
      { api_key: "fixture", from_address: "audit@example.invalid" },
      env.ENCRYPTION_KEY,
    ),
  ).run();
}, 30000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await mf?.dispose();
});

it("cancels queued follow-ups on fresh replies, including paused sequences", async () => {
  for (const state of ["active", "paused"]) {
    const s = await sequence();
    await sql(
      "UPDATE crm_enrollments SET status=? WHERE id=?",
      state,
      s.eid,
    ).run();
    await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
    const transport = vi.fn(async () => Response.json({ id: "must-not-send" }));
    vi.stubGlobal("fetch", transport);
    await receive(env, org, "email", {
      external_id: id(),
      person_id: s.pid,
      body: "I already replied",
      crmEligible: false,
    });
    await processJob(
      env,
      await enqueue(env, org, "send", { person_id: s.pid, draft_id: s.did }),
    );
    expect(
      (await sql("SELECT status FROM drafts WHERE id=?", s.did).first<Row>())!
        .status,
    ).toBe("discarded");
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await sql(
        "SELECT status FROM crm_enrollments WHERE id=?",
        s.eid,
      ).first<Row>())!.status,
    ).toBe("stopped");
  }
});
it("manual inbound logging has the same CRM cancellation and context semantics", async () => {
  const s = await sequence();
  await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
  await data("/messages", "POST", {
    person_id: s.pid,
    channel: "email",
    body: "A manually logged reply",
  });
  expect(
    (await sql(
      "SELECT crm_context FROM people WHERE id=?",
      s.pid,
    ).first<Row>())!.crm_context,
  ).toBe(1);
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", s.did).first<Row>())!
      .status,
  ).toBe("discarded");
});
it("rejects self-referential formula cycles as a client error", async () => {
  const tid = (await data("/tables", "POST", { name: "Cycle" })).id;
  const r = await req(`/tables/${tid}`, "PATCH", {
    columns: [
      {
        key: "loop",
        name: "Loop",
        type: "formula",
        config: { expression: "{{loop}} + 1" },
      },
    ],
  });
  expect(r.status).toBe(400);
});
it("runs generated output dependencies before formulas even when visually reordered", async () => {
  const t = await table([
    {
      key: "double",
      name: "Double",
      type: "formula",
      config: { expression: "{{total}} * 2" },
    },
    {
      key: "ai",
      name: "AI",
      type: "ai",
      config: {
        prompt: "Fixture",
        outputs: [{ key: "total", type: "number" }],
      },
    },
  ]);
  expect((await run(t.tid, t.rid)).cells.double).toBe(14);
});
it("runs transitive dependencies when only a dependent column is selected", async () => {
  const t = await table([
    { key: "input", name: "Input", type: "number" },
    {
      key: "first",
      name: "First",
      type: "formula",
      config: { expression: "{{input}} + 1" },
    },
    {
      key: "last",
      name: "Last",
      type: "formula",
      config: { expression: "{{first}} * 2" },
    },
  ]);
  expect((await run(t.tid, t.rid, { column_keys: ["last"] })).cells.last).toBe(
    6,
  );
});
it("invalidates cached results after changing the formula configuration", async () => {
  const columns: Column[] = [
    { key: "input", name: "Input", type: "number" },
    {
      key: "out",
      name: "Out",
      type: "formula",
      config: { expression: "{{input}} + 1" },
    },
  ];
  const t = await table(columns);
  expect((await run(t.tid, t.rid)).cells.out).toBe(3);
  columns[1].config!.expression = "{{input}} + 10";
  await data(`/tables/${t.tid}`, "PATCH", { columns });
  expect((await run(t.tid, t.rid)).cells.out).toBe(12);
});
it("stopping queued table work makes the row runnable again", async () => {
  const t = await table([
    { key: "out", name: "Out", type: "formula", config: { expression: "42" } },
  ]);
  expect((await data(`/tables/${t.tid}/run`, "POST", {})).queued).toBe(1);
  await data(`/tables/${t.tid}/stop`, "POST", {});
  expect((await data(`/tables/${t.tid}/run`, "POST", {})).queued).toBe(1);
});
it("Do Not Call from the contact list blocks all future call creation and follow-ups", async () => {
  const s = await sequence(),
    cid = (await data("/calling/campaigns", "POST", { name: "Audit calls" }))
      .id;
  await data(`/calling/campaigns/${cid}/contacts`, "POST", { people: [s.pid] });
  const ct = await sql(
    "SELECT id FROM call_contacts WHERE campaign_id=? AND person_id=?",
    cid,
    s.pid,
  ).first<Row>();
  await data(`/calling/contacts/${ct!.id}`, "PATCH", {
    callStatus: "do_not_call",
  });
  expect(
    (await sql("SELECT dnc FROM people WHERE id=?", s.pid).first<Row>())!.dnc,
  ).toBe(1);
  expect((await req("/calls", "POST", { personId: s.pid })).status).toBe(400);
});
it("retains at least one owner under concurrent demotion requests", async () => {
  const uid = id();
  await env.DB.batch([
    sql(
      "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,'Second owner','unused')",
      uid,
      `${uid}@audit.invalid`,
    ),
    sql(
      "INSERT INTO members(org_id,user_id,role) VALUES(?,?,'owner')",
      org,
      uid,
    ),
  ]);
  try {
    await Promise.all([
      req(`/members/${owner}`, "PATCH", { role: "admin" }),
      req(`/members/${uid}`, "PATCH", { role: "admin" }),
    ]);
    expect(
      (await sql(
        "SELECT COUNT(*) n FROM members WHERE org_id=? AND role='owner'",
        org,
      ).first<Row>())!.n,
    ).toBe(1);
  } finally {
    await sql(
      "UPDATE members SET role='owner' WHERE org_id=? AND user_id=?",
      org,
      owner,
    ).run();
  }
});
it("advances the same CRM draft at most once under concurrent receipts", async () => {
  const s = await sequence();
  await Promise.all([
    advanceCrmDraft(env, org, s.did),
    advanceCrmDraft(env, org, s.did),
  ]);
  expect(
    (await sql(
      "SELECT step FROM crm_enrollments WHERE id=?",
      s.eid,
    ).first<Row>())!.step,
  ).toBe(1);
});
it("keeps incoming messages and receipts atomic if the transaction fails", async () => {
  const pid = await lead(),
    external = id();
  const failedEnv = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("Injected D1 interruption");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  await expect(
    receive(failedEnv, org, "email", {
      person_id: pid,
      external_id: external,
      body: "Retry this message",
    }),
  ).rejects.toThrow("Injected");
  expect(
    await sql(
      "SELECT 1 FROM webhook_receipts WHERE org_id=? AND external_id=?",
      org,
      `email:${external}`,
    ).first(),
  ).toBeNull();
  await receive(env, org, "email", {
    person_id: pid,
    external_id: external,
    body: "Retry this message",
  });
  await Promise.all(
    Array.from({ length: 3 }, () =>
      receive(env, org, "email", {
        person_id: pid,
        external_id: external,
        body: "Duplicate",
      }),
    ),
  );
  expect(
    (await sql("SELECT crm_context FROM people WHERE id=?", pid).first<Row>())!
      .crm_context,
  ).toBe(1);
  expect(
    (await sql(
      "SELECT COUNT(*) n FROM jobs WHERE kind='crm' AND json_extract(payload,'$.person_id')=?",
      pid,
    ).first<Row>())!.n,
  ).toBe(1);
});
it("cancels an in-flight HTTP grid result without overwriting the row or restarting work", async () => {
  const t = await table([
    {
      key: "http",
      name: "HTTP",
      type: "http",
      config: { url: "https://example.com/fixture" },
    },
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await data(`/tables/${t.tid}/stop`, "POST", {});
      return Response.json({ value: "obsolete" });
    }),
  );
  const row = await run(t.tid, t.rid);
  expect(row.cells.http).toBeUndefined();
  expect(row.status).toBe("ready");
  const runs = await data(`/tables/${t.tid}/runs`);
  expect(runs.items[0].status).toBe("cancelled");
});
it("supports the full 150-column configuration within D1 SQL limits", async () => {
  const columns: Column[] = Array.from({ length: 150 }, (_, i) => ({
    key: `c${i}`,
    name: `Column ${i}`,
    type: "formula",
    config: { expression: String(i) },
  }));
  const t = await table(columns);
  expect((await data(`/tables/${t.tid}`)).columns).toHaveLength(150);
  columns.forEach((c) => {
    c.config!.expression = "99";
  });
  await data(`/tables/${t.tid}`, "PATCH", { columns });
});
it("fails closed on oversized LOOKUP sources before loading their full contents", async () => {
  const t = await table([{ key: "input", name: "Input", type: "text" }], {
    input: "x".repeat(220000),
  });
  await data(`/tables/${t.tid}/rows`, "POST", {
    rows: Array.from({ length: 5 }, () => ({ input: "x".repeat(220000) })),
  });
  await expect(
    lookupRegistry(env, org, `LOOKUP("${t.tid}","x","input","input")`),
  ).rejects.toThrow(/budget/);
});
it("normalizes common phoneNumber CSV headers without losing the phone field", () => {
  expect(
    normalizeRows([{ Name: "Fixture", phoneNumber: "+12025550100" }])[0].phone,
  ).toBe("+12025550100");
});
it("does not revive a stopped campaign when a previously uncertain send is confirmed", async () => {
  const pid = await lead(),
    cid = (
      await data("/campaigns", "POST", {
        name: "Reconcile",
        channel: "email",
        steps: [{ body: "first" }, { body: "second" }],
      })
    ).id;
  await data(`/campaigns/${cid}/enroll`, "POST", { people: [pid] });
  const e = await sql(
      "SELECT * FROM enrollments WHERE campaign_id=? AND person_id=?",
      cid,
      pid,
    ).first<Row>(),
    jid = id(),
    aid = id();
  await env.DB.batch([
    sql("UPDATE enrollments SET status='replied' WHERE id=?", e!.id),
    sql(
      "INSERT INTO jobs(id,org_id,kind,status,payload) VALUES(?,?,'send','uncertain',?)",
      jid,
      org,
      JSON.stringify({ person_id: pid, enrollment_id: e!.id, step: 0 }),
    ),
    sql(
      "INSERT INTO send_attempts(id,org_id,job_id,person_id,status) VALUES(?,?,?,?,'uncertain')",
      aid,
      org,
      jid,
      pid,
    ),
  ]);
  await data(`/send-attempts/${aid}/reconcile`, "POST", {
    outcome: "sent",
    external_id: `verified:${id()}`,
  });
  expect(
    (await sql(
      "SELECT status FROM enrollments WHERE id=?",
      e!.id,
    ).first<Row>())!.status,
  ).toBe("replied");
});
it("finishing the same recorder call concurrently applies the retry counter once", async () => {
  const pid = await lead(),
    cid = (await data("/calling/campaigns", "POST", { name: "Finish race" }))
      .id;
  await data(`/calling/campaigns/${cid}/contacts`, "POST", { people: [pid] });
  const ct = await sql(
    "SELECT id FROM call_contacts WHERE campaign_id=?",
    cid,
  ).first<Row>();
  const call = await data("/calls", "POST", {
    personId: pid,
    campaignContactId: ct!.id,
  });
  const finish = () =>
    app.request(
      origin + `/api/call-recorder/calls/${call.call.id}/finish`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${call.recorderToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ outcome: "no_recording" }),
      },
      env,
    );
  await Promise.all([finish(), finish()]);
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      ct!.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(1);
});
it("serializes concurrent Gmail history syncs for the same mailbox", async () => {
  const aid = id(),
    keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...raw))}\n-----END PRIVATE KEY-----`;
  await env.DB.batch([
    sql(
      "INSERT OR REPLACE INTO integrations(org_id,kind,encrypted) VALUES(?,'google-workspace',?)",
      org,
      await encrypt(
        {
          client_email: "audit@fixture.iam.gserviceaccount.com",
          private_key: pem,
        },
        env.ENCRYPTION_KEY,
      ),
    ),
    sql(
      "INSERT INTO channel_accounts(id,org_id,channel,address,history_id,settings) VALUES(?,?,'email',?,'100',?)",
      aid,
      org,
      `${aid}@example.invalid`,
      JSON.stringify({ provider: "gmail" }),
    ),
  ]);
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      unblock = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const transport = vi.fn(async (u: any) => {
    if (String(u).includes("oauth2.googleapis.com"))
      return Response.json({ access_token: "fixture", expires_in: 3600 });
    entered();
    await gate;
    return Response.json({ history: [], historyId: "200" });
  });
  vi.stubGlobal("fetch", transport);
  const first = syncGmail(env, org, aid);
  await started;
  const second = syncGmail(env, org, aid).then(
    () => null,
    (error) => error,
  );
  try {
    const result = await Promise.race([
      second,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    expect(result?.message).toMatch(/sync|mailbox/i);
  } finally {
    unblock();
    await first;
    await second;
  }
  expect(
    transport.mock.calls.filter((c) => String(c[0]).includes("/history?")),
  ).toHaveLength(1);
  expect(
    (await sql(
      "SELECT history_id FROM channel_accounts WHERE id=?",
      aid,
    ).first<Row>())!.history_id,
  ).toBe("200");
});
it("does not apply a low-confidence AI stage change through the worker path", async () => {
  const pid = await lead();
  await receive(env, org, "email", {
    external_id: id(),
    person_id: pid,
    body: "Could you clarify?",
  });
  const job = await sql(
    "SELECT id FROM jobs WHERE kind='crm' AND json_extract(payload,'$.person_id')=?",
    pid,
  ).first<Row>();
  const testEnv = {
    ...env,
    AI: {
      run: async () => ({
        response: JSON.stringify({
          classification: "interested",
          confidence: 0.2,
          reason: "Uncertain",
          draft: "Please review",
          subject: "Fixture",
        }),
      }),
    },
  } as unknown as Env;
  await processJob(testEnv, job!.id);
  expect(
    (await sql("SELECT stage FROM people WHERE id=?", pid).first<Row>())!.stage,
  ).toBe("new");
  expect(
    (await sql(
      "SELECT applied_at FROM classifications WHERE person_id=?",
      pid,
    ).first<Row>())!.applied_at,
  ).toBeNull();
});
it("does not create an orphan follow-up if a reply arrives while AI is drafting", async () => {
  const pid = await lead(),
    sid = (
      await data("/crm/sequences", "POST", {
        name: "Draft race",
        steps: [
          {
            channel: "email",
            prompt: "Write a fixture follow-up",
            body: "Fixture",
          },
        ],
      })
    ).id;
  await data(`/crm/sequences/${sid}/publish`, "POST", {});
  await attachSequence(env, org, pid, sid);
  const e = await sql(
    "SELECT id FROM crm_enrollments WHERE person_id=? AND status='active'",
    pid,
  ).first<Row>();
  const testEnv = {
    ...env,
    AI: {
      run: async () => {
        await receive(env, org, "email", {
          external_id: id(),
          person_id: pid,
          body: "Reply during generation",
          crmEligible: false,
        });
        return { response: "Obsolete follow-up" };
      },
    },
  } as unknown as Env;
  await createSequenceDraft(testEnv, org, e!.id);
  expect(
    (await sql(
      "SELECT COUNT(*) n FROM drafts WHERE person_id=?",
      pid,
    ).first<Row>())!.n,
  ).toBe(0);
});
it("rechecks draft eligibility after quota I/O before reaching a provider", async () => {
  const s = await sequence();
  await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
  let changed = false;
  const testEnv = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.startsWith("UPDATE daily_usage SET count=count+1"))
              return statement;
            return {
              bind(...args: any[]) {
                const bound = statement.bind(...args);
                return {
                  async first() {
                    const result = await bound.first();
                    if (!changed) {
                      changed = true;
                      await receive(env, org, "email", {
                        external_id: id(),
                        person_id: s.pid,
                        body: "Late reply",
                        crmEligible: false,
                      });
                    }
                    return result;
                  },
                };
              },
            };
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  const transport = vi.fn(async () => Response.json({ id: "must-not-send" }));
  vi.stubGlobal("fetch", transport);
  await processJob(
    testEnv,
    await enqueue(env, org, "send", { person_id: s.pid, draft_id: s.did }),
  );
  expect(transport).not.toHaveBeenCalled();
});
it("persists draft approval and the send outbox together on transaction failure", async () => {
  const s = await sequence(),
    saved = env;
  env = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("Injected approval interruption");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  try {
    expect((await req(`/drafts/${s.did}/send`, "POST", {})).status).toBe(500);
  } finally {
    env = saved;
  }
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", s.did).first<Row>())!
      .status,
  ).toBe("pending");
  expect(
    await sql("SELECT id FROM jobs WHERE id=?", `draft:${s.did}`).first(),
  ).toBeNull();
});
it("cannot read or delete another workspace's R2 photo through custom lead data", async () => {
  const pid = await lead(),
    key = `foreign-workspace/photos/${id()}`;
  await env.MEDIA.put(key, "private foreign photo", {
    httpMetadata: { contentType: "image/png" },
  });
  await data(`/people/${pid}`, "PATCH", { custom: { photo_key: key } });
  const readStatus = (await req(`/people/${pid}/photo`)).status;
  await data(`/people/${pid}`, "DELETE");
  expect({
    readStatus,
    foreignPhotoExists: !!(await env.MEDIA.head(key)),
  }).toEqual({ readStatus: 404, foreignPhotoExists: true });
});
it("invalidates every previously issued password-reset token after a successful reset", async () => {
  const uid = id(),
    tokens = [id(), id()];
  await sql(
    "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,'Reset fixture','unused')",
    uid,
    `${uid}@audit.invalid`,
  ).run();
  for (const token of tokens)
    await sql(
      "INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at) VALUES(?,?,'reset',?,?)",
      id(),
      uid,
      await digest(token),
      new Date(Date.now() + 3600000).toISOString(),
    ).run();
  expect(
    (
      await req("/auth/reset-password", "POST", {
        token: tokens[0],
        password: "reset-password-fixture-one",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await req("/auth/reset-password", "POST", {
        token: tokens[1],
        password: "reset-password-fixture-two",
      })
    ).status,
  ).toBe(400);
});
it("retains a reset token if the password transaction fails", async () => {
  const uid = id(),
    token = id(),
    saved = env;
  await sql(
    "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,'Reset fixture','unused')",
    uid,
    `${uid}@audit.invalid`,
  ).run();
  await sql(
    "INSERT INTO auth_tokens(id,user_id,kind,token_hash,expires_at) VALUES(?,?,'reset',?,?)",
    id(),
    uid,
    await digest(token),
    new Date(Date.now() + 3600000).toISOString(),
  ).run();
  env = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("Injected password interruption");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  try {
    expect(
      (
        await req("/auth/reset-password", "POST", {
          token,
          password: "reset-password-fixture-one",
        })
      ).status,
    ).toBe(500);
  } finally {
    env = saved;
  }
  expect(
    (
      await req("/auth/reset-password", "POST", {
        token,
        password: "reset-password-fixture-one",
      })
    ).status,
  ).toBe(200);
});
it("rejects adopting a classification made before a newer reply", async () => {
  const pid = await lead();
  const cid = await setCategory(
    env,
    org,
    pid,
    "interested",
    null,
    "ai",
    "Uncertain",
    0.1,
  );
  await receive(env, org, "email", {
    external_id: id(),
    person_id: pid,
    body: "New context",
    crmEligible: false,
  });
  expect(
    (await req(`/crm/classifications/${cid}/apply`, "POST", {})).status,
  ).toBe(409);
  expect(
    (await sql("SELECT stage FROM people WHERE id=?", pid).first<Row>())!.stage,
  ).toBe("new");
});
it("rejects an old AI context at the atomic classification boundary", async () => {
  const pid = await lead();
  await receive(env, org, "email", {
    external_id: id(),
    person_id: pid,
    body: "New context",
    crmEligible: false,
  });
  expect(
    await setCategory(
      env,
      org,
      pid,
      "interested",
      null,
      "ai",
      "Stale result",
      0.9,
      null,
      0,
    ),
  ).toBeUndefined();
  expect(
    (await sql("SELECT stage FROM people WHERE id=?", pid).first<Row>())!.stage,
  ).toBe("new");
});
it("resumes a paused draft-generation job instead of permanently completing it", async () => {
  const s = await sequence();
  await sql("DELETE FROM drafts WHERE id=?", s.did).run();
  await sql(
    "UPDATE crm_enrollments SET status='paused' WHERE id=?",
    s.eid,
  ).run();
  const jid = await enqueue(env, org, "crm-sequence", { enrollment_id: s.eid });
  await processJob(env, jid);
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("queued");
  await sql(
    "UPDATE crm_enrollments SET status='active' WHERE id=?",
    s.eid,
  ).run();
  await sql("UPDATE jobs SET available_at=? WHERE id=?", now(), jid).run();
  await processJob(env, jid);
  expect(
    (await sql(
      "SELECT draft_id FROM crm_enrollments WHERE id=?",
      s.eid,
    ).first<Row>())!.draft_id,
  ).toBe(s.did);
});
it("commits a confirmed CRM send, receipt, progression and job completion together", async () => {
  const s = await sequence();
  await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
  const transport = vi.fn(async () => Response.json({ id: `receipt:${id()}` }));
  vi.stubGlobal("fetch", transport);
  const jid = await enqueue(env, org, "send", {
    person_id: s.pid,
    draft_id: s.did,
  });
  await Promise.all([processJob(env, jid), processJob(env, jid)]);
  const e = await sql(
    "SELECT * FROM crm_enrollments WHERE id=?",
    s.eid,
  ).first<Row>();
  expect(e!.step).toBe(1);
  expect(e!.draft_id).toBeNull();
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("done");
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", s.did).first<Row>())!
      .status,
  ).toBe("sent");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("reconciles a failed local receipt using its frozen content and without reviving a replied sequence", async () => {
  const s = await sequence(),
    external = `accepted:${id()}`;
  await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
  const transport = vi.fn(async () => Response.json({ id: external }));
  vi.stubGlobal("fetch", transport);
  let failed = false;
  const testEnv = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!failed && transport.mock.calls.length) {
              failed = true;
              throw new Error("Injected receipt interruption");
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as Env;
  const jid = await enqueue(env, org, "send", {
    person_id: s.pid,
    draft_id: s.did,
  });
  await processJob(testEnv, jid);
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe("uncertain");
  const attempt = await sql(
    "SELECT * FROM send_attempts WHERE job_id=?",
    jid,
  ).first<Row>();
  await receive(env, org, "email", {
    external_id: id(),
    person_id: s.pid,
    body: "Already replied",
    crmEligible: false,
  });
  await sql(
    "UPDATE drafts SET body='Changed after dispatch' WHERE id=?",
    s.did,
  ).run();
  await data(`/send-attempts/${attempt!.id}/reconcile`, "POST", {
    outcome: "sent",
    external_id: external,
  });
  expect(
    (await sql(
      "SELECT body FROM messages WHERE external_id=?",
      external,
    ).first<Row>())!.body,
  ).toBe("Fixture one");
  expect(
    (await sql(
      "SELECT status FROM crm_enrollments WHERE id=?",
      s.eid,
    ).first<Row>())!.status,
  ).toBe("stopped");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("allows only one concurrent reconciliation outcome to commit", async () => {
  const s = await sequence(),
    jid = id(),
    aid = id();
  await env.DB.batch([
    sql("UPDATE drafts SET status='queued' WHERE id=?", s.did),
    sql(
      "INSERT INTO jobs(id,org_id,kind,status,payload) VALUES(?,?,'send','uncertain',?)",
      jid,
      org,
      JSON.stringify({ person_id: s.pid, draft_id: s.did }),
    ),
    sql(
      "INSERT INTO send_attempts(id,org_id,job_id,person_id,status) VALUES(?,?,?,?,'uncertain')",
      aid,
      org,
      jid,
      s.pid,
    ),
  ]);
  const responses = await Promise.all([
    req(`/send-attempts/${aid}/reconcile`, "POST", {
      outcome: "sent",
      external_id: `verified:${id()}`,
    }),
    req(`/send-attempts/${aid}/reconcile`, "POST", { outcome: "not_sent" }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const a = await sql(
    "SELECT status FROM send_attempts WHERE id=?",
    aid,
  ).first<Row>();
  expect(
    (await sql("SELECT status FROM jobs WHERE id=?", jid).first<Row>())!.status,
  ).toBe(a!.status === "sent" ? "done" : "failed");
});
it("cannot undo old history over a newer classification with the same visible stage", async () => {
  const pid = await lead();
  const first = await setCategory(env, org, pid, "interested", null);
  await setCategory(env, org, pid, "interested", null);
  expect(
    (await req(`/crm/classifications/${first}/undo`, "POST", {})).status,
  ).toBe(409);
  expect(
    (await sql("SELECT stage FROM people WHERE id=?", pid).first<Row>())!.stage,
  ).toBe("interested");
});
it("blocks legacy queued follow-ups whose stopped sequence already lost its draft link", async () => {
  const s = await sequence();
  await sql(
    "UPDATE crm_enrollments SET status='stopped',draft_id=NULL WHERE id=?",
    s.eid,
  ).run();
  expect((await req(`/drafts/${s.did}/send`, "POST", {})).status).toBe(409);
  await sql("UPDATE drafts SET status='queued' WHERE id=?", s.did).run();
  const transport = vi.fn(async () => Response.json({ id: "must-not-send" }));
  vi.stubGlobal("fetch", transport);
  await processJob(
    env,
    await enqueue(env, org, "send", { person_id: s.pid, draft_id: s.did }),
  );
  expect(transport).not.toHaveBeenCalled();
  expect(
    (await sql("SELECT status FROM drafts WHERE id=?", s.did).first<Row>())!
      .status,
  ).toBe("discarded");
});

// Shared fixtures are private to this temporary D1/R2 instance. Every mutation
// below targets a real foreign row; a missing-row check alone is insufficient.
const tenantCases: [string, string, Row | undefined][] = [
  ["/people/foreign-person", "GET", undefined],
  ["/people/foreign-person", "PATCH", { name: "Attack" }],
  ["/people/foreign-person", "DELETE", undefined],
  ["/calls/foreign-call", "GET", undefined],
  ["/calls/foreign-call", "PATCH", { disposition: "do_not_call" }],
  ["/calling/contacts/foreign-contact", "GET", undefined],
  ["/calling/contacts/foreign-contact", "PATCH", { callStatus: "do_not_call" }],
  ["/tables/foreign-table", "GET", undefined],
  ["/tables/foreign-table/run", "POST", {}],
  ["/tables/foreign-table/stop", "POST", {}],
  ["/tables/foreign-table", "DELETE", undefined],
  ["/accounts/foreign-account", "PATCH", { name: "Attack" }],
  ["/provider-connections/foreign-provider", "DELETE", undefined],
  ["/crm/sequences/foreign-sequence", "DELETE", undefined],
  ["/teams/foreign-team", "PATCH", { name: "Attack" }],
  ["/folders/foreign-folder", "PATCH", { name: "Attack" }],
  ["/workbooks/foreign-workbook", "PATCH", { name: "Attack" }],
  ["/files/foreign-file", "GET", undefined],
  ["/files/foreign-file", "DELETE", undefined],
];
it("prepares a second workspace for access-control regression tests", async () => {
  await env.DB.batch([
    sql(
      "INSERT INTO organizations(id,name) VALUES('foreign-org','Foreign fixture')",
    ),
    sql(
      "INSERT INTO people(id,org_id,name,email) VALUES('foreign-person','foreign-org','Private fixture','private@foreign.invalid')",
    ),
    sql(
      "INSERT INTO enrichment_tables(id,org_id,name) VALUES('foreign-table','foreign-org','Private table')",
    ),
    sql(
      "INSERT INTO channel_accounts(id,org_id,channel,address) VALUES('foreign-account','foreign-org','email','foreign@foreign.invalid')",
    ),
    sql(
      "INSERT INTO provider_connections(id,org_id,provider,name,encrypted) VALUES('foreign-provider','foreign-org','hunter','Private','unused')",
    ),
    sql(
      "INSERT INTO crm_sequences(id,org_id,name) VALUES('foreign-sequence','foreign-org','Private')",
    ),
    sql(
      "INSERT INTO teams(id,org_id,name) VALUES('foreign-team','foreign-org','Private')",
    ),
    sql(
      "INSERT INTO folders(id,org_id,name) VALUES('foreign-folder','foreign-org','Private')",
    ),
    sql(
      "INSERT INTO workbooks(id,org_id,name) VALUES('foreign-workbook','foreign-org','Private')",
    ),
    sql(
      "INSERT INTO call_campaigns(id,org_id,name) VALUES('foreign-call-campaign','foreign-org','Private')",
    ),
    sql(
      "INSERT INTO call_contacts(id,org_id,campaign_id,person_id) VALUES('foreign-contact','foreign-org','foreign-call-campaign','foreign-person')",
    ),
    sql(
      "INSERT INTO calls(id,org_id,person_id,phone,recorder_token_hash,token_expires_at) VALUES('foreign-call','foreign-org','foreign-person','+12025550100','unused','2099-01-01T00:00:00Z')",
    ),
    sql(
      "INSERT INTO files(id,org_id,name,object_key,content_type,size) VALUES('foreign-file','foreign-org','Private','foreign-org/foreign-file','text/plain',7)",
    ),
  ]);
  await env.MEDIA.put("foreign-org/foreign-file", "private");
});
it.each(tenantCases)(
  "denies another workspace's %s %s",
  async (path, method, body) => {
    expect((await req(path, method, body)).status).toBe(404);
  },
);
