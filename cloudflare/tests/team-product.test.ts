import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { app } from "../src/api";
import { enqueue, processJob } from "../src/jobs";
import { id } from "../src/core";
import { importChat } from "../src/features/channels";
import type { Env, Row, Column } from "../src/types";

const origin = "https://product-team.invalid";
let mf: Miniflare, env: Env, cookie: string, org: string;
const sql = (s: string, ...args: any[]) => env.DB.prepare(s).bind(...args);
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  return app.request(
    origin + "/api" + path,
    {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie || "",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function data(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  const response = await request(path, method, body, token),
    result: Row = await response.json();
  if (!response.ok)
    throw new Error(`${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function table(columns: Column[], cells: Row) {
  const tid = (await data("/tables", "POST", { name: "Product regression" }))
    .id;
  await data(`/tables/${tid}`, "PATCH", { columns });
  await data(`/tables/${tid}/rows`, "POST", { rows: [cells] });
  return { tid, rid: (await data(`/tables/${tid}`)).rows[0].id as string };
}
async function run(tid: string, rid: string) {
  await processJob(
    env,
    await enqueue(env, org, "table-row", { table_id: tid, row_id: rid }),
  );
  return (await data(`/tables/${tid}`)).rows.find((r: Row) => r.id === rid);
}
async function call(): Promise<Row> {
  const pid = (
    await data("/people", "POST", {
      name: "Product call",
      email: `${id()}@example.invalid`,
      phone: "+12025550100",
    })
  ).id;
  const cid = (
    await data("/calling/campaigns", "POST", { name: "Product calls" })
  ).id;
  await data(`/calling/campaigns/${cid}/contacts`, "POST", { people: [pid] });
  const contact = (await data(`/calling/campaigns/${cid}`)).contacts[0];
  const result = await data("/calls", "POST", {
    personId: pid,
    campaignContactId: contact.id,
  });
  return { ...result, cid, contact, pid };
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
    ENCRYPTION_KEY: "product-fixture-key",
    UNSUBSCRIBE_SECRET: "product-fixture-unsubscribe",
    BOOTSTRAP_TOKEN: "product-fixture-setup",
    TASKS: { send: vi.fn(async () => {}) },
    AI_MODEL: "fixture",
    AI: { run: vi.fn(async () => ({ response: '{"summary":3}' })) },
  } as unknown as Env;
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await env.DB.exec(await readFile(new URL(name, dir), "utf8"));
  const response = await request("/auth/setup", "POST", {
    token: env.BOOTSTRAP_TOKEN,
    email: "owner@product.invalid",
    name: "Owner",
    organization: "Product team",
    password: "product-fixture-long-password",
  });
  expect(response.status).toBe(201);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
  org = (await data("/auth/status")).user.org_id;
}, 30000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await mf?.dispose();
});

it("splitting text invalidates cached formulas that consume the replaced output", async () => {
  const t = await table(
    [
      { key: "source", name: "Source", type: "text" },
      { key: "part", name: "Part", type: "text" },
      {
        key: "upper",
        name: "Upper",
        type: "formula",
        config: { expression: "String({{part}}).toUpperCase()" },
      },
    ],
    { source: "new,remainder", part: "old" },
  );
  expect((await run(t.tid, t.rid)).cells.upper).toBe("OLD");
  await data(`/tables/${t.tid}/split`, "POST", {
    key: "source",
    separator: ",",
    outputs: ["part"],
  });
  const row = await run(t.tid, t.rid);
  expect(row.cells.part).toBe("new");
  expect(row.cells.upper).toBe("NEW");
});

it("split validates the final 150 column limit before changing rows", async () => {
  const columns: Column[] = Array.from({ length: 149 }, (_, i) => ({
    key: `input${i}`,
    name: `Input ${i}`,
    type: "text",
  }));
  const t = await table(columns, { input0: "a,b,c" });
  const response = await request(`/tables/${t.tid}/split`, "POST", {
    key: "input0",
    separator: ",",
    outputs: ["part1", "part2", "part3"],
  });
  expect(response.status).toBe(400);
  expect((await data(`/tables/${t.tid}`)).columns).toHaveLength(149);
  expect((await data(`/tables/${t.tid}`)).rows[0].cells.part1).toBeUndefined();
});

it("skipped recalculations cannot feed a previous successful value into downstream formulas", async () => {
  const t = await table(
    [
      { key: "input", name: "Input", type: "number" },
      {
        key: "conditional",
        name: "Conditional",
        type: "formula",
        config: { expression: "{{input}} * 2", runCondition: "{{input}} > 0" },
      },
      {
        key: "downstream",
        name: "Downstream",
        type: "formula",
        config: { expression: "{{conditional}} * 2" },
      },
    ],
    { input: 1 },
  );
  expect((await run(t.tid, t.rid)).cells.downstream).toBe(4);
  await data(`/tables/${t.tid}/rows/${t.rid}`, "PATCH", {
    cells: { input: -1 },
  });
  const row = await run(t.tid, t.rid);
  expect(row.cell_meta.conditional.status).toBe("skipped");
  expect(row.cells.downstream).not.toBe(4);
  expect(row.cells.conditional ?? null).toBeNull();
});

it("rejects two generated columns that claim the same physical output key", async () => {
  const tid = (await data("/tables", "POST", { name: "Output collision" })).id;
  const response = await request(`/tables/${tid}`, "PATCH", {
    columns: [
      {
        key: "first",
        name: "First",
        type: "ai",
        config: {
          prompt: "First result",
          outputs: [{ key: "summary", type: "number" }],
        },
      },
      {
        key: "second",
        name: "Second",
        type: "ai",
        config: {
          prompt: "Second result",
          outputs: [{ key: "summary", type: "number" }],
        },
      },
    ],
  });
  expect(response.status).toBe(400);
});

it("reports invalid formula syntax as a correctable client error", async () => {
  const tid = (await data("/tables", "POST", { name: "Syntax" })).id;
  const response = await request(`/tables/${tid}`, "PATCH", {
    columns: [
      {
        key: "broken",
        name: "Broken",
        type: "formula",
        config: { expression: "(1 +" },
      },
    ],
  });
  expect(response.status).toBe(400);
});

it("recorder completion preserves a user's explicit call disposition and follow-up", async () => {
  const fixture = await call(),
    followUpAt = "2027-01-02T10:30:00.000Z";
  await data(`/calls/${fixture.call.id}`, "PATCH", {
    disposition: "interested",
    followUpAt,
  });
  await data(
    `/call-recorder/calls/${fixture.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    fixture.recorderToken,
  );
  const contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    fixture.contact.id,
  ).first<Row>();
  expect(contact!.call_status).toBe("connected");
  expect(contact!.stage).toBe("follow_up");
  expect(contact!.follow_up_at).toBe(followUpAt);
  expect(contact!.unanswered_attempts).toBe(0);
});

it("a failed recorder start does not leave its contact permanently calling", async () => {
  const fixture = await call();
  await data(`/calls/${fixture.call.id}/cancel`, "POST", {});
  const contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    fixture.contact.id,
  ).first<Row>();
  expect(contact!.call_status).not.toBe("calling");
  expect(contact!.stage).toBe("to_call");
  expect(contact!.unanswered_attempts).toBe(0);
});

it("saving an unanswered disposition after recorder completion counts that call only once", async () => {
  const fixture = await call();
  await data(
    `/call-recorder/calls/${fixture.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    fixture.recorderToken,
  );
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      fixture.contact.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(1);
  await data(`/calls/${fixture.call.id}`, "PATCH", {
    disposition: "no_answer",
  });
  await data(`/calls/${fixture.call.id}`, "PATCH", {
    disposition: "no_answer",
  });
  const contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    fixture.contact.id,
  ).first<Row>();
  expect(contact!.unanswered_attempts).toBe(1);
});

it("editing notes with an unchanged unanswered status preserves its existing attempt count", async () => {
  const fixture = await call();
  await data(
    `/call-recorder/calls/${fixture.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    fixture.recorderToken,
  );
  await data(`/calling/contacts/${fixture.contact.id}`, "PATCH", {
    callStatus: "no_answer",
    notes: "An ordinary notes edit",
  });
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      fixture.contact.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(1);
});

it("a legacy completed unanswered call without a new audit marker is not counted again", async () => {
  const fixture = await call();
  await data(
    `/call-recorder/calls/${fixture.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    fixture.recorderToken,
  );
  await sql(
    "DELETE FROM events WHERE id=?",
    `call-unanswered:${fixture.call.id}`,
  ).run();
  await data(`/calls/${fixture.call.id}`, "PATCH", {
    disposition: "no_answer",
  });
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      fixture.contact.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(1);
});

it("concurrent saves and the next separate call count unanswered calls once each", async () => {
  const fixture = await call();
  await Promise.all([
    data(`/calls/${fixture.call.id}`, "PATCH", { disposition: "no_answer" }),
    data(`/calls/${fixture.call.id}`, "PATCH", { disposition: "no_answer" }),
    data(
      `/call-recorder/calls/${fixture.call.id}/finish`,
      "POST",
      { outcome: "no_recording" },
      fixture.recorderToken,
    ),
  ]);
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      fixture.contact.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(1);
  const next = await data("/calls", "POST", {
    personId: fixture.pid,
    campaignContactId: fixture.contact.id,
  });
  await data(
    `/call-recorder/calls/${next.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    next.recorderToken,
  );
  expect(
    (await sql(
      "SELECT unanswered_attempts FROM call_contacts WHERE id=?",
      fixture.contact.id,
    ).first<Row>())!.unanswered_attempts,
  ).toBe(2);
});

it("cancelling or completing an older call cannot overwrite a newer active call", async () => {
  const old = await call();
  const newer = await data("/calls", "POST", {
    personId: old.pid,
    campaignContactId: old.contact.id,
  });
  await data(`/calls/${old.call.id}/cancel`, "POST", {});
  let contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    old.contact.id,
  ).first<Row>();
  expect(contact!.call_status).toBe("calling");
  await data(
    `/call-recorder/calls/${old.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    old.recorderToken,
  );
  contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    old.contact.id,
  ).first<Row>();
  expect(contact!.call_status).toBe("calling");
  expect(contact!.unanswered_attempts).toBe(0);
  await data(`/calls/${newer.call.id}/cancel`, "POST", {});
});

it("cancel preserves a subsequent explicit Do Not Call decision", async () => {
  const fixture = await call();
  await data(`/calling/contacts/${fixture.contact.id}`, "PATCH", {
    callStatus: "do_not_call",
  });
  await data(`/calls/${fixture.call.id}/cancel`, "POST", {});
  const contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    fixture.contact.id,
  ).first<Row>();
  expect(contact!.call_status).toBe("do_not_call");
  expect(contact!.stage).toBe("done");
});

it("a directly logged not-interested result remains final when recorder completion arrives later", async () => {
  const fixture = await call();
  await data(`/calling/contacts/${fixture.contact.id}`, "PATCH", {
    callStatus: "not_interested",
  });
  await data(
    `/call-recorder/calls/${fixture.call.id}/finish`,
    "POST",
    { outcome: "no_recording" },
    fixture.recorderToken,
  );
  const contact = await sql(
    "SELECT * FROM call_contacts WHERE id=?",
    fixture.contact.id,
  ).first<Row>();
  expect(contact!.stage).toBe("done");
  expect(contact!.call_status).toBe("connected");
  expect(contact!.unanswered_attempts).toBe(0);
});

it("rejects generated output collisions with raw inputs but accepts separate mapped outputs", async () => {
  const tid = (await data("/tables", "POST", { name: "Output ownership" })).id;
  const raw: Column = { key: "summary", name: "User input", type: "text" };
  const ai: Column = {
    key: "ai",
    name: "AI",
    type: "ai",
    config: {
      prompt: "Research",
      outputs: [{ key: "summary", type: "number" }],
    },
  };
  expect(
    (await request(`/tables/${tid}`, "PATCH", { columns: [raw, ai] })).status,
  ).toBe(400);
  expect(
    (
      await request(`/tables/${tid}`, "PATCH", {
        columns: [
          raw,
          {
            ...ai,
            config: {
              ...ai.config,
              outputColumns: { summary: "generated_summary" },
            },
          },
        ],
      })
    ).status,
  ).toBe(200);
  const t = await data(`/tables/${tid}`);
  expect(
    t.columns.find((c: Column) => c.key === "generated_summary").config
      .parentColumnKey,
  ).toBe("ai");
  expect(
    (await request(`/tables/${tid}`, "PATCH", { columns: t.columns })).status,
  ).toBe(200);
});

it("split revisions fence a late HTTP result and preserve the newly split input", async () => {
  const t = await table(
    [
      { key: "source", name: "Source", type: "text" },
      { key: "part", name: "Part", type: "text" },
      {
        key: "http",
        name: "HTTP",
        type: "http",
        config: { url: "https://example.com/fixture/{{part}}" },
      },
    ],
    { source: "new,remainder", part: "old" },
  );
  let release!: () => void, enter!: () => void;
  const started = new Promise<void>((r) => {
    enter = r;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      enter();
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json({ old: true });
    }),
  );
  const work = processJob(
    env,
    await enqueue(env, org, "table-row", { table_id: t.tid, row_id: t.rid }),
  );
  await started;
  await data(`/tables/${t.tid}/split`, "POST", {
    key: "source",
    separator: ",",
    outputs: ["part"],
  });
  release();
  await work;
  const row = (await data(`/tables/${t.tid}`)).rows[0];
  expect(row.cells.part).toBe("new");
  expect(row.cells.http).toBeUndefined();
  expect(row.status).toBe("ready");
});

async function channelFixture(channel = "linkedin") {
  const account: Row = {
    id: id(),
    org_id: org,
    channel,
    external_id: id(),
    settings: "{}",
  };
  await sql(
    "INSERT INTO channel_accounts(id,org_id,channel,external_id) VALUES(?,?,?,?)",
    account.id,
    org,
    channel,
    account.external_id,
  ).run();
  return account;
}

it("channel control: official incoming webhook remains inbound for the explicit peer", async () => {
  const account = await channelFixture(),
    provider = id();
  const pid = (
    await data("/people", "POST", {
      name: "Incoming peer",
      custom: { linkedin_provider_id: provider },
    })
  ).id;
  const mid = id();
  await importChat(env, org, account, {
    event: "message_received",
    chat_id: id(),
    message_id: mid,
    account_info: { user_id: "our-id" },
    sender: { attendee_provider_id: provider },
    message: "Peer's reply",
  });
  expect(
    await sql(
      "SELECT person_id,direction FROM messages WHERE org_id=? AND external_id=?",
      org,
      mid,
    ).first<Row>(),
  ).toMatchObject({ person_id: pid, direction: "inbound" });
});

it("channel control: first self-sent webhook resolves a sole recipient without making a self contact", async () => {
  const account = await channelFixture(),
    provider = id(),
    self = id(),
    mid = id();
  await importChat(env, org, account, {
    event: "message_received",
    chat_id: id(),
    message_id: mid,
    account_info: { user_id: self },
    sender: { attendee_provider_id: self },
    attendees: [
      { attendee_provider_id: self },
      { attendee_provider_id: provider, attendee_name: "New recipient" },
    ],
    message: "Our phone message",
  });
  const message = await sql(
    "SELECT m.direction,p.custom,p.crm_context FROM messages m JOIN people p ON p.id=m.person_id WHERE m.org_id=? AND m.external_id=?",
    org,
    mid,
  ).first<Row>();
  expect(message!.direction).toBe("outbound");
  expect(JSON.parse(message!.custom).linkedin_provider_id).toBe(provider);
  expect(message!.crm_context).toBe(0);
});

it("channel control: a WhatsApp device-qualified sender matches the phone owner", async () => {
  const account = await channelFixture("whatsapp"),
    mid = id();
  const pid = (
    await data("/people", "POST", {
      name: "WhatsApp peer",
      phone: "+12025550191",
    })
  ).id;
  await importChat(env, org, account, {
    event: "message_received",
    chat_id: id(),
    message_id: mid,
    account_info: { user_id: "12025550192@s.whatsapp.net" },
    sender: { attendee_provider_id: "12025550191:3@s.whatsapp.net" },
    message: "WhatsApp reply",
  });
  expect(
    await sql(
      "SELECT person_id,direction FROM messages WHERE org_id=? AND external_id=?",
      org,
      mid,
    ).first<Row>(),
  ).toMatchObject({ person_id: pid, direction: "inbound" });
});

it("a known chat cannot attribute another explicit group sender's message to its cached contact", async () => {
  const account = await channelFixture(),
    first = id(),
    second = id(),
    chat = id(),
    mid = id();
  const firstId = (
    await data("/people", "POST", {
      name: "Group first",
      custom: { linkedin_provider_id: first },
    })
  ).id;
  const secondId = (
    await data("/people", "POST", {
      name: "Group second",
      custom: { linkedin_provider_id: second },
    })
  ).id;
  await sql(
    "INSERT INTO chats(id,org_id,account_id,external_id,person_id) VALUES(?,?,?,?,?)",
    id(),
    org,
    account.id,
    chat,
    firstId,
  ).run();
  await importChat(env, org, account, {
    event: "message_received",
    chat_id: chat,
    message_id: mid,
    account_info: { user_id: "our-id" },
    sender: { attendee_provider_id: second },
    attendees: [
      { attendee_provider_id: first },
      { attendee_provider_id: second },
    ],
    message: "Second member's reply",
  });
  const message = await sql(
    "SELECT person_id FROM messages WHERE org_id=? AND external_id=?",
    org,
    mid,
  ).first<Row>();
  expect(message?.person_id).not.toBe(firstId);
  if (message) expect(message.person_id).toBe(secondId);
});
